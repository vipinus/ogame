import type { WorldState } from "@ogamex/shared";
import type { EventBus } from "./event_bus.js";
import type { IndexedKv } from "./store/indexed_db.js";

export function emptyWorldState(): WorldState {
  return {
    server: { universe: "", speed: 1 },
    player: { id: "", name: "", alliance: null },
    planets: {},
    research: { levels: {}, queue: null },
    fleets_outbound: [],
    events_incoming: [],
    artifacts: { artifacts: {} },
    discovery_slots: { used: 0, max: 0 },
    discovery_active: [],
    last_update: 0,
    page_snapshots: {},
  };
}

const STATE_KEY = "world_state";

export class StateStore {
  private _state: WorldState;
  constructor(
    private readonly bus: EventBus,
    private readonly kv: IndexedKv | null = null,
    initial?: WorldState,
  ) {
    this._state = initial ?? emptyWorldState();
  }

  get state(): WorldState {
    return this._state;
  }

  getSnapshot(): WorldState {
    // Return a structured clone to prevent accidental external mutation
    return structuredClone(this._state);
  }

  /**
   * Apply a shallow patch to the state, update last_update, and emit "state.updated".
   * Nested objects are replaced, not merged — caller should pass full sub-objects when needed.
   */
  setPartial(patch: Partial<WorldState>): void {
    this._state = {
      ...this._state,
      ...patch,
      last_update: Date.now(),
    };
    this.bus.emit("state.updated", { ts: this._state.last_update });
  }

  /**
   * Race-safe per-planet patch (operator 2026-05-27: "不稳定" — async snapshots
   * of store.state.planets get overwritten by stale writes from other code
   * paths that captured the snapshot earlier).
   *
   * For each `pid -> partial planet patch`, spreads the **live** planet at
   * write time and overlays the patch fields. Any concurrent write to OTHER
   * fields (e.g. jumpgate_cooldown_sec written by commitCooldown while a
   * pollEmpire fetch was in-flight) survives.
   *
   * Use this INSTEAD of `setPartial({planets: {...cur.planets, [pid]: ...}})`
   * — that pattern races whenever the caller snapped cur before an await.
   */
  setPlanetsPatch(byId: Record<string, Partial<WorldState["planets"][string]>>): void {
    const live = this._state.planets;
    const out: WorldState["planets"] = { ...live };
    for (const [pid, patch] of Object.entries(byId)) {
      const liveBase = live[pid];
      if (!liveBase) {
        // No live entry yet — caller's patch must be a full planet record.
        out[pid] = patch as WorldState["planets"][string];
      } else {
        out[pid] = { ...liveBase, ...patch } as WorldState["planets"][string];
      }
    }
    this._state = { ...this._state, planets: out, last_update: Date.now() };
    this.bus.emit("state.updated", { ts: this._state.last_update });
  }

  /** Replace the entire state (e.g., on hydrate). */
  replace(state: WorldState): void {
    this._state = state;
    this.bus.emit("state.updated", { ts: state.last_update });
  }

  /** Persist current state to IndexedDB (no-op if kv was null). */
  async persist(): Promise<void> {
    if (!this.kv) return;
    await this.kv.put(STATE_KEY, this._state);
  }

  /** Load state from IndexedDB. If absent or kv was null, keeps the current empty state. */
  async hydrate(): Promise<void> {
    if (!this.kv) return;
    const loaded = await this.kv.get<WorldState>(STATE_KEY);
    if (loaded) {
      // Migration v0.0.134 → 0.0.135: planets schema Array → Record. Old
      // persisted state has planets as Array; convert to Record keyed by id.
      if (Array.isArray((loaded as unknown as { planets?: unknown }).planets)) {
        const arr = (loaded as unknown as { planets: Array<{ id: string }> }).planets;
        const rec: Record<string, unknown> = {};
        for (const p of arr) {
          if (p && typeof p === "object" && typeof p.id === "string") rec[p.id] = p;
        }
        (loaded as unknown as { planets: unknown }).planets = rec;
      }
      this._state = loaded;
      this.bus.emit("state.updated", { ts: this._state.last_update, hydrated: true });
    }
  }
}
