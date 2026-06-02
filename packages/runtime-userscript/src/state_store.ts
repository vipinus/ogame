import type { WorldState } from "@ogamex/shared";
import { OGAME_DATA_TECHNOLOGY_REVERSE } from "@ogamex/shared";
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
      // Migration v0.0.614: purge legacy `id_<num>` raw keys from
      // lifeform_research / lifeform_buildings / buildings / research. v0.0.607
      // extractor wrote them as a fallback before LIFEFORM_RESEARCH_IDS landed;
      // v0.0.609 dropped the fallback but persisted entries lingered, causing
      // duplicate rows in the goal panel ("id_14203 L3 + 心灵网络 L3").
      // Resolve each `id_<num>` to its canonical name. If canonical already
      // exists, drop the raw (take max level); otherwise rename.
      let purged = 0;
      const purgeMap = (m: Record<string, number> | undefined): Record<string, number> | undefined => {
        if (!m) return m;
        let dirty = false;
        const next: Record<string, number> = {};
        for (const [k, v] of Object.entries(m)) {
          if (k.startsWith("id_")) {
            const nid = k.slice(3);
            const canon = OGAME_DATA_TECHNOLOGY_REVERSE[nid];
            if (canon) {
              const existing = next[canon] ?? m[canon] ?? -1;
              next[canon] = Math.max(existing, v);
              dirty = true;
              purged++;
              continue;
            }
          }
          if (!(k in next)) next[k] = v;
        }
        return dirty ? next : m;
      };
      const planets = (loaded as unknown as { planets?: Record<string, Record<string, unknown>> }).planets ?? {};
      for (const pid of Object.keys(planets)) {
        const p = planets[pid] as Record<string, Record<string, number> | undefined>;
        const lfr = purgeMap(p.lifeform_research);
        const lfb = purgeMap(p.lifeform_buildings);
        const blds = purgeMap(p.buildings);
        if (lfr !== p.lifeform_research && lfr) p.lifeform_research = lfr;
        if (lfb !== p.lifeform_buildings && lfb) p.lifeform_buildings = lfb;
        if (blds !== p.buildings && blds) p.buildings = blds;
      }
      const research = (loaded as unknown as { research?: { levels?: Record<string, number> } }).research;
      if (research?.levels) {
        const next = purgeMap(research.levels);
        if (next && next !== research.levels) research.levels = next;
      }
      if (purged > 0) {
        console.info(`[OgameX/migrate] purged ${purged} legacy id_<num> keys from persisted state`);
      }
      this._state = loaded;
      this.bus.emit("state.updated", { ts: this._state.last_update, hydrated: true });
      // Persist immediately so the migration survives the next reload without
      // waiting for another setPartial to trigger save.
      if (purged > 0) {
        try { await this.persist(); } catch (e) { console.warn("[OgameX/migrate] persist after purge failed", e); }
      }
    }
  }
}
