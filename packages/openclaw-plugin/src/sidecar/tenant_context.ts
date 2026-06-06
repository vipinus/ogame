/**
 * Sprint 1 (v0.0.860) — Per-tenant context registry.
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
 * `${uid}::${fid}`. Sprint 1 of the architectural cleanup migrates the
 * 3 worst offenders to real per-uid Maps held inside this TenantContext
 * registry. Same lazy-mint shape as SaveCoordinatorManager.
 *
 * Scope (Sprint 1 — pilot)
 * ------------------------
 * - expLastSeen          : Map<fleetId, { origin, dest, arrival_at, return_at }>
 * - firedDebrisCheckFor  : Map<fleetId, Set<"B" | "C">>
 * - directiveToGoal      : Map<directiveId, goalId>
 *
 * Intentionally NOT migrated this sprint (Sprint 2 PR):
 *   userStates, userLastSeen, goalByKey, subPauseCache, directiveToParams,
 *   goalFailureCount, lastRefreshEmitAt, directiveToDiscoverCoord,
 *   perUidWriteTimer, perUidPendingSnap, optimizer state.
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
 */

/** Per-fleet observation snapshot used by debris-check (Signal B). */
export interface ExpLastSeenEntry {
  readonly origin: readonly number[];
  readonly dest: readonly number[];
  readonly arrival_at: number | null;
  readonly return_at: number | null;
}

/** All per-tenant state owned by the registry. Each bucket is private to
 *  a single uid; the legacy/no-uid caller maps to EMPTY_LEGACY_UID. */
export interface TenantContext {
  /** mission=15 fleet id → last observed origin/dest/arrival/return.
   *  Debris-check Signal B scans this map on each snapshot push. */
  readonly expLastSeen: Map<string, ExpLastSeenEntry>;
  /** mission=15 fleet id → dedup set so each (signal, fleetId) fires at
   *  most once. v0.0.677 split into per-signal sets to avoid B/C cross-
   *  blocking each other. */
  readonly firedDebrisCheckFor: Map<string, Set<"B" | "C">>;
  /** directive id → goal id. Source of truth for ack→goal mapping.
   *  Trimmed when the success/failure ack arrives. */
  readonly directiveToGoal: Map<string, string>;
}

/** Legacy / no-uid caller bucket. Operator single-tenant path lands here
 *  when ALS hasn't resolved a Bearer to a PG user (e.g. operator's own
 *  userscript without OGAMEX_BRIDGE_TOKEN). Backwards-compat with the
 *  pre-v0.0.857 unprefixed persisted entries. */
export const EMPTY_LEGACY_UID = "";

function newContext(): TenantContext {
  return {
    expLastSeen: new Map<string, ExpLastSeenEntry>(),
    firedDebrisCheckFor: new Map<string, Set<"B" | "C">>(),
    directiveToGoal: new Map<string, string>(),
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
  firedDebrisCheckFor: Array<[string, Array<"B" | "C">]>;
}

/** Hydrate the registry from a parsed exp_state.json blob. Accepts both
 *  pre-v0.0.857 (bare fid) and v0.0.857+ (`${uid}::${fid}`) keys; bare
 *  keys route to the EMPTY_LEGACY_UID bucket. Unknown / malformed fields
 *  are skipped silently — caller logs the totals. */
export function hydrate(
  registry: TenantRegistry,
  parsed: {
    expLastSeen?: Array<[string, ExpLastSeenEntry]>;
    firedDebrisCheckFor?: Array<[string, Array<"B" | "C">]>;
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
  const firedDebrisCheckFor: Array<[string, Array<"B" | "C">]> = [];
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
