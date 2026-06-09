/**
 * Sprint 1 (v0.0.860) + Sprint 2 (v0.0.861) + Sprint 3 (v0.0.862) — Per-tenant context registry.
 *
 * Background
 * ----------
 * The sidecar was written single-tenant (operator only) and grew multi-tenant
 * via Phase 9c.* retrofits. Some per-tenant state landed in proper Managers
 * (SaveCoordinatorManager / FailureAggregatorManager / ReporterManager in
 * multitenant_managers.ts) — but many other per-tenant Maps were left as
 * module-level globals keyed by id (fleet id, directive id). Those ids are
 * NOT guaranteed unique across tenants, causing cross-tenant overwrite /
 * delete bugs (v0.0.856, v0.0.857 for expLastSeen / firedDebrisCheckFor).
 *
 * v0.0.857 patched the symptom by prefixing the GLOBAL Map keys with
 * `${uid}::${fid}`. Sprint 1 of the architectural cleanup migrated the
 * 3 worst offenders to real per-uid Maps. Sprint 2 extends to the
 * remaining directive-id / goal-id keyed Maps + the per-uid WorldState
 * mirror that the rest of the sidecar reads.
 *
 * Scope (Sprint 1)
 * ----------------
 * - expLastSeen          : Map<fleetId, { origin, dest, arrival_at, return_at }>
 * - firedDebrisCheckFor  : Map<fleetId, Set<"A" | "B" | "C">>
 * - directiveToGoal      : Map<directiveId, goalId>
 *
 * Scope (Sprint 2)
 * ----------------
 * - worldState           : WorldState | null              (was userStates[uid])
 * - lastSeenAt           : number | null                  (was userLastSeen[uid])
 * - subPauseCache        : { paused, ts } | null          (was subPauseCache[uid])
 * - directiveToParams    : Map<directiveId, { action?, building?, planet_id? }>
 * - goalFailureCount     : Map<goalId, number>
 * - lastRefreshEmitAt    : Map<goalId, number>
 * - directiveToDiscoverCoord : Map<directiveId, coordStr>
 * - worldStatePersist    : { timer: NodeJS.Timeout | null; pending: WorldState | null }
 *                          (was perUidWriteTimer / perUidPendingSnap)
 *
 * Scope (Sprint 3)
 * ----------------
 * Owner directive 2026-06-06 — "全部用 per-uid，统一架构 避免以后再来回补丁".
 * Migrate the last 2 surviving module-level Maps in src/sidecar/* into the
 * registry, then land a CI gate (check-no-module-level-map.sh) with an empty
 * ALLOW_LIST so future regressions fail prebuild.
 * - fieldsFullCache              : Map<`${planetId}:${building}`, { until: number }>
 *                                  (was module-level in planner.ts WITHOUT uid prefix —
 *                                  real cross-tenant bug; 24h TTL durable suppression)
 * - expeditionFailureCoolOff     : Map<planetId, number>
 *                                  (was module-level in expedition.ts keyed by
 *                                  `${uid}::${planetId}` — v0.0.857 prefix anti-pattern
 *                                  symptom-fix; now properly per-uid via registry)
 *
 * Intentionally NOT migrated:
 *   - goalByKey (function-local Map in updateBuildShipsProgress; already
 *     scoped to a single uid via reader.listActiveByUser(uid))
 *   - optimizer / save coordinator / failure aggregator / reporter manager
 *     (already correctly per-tenant via dedicated Manager classes)
 *   - cpFetchChain (token mutex; intentionally per-tab not per-uid)
 *
 * Backward compat (persistence)
 * -----------------------------
 * The existing exp_state.json file already contains a mix of:
 *   - legacy unprefixed keys (pre-v0.0.857)
 *   - v0.0.857 `${uid}::${fid}` prefixed keys
 * hydrate() accepts both: split prefixed keys into the right TenantContext,
 * route bare keys to the EMPTY_LEGACY_UID bucket (which is where the
 * single-tenant operator without a Bearer continues to operate).
 * serialize() re-emits prefixed keys for non-legacy buckets and bare keys
 * for the legacy bucket, so downgrading to v0.0.857 doesn't lose state.
 *
 * None of the Sprint 2 additions require persistence — they rebuild from
 * WS state.snapshot + PG on restart, so no disk-schema changes.
 */

import type { WorldState } from "@ogamex/shared";

/** Per-fleet observation snapshot used by debris-check (Signal B). */
export interface ExpLastSeenEntry {
  readonly origin: readonly number[];
  readonly dest: readonly number[];
  readonly arrival_at: number | null;
  readonly return_at: number | null;
}

/** Directive params snapshot — needed when the ack lands so we can
 *  retro-mark fields_full on the exact (planet, building) the dispatch
 *  hit, and to verify `action` matches goal.type before mark-completed. */
export interface DirectiveParams {
  action?: string;
  building?: string;
  planet_id?: string;
}

/** subscriptionPause cache value — paused flag + 60s freshness ts.
 *  Per-uid because subscription status is itself per-uid. */
export interface SubPauseCacheEntry {
  paused: boolean;
  ts: number;
}

/** WorldState persist coalescer state. v0.0.858 introduced per-uid
 *  debounce so a state.snapshot push from user A during the 1s window
 *  can't overwrite user B's pending snap. v0.0.861 just relocates the
 *  Map<uid,…> pair into TenantContext for consistency — algorithm
 *  unchanged. */
export interface WorldStatePersistSlot {
  timer: NodeJS.Timeout | null;
  pending: WorldState | null;
}

/** All per-tenant state owned by the registry. Each bucket is private to
 *  a single uid; the legacy/no-uid caller maps to EMPTY_LEGACY_UID. */
export interface TenantContext {
  // --- Sprint 1 (v0.0.860) ---
  /** mission=15 fleet id → last observed origin/dest/arrival/return.
   *  Debris-check Signal B scans this map on each snapshot push. */
  readonly expLastSeen: Map<string, ExpLastSeenEntry>;
  /** mission=15 fleet id → dedup set so each (signal, fleetId) fires at
   *  most once. v0.0.677 split into per-signal sets to avoid B/C cross-
   *  blocking each other. */
  readonly firedDebrisCheckFor: Map<string, Set<"A" | "B" | "C">>;
  /** v0.0.881 — owner directive D 2026-06-07: track cumulative seen expedition
   *  fleet IDs per origin coord. fast turnaround (fleet落地+立即起飞) 时,
   *  Signal A/B 看不到 outbound 消失, 但 seenFleets.size > current count → 一
   *  定有 fleet 回来了. coord 字符串 "G:S:P" 作 key. 不持久, sidecar restart
   *  后重新统计 (current outbound 即基线, 不会 spurious fire). */
  readonly expSeenFleetIdsByOrigin: Map<string, Set<string>>;
  /** v0.0.881 — coord → 已 fire 过 aggregate debris-check 的 returned 数量.
   *  当前 returned = seenIds.size - currentOutboundCount; 若大于此值, fire 一次,
   *  update 为当前. wire.ts 6min dedup 兜底 fire-storm. */
  readonly expReturnedCountByOrigin: Map<string, number>;
  /** directive id → goal id. Source of truth for ack→goal mapping.
   *  Trimmed when the success/failure ack arrives. */
  readonly directiveToGoal: Map<string, string>;

  // --- Sprint 2 (v0.0.861) ---
  /** Per-user WorldState mirror — populated by state.snapshot handler,
   *  consumed by triggerDispatch / stateProvider / expeditionProvider /
   *  emergencyProvider / saveCoord factories / optimizer / expedition
   *  tick. Was `userStates: Map<uid, WorldState>` global. */
  worldState: WorldState | null;
  /** Per-user last state.snapshot push timestamp (ms). Surfaced via
   *  /v1/health multi-tenant snapshot for staleness diagnosis. Was
   *  `userLastSeen: Map<uid, number>` global. */
  lastSeenAt: number | null;
  /** subscription gate cache — { paused, ts }. 60s freshness. Was
   *  `subPauseCache: Map<uid, …>` global; key was already uid so this
   *  is a 1:1 lift. */
  subPauseCache: SubPauseCacheEntry | null;
  /** directive id → action/building/planet_id snapshot at dispatch.
   *  v0.0.764 added so 120012 fields_full hard-block can call
   *  markFieldsFull on the exact (planet, building) the failed POST
   *  targeted. v0.0.782 added `action` so the ack handler verifies it
   *  matches goal.type before mark-completed. Was global Map keyed by
   *  directive id (NOT uid-prefixed) → cross-tenant overwrite hazard. */
  readonly directiveToParams: Map<string, DirectiveParams>;
  /** goal id → consecutive failure count for exponential backoff
   *  (v0.0.834). Was global Map keyed by goal id; opt-* goal ids are
   *  uid-suffixed but plain `buil-…` prefixes are not, so the global
   *  shape was cross-tenant-leaky. */
  readonly goalFailureCount: Map<string, number>;
  /** goal id → last data.refresh emit ts (v0.0.842 60s throttle). Was
   *  global Map keyed by goal id; same uid-uniqueness caveat as
   *  goalFailureCount. */
  readonly lastRefreshEmitAt: Map<string, number>;
  /** directive id → discovered coord string (species_discovery). Used
   *  by the ack handler to revert the optimistic completed[] add when
   *  ApiExec reports slot_full. Was global Map keyed by directive id. */
  readonly directiveToDiscoverCoord: Map<string, string>;
  /** WorldState persist debounce slot. v0.0.858 added per-uid timer +
   *  pending snap to keep cross-tenant snapshot pushes from corrupting
   *  each other's PG row. v0.0.861 relocates here unchanged. */
  readonly worldStatePersist: WorldStatePersistSlot;

  // --- Sprint 3 (v0.0.862) ---
  /** planet-id × building → fields-full until-timestamp.
   *  v0.0.862 — was module-level Map keyed by `${planetId}:${building}`
   *  WITHOUT uid. Real cross-tenant bug — 24h TTL durable suppression.
   *  See docs/architecture/multi-tenant.md §1. */
  readonly fieldsFullCache: Map<string, { until: number }>;
  /** planet-id → last expedition failure cool-off timestamp.
   *  v0.0.862 — was module-level Map with `${uid}::${planetId}` prefix
   *  trick (v0.0.857 anti-pattern). Now properly per-uid via registry. */
  readonly expeditionFailureCoolOff: Map<string, number>;
  /** v0.0.928 — owner 2026-06-07 "任务又被自动删掉了". priority_merger:741
   *  marks goal completed on first sighting of ALREADY_AT_TARGET_RE
   *  planner-blocked reason. Transient sniffer/snapshot glitches (planet
   *  level momentarily reports too high) silently erase real goals.
   *  goalId → first-sighting timestamp; require 30s of continuous
   *  "already at" reports before actually completing. Cleared when goal
   *  transitions away from already-at reason (or on status change). */
  readonly alreadyAtTargetSince: Map<string, number>;
  /** v0.0.921 → v0.0.922 — fleet ack post-verify queue (JG + deploy +
   *  transport). goal_id → before-snapshot of src/tgt body ships +
   *  dispatched ships count. Populated when onStatusChange marks fleet
   *  goal completed; periodic verifier diff's against live worldState
   *  to detect ogame silent rejection. On mismatch reverts goal to
   *  blocked + clears prematurely-written cd (JG only). */
  readonly pendingFleetVerify: Map<string, FleetVerifyEntry>;
  /** v0.0.1008 — owner 2026-06-09 "为啥又在造机器人工厂": state.snapshot lag
   *  let planner cascade re-dispatch same (planet, building) within seconds
   *  (e.g. robo L7 dispatched 13:23:01, then 13:24:05 dispatched again because
   *  state still showed empty build_q). key = `${planetId}:${building}` →
   *  last dispatch ts. planner gate: if within 60s, treat as build_q busy. */
  readonly recentBuildDispatchAt: Map<string, number>;
}

export type FleetVerifyEntry = {
  goalId: string;
  goalType: "jumpgate" | "deploy" | "transport";
  srcBodyId: string;
  /** target body id may be absent if dispatch target is resolved by
   *  coord only. JG: always present. Deploy/transport: present when
   *  the target coord maps to a known body in worldState. */
  tgtBodyId: string | null;
  srcShipsBefore: Record<string, number>;
  tgtShipsBefore: Record<string, number>;
  dispatchedShips: Record<string, number>;
  ackTs: number;
  deadline: number;
};

/** Legacy / no-uid caller bucket. Operator single-tenant path lands here
 *  when ALS hasn't resolved a Bearer to a PG user (e.g. operator's own
 *  userscript without OGAMEX_BRIDGE_TOKEN). Backwards-compat with the
 *  pre-v0.0.857 unprefixed persisted entries. */
export const EMPTY_LEGACY_UID = "";

function newContext(): TenantContext {
  return {
    // Sprint 1
    expLastSeen: new Map<string, ExpLastSeenEntry>(),
    firedDebrisCheckFor: new Map<string, Set<"A" | "B" | "C">>(),
    directiveToGoal: new Map<string, string>(),
    // Sprint 2
    worldState: null,
    lastSeenAt: null,
    subPauseCache: null,
    directiveToParams: new Map<string, DirectiveParams>(),
    goalFailureCount: new Map<string, number>(),
    lastRefreshEmitAt: new Map<string, number>(),
    directiveToDiscoverCoord: new Map<string, string>(),
    worldStatePersist: { timer: null, pending: null },
    // Sprint 3
    fieldsFullCache: new Map<string, { until: number }>(),
    expeditionFailureCoolOff: new Map<string, number>(),
    pendingFleetVerify: new Map<string, FleetVerifyEntry>(),
    alreadyAtTargetSince: new Map<string, number>(),
    recentBuildDispatchAt: new Map<string, number>(),
    // v0.0.881 — owner directive D
    expSeenFleetIdsByOrigin: new Map<string, Set<string>>(),
    expReturnedCountByOrigin: new Map<string, number>(),
  };
}

export class TenantRegistry {
  private readonly map = new Map<string, TenantContext>();

  /** Lazy-mint a context for this uid. Empty string = legacy bucket. */
  get(uid: string | undefined | null): TenantContext {
    const key = uid ?? EMPTY_LEGACY_UID;
    let ctx = this.map.get(key);
    if (!ctx) {
      ctx = newContext();
      this.map.set(key, ctx);
    }
    return ctx;
  }

  /** Iterate all live tenant contexts. */
  *entries(): IterableIterator<[string, TenantContext]> {
    yield* this.map.entries();
  }

  size(): number { return this.map.size; }

  /** Number of tenants that have received at least one state.snapshot
   *  push (worldState !== null). Used by multi-tenant health probe;
   *  replaces the old `userStates.size` scalar (which counted minted
   *  contexts the same way). */
  trackedWorldStateCount(): number {
    let n = 0;
    for (const ctx of this.map.values()) if (ctx.worldState !== null) n += 1;
    return n;
  }

  /** Min of lastSeenAt across all tenants, or null if none have ever
   *  pushed. Replaces `Math.min(...Array.from(userLastSeen.values()))`. */
  oldestLastSeenAt(): number | null {
    let oldest: number | null = null;
    for (const ctx of this.map.values()) {
      const t = ctx.lastSeenAt;
      if (t === null) continue;
      if (oldest === null || t < oldest) oldest = t;
    }
    return oldest;
  }

  /** Drain every per-uid pending worldStatePersist slot, returning the
   *  (uid, snap) pairs the caller should flush. Clears timers + slot
   *  state. Used at shutdown by flushWorldStatePersist. */
  drainWorldStatePersist(): Array<[string, WorldState]> {
    const drains: Array<[string, WorldState]> = [];
    for (const [uid, ctx] of this.map.entries()) {
      if (ctx.worldStatePersist.timer) {
        clearTimeout(ctx.worldStatePersist.timer);
        ctx.worldStatePersist.timer = null;
      }
      const pending = ctx.worldStatePersist.pending;
      ctx.worldStatePersist.pending = null;
      if (pending) drains.push([uid, pending]);
    }
    return drains;
  }
}

// ============================================================================
// Persistence — backward-compatible with the v0.0.857 schema
// ============================================================================

/** Serialized exp_state.json shape. Same field names as v0.0.818-857 so
 *  the on-disk format is unchanged. */
export interface SerializedExpState {
  /** Flat array of [storageKey, entry]. storageKey is `${uid}::${fid}` for
   *  non-legacy uids, bare `${fid}` for the legacy bucket. */
  expLastSeen: Array<[string, ExpLastSeenEntry]>;
  /** Flat array of [storageKey, Array<signal>]. Same key convention. */
  firedDebrisCheckFor: Array<[string, Array<"A" | "B" | "C">]>;
}

/** Hydrate the registry from a parsed exp_state.json blob. Accepts both
 *  pre-v0.0.857 (bare fid) and v0.0.857+ (`${uid}::${fid}`) keys; bare
 *  keys route to the EMPTY_LEGACY_UID bucket. Unknown / malformed fields
 *  are skipped silently — caller logs the totals. */
export function hydrate(
  registry: TenantRegistry,
  parsed: {
    expLastSeen?: Array<[string, ExpLastSeenEntry]>;
    firedDebrisCheckFor?: Array<[string, Array<"A" | "B" | "C">]>;
  } | null | undefined,
): { expLastSeen: number; firedDebrisCheckFor: number } {
  let exp = 0;
  let fired = 0;
  if (parsed && Array.isArray(parsed.expLastSeen)) {
    for (const [k, v] of parsed.expLastSeen) {
      if (typeof k !== "string" || !v) continue;
      const { uid, fid } = splitStorageKey(k);
      registry.get(uid).expLastSeen.set(fid, v);
      exp += 1;
    }
  }
  if (parsed && Array.isArray(parsed.firedDebrisCheckFor)) {
    for (const [k, arr] of parsed.firedDebrisCheckFor) {
      if (typeof k !== "string" || !Array.isArray(arr)) continue;
      const { uid, fid } = splitStorageKey(k);
      registry.get(uid).firedDebrisCheckFor.set(fid, new Set(arr));
      fired += 1;
    }
  }
  return { expLastSeen: exp, firedDebrisCheckFor: fired };
}

/** Emit a SerializedExpState for the on-disk persist file. Legacy bucket
 *  emits bare keys; non-legacy buckets emit `${uid}::${fid}` keys so a
 *  downgrade to v0.0.857 still routes correctly. */
export function serialize(registry: TenantRegistry): SerializedExpState {
  const expLastSeen: Array<[string, ExpLastSeenEntry]> = [];
  const firedDebrisCheckFor: Array<[string, Array<"A" | "B" | "C">]> = [];
  for (const [uid, ctx] of registry.entries()) {
    const prefix = uid === EMPTY_LEGACY_UID ? "" : `${uid}::`;
    for (const [fid, entry] of ctx.expLastSeen.entries()) {
      expLastSeen.push([`${prefix}${fid}`, entry]);
    }
    for (const [fid, set] of ctx.firedDebrisCheckFor.entries()) {
      firedDebrisCheckFor.push([`${prefix}${fid}`, Array.from(set)]);
    }
  }
  return { expLastSeen, firedDebrisCheckFor };
}

/** Split a v0.0.857 storage key into (uid, fid). Bare keys (no `::`)
 *  route to EMPTY_LEGACY_UID. */
function splitStorageKey(key: string): { uid: string; fid: string } {
  const sep = key.indexOf("::");
  if (sep < 0) return { uid: EMPTY_LEGACY_UID, fid: key };
  return { uid: key.slice(0, sep), fid: key.slice(sep + 2) };
}

// ============================================================================
// Singleton instance (Sprint 3, v0.0.862)
// ============================================================================
//
// Sprint 1/2 instantiated TenantRegistry inside setupSidecar() and passed it
// into dependent closures. Sprint 3 migrates two more module-level Maps
// (planner.ts:fieldsFullCache, expedition.ts:failureCoolOff) into the
// registry. Those modules are pure-function modules without a setupSidecar
// closure to capture — so we expose a process-singleton here that they can
// import directly. index.ts continues to use the same singleton instead of
// minting its own, so there's still exactly one registry per process.
//
// Owner directive 2026-06-06 — "全部用 per-uid，统一架构 避免以后再来回补丁".
// Don't add new module-level Maps to bypass this — scripts/check-no-module-
// level-map.sh blocks regressions at prebuild.
export const tenantRegistry: TenantRegistry = new TenantRegistry();
