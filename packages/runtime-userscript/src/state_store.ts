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
