# Multi-Tenant Sidecar Architecture

> Owner: ddxs · 2026-06-06 (sidecar v0.0.864) · cleanup sprints landing across v0.0.860 (Sprint 1), v0.0.861 (Sprint 2), v0.0.86X (Sprint 3 CI gate)

How sidecar state is partitioned per tenant, why module-level `Map<id, X>`
globals are an anti-pattern, and the recipe for adding new per-tenant state.

## 1. Problem statement

The sidecar (`packages/openclaw-plugin/src/sidecar/`) was written
single-tenant — one operator, one Bearer-less local push. Multi-tenant
support landed via Phase 9c.* retrofits: a Bearer token on each push
routes through `runWithUser(uid, …)`, setting an `AsyncLocalStorage`
frame so deep callees can resolve "whose state is this?".

The partial retrofit left a tail of module-level `Map<string, X>`
declarations keyed by **id** (fleet id, directive id, goal id), not by
`uid`. Those ids are NOT globally unique across tenants — two operators
can have a directive id of `123` simultaneously. Result: a write under
one uid silently overwrites or deletes the other's entry.

The incident trail driving this cleanup:

| Commit  | Version  | Symptom                                             |
| ------- | -------- | --------------------------------------------------- |
| `2cc6d52` | v0.0.856 | `expLastSeen.delete(fid)` cross-tenant — debris-check silently never fired for the colliding fleet id |
| `f0cd293` | v0.0.857 | Patched `expLastSeen` + `firedDebrisCheckFor` by prefixing keys with `${uid}::${fid}` (symptom-fix, not architectural fix) |
| `fc4b946` | v0.0.858 | `stateRef.current` debounced PG write captured a foreign tenant's snapshot after a setTimeout — wrong universe overwrote Ceti's row with Icarus data |
| `cdf0157` | v0.0.850 | Emergency-event handler fell through to operator uid when caller's uid was undefined — Discord webhook leaked across tenants |
| `1fc51ca` | v0.0.860 | **Sprint 1**: real `TenantRegistry`, migrated 3 worst offenders away from `${uid}::${fid}` prefix trick |

Each of those was diagnosed and patched in isolation. The architectural
cleanup formalizes the contract so future contributors don't recreate
the same shape.

## 2. The rule

**Every piece of per-tenant state MUST live inside `TenantContext`,
accessed via `tenantRegistry.get(uid).<field>`.** No new
`new Map<string, X>()` at module scope in handler files unless the key
is provably globally unique across tenants AND the line carries an
explicit `// @cross-tenant-safe` comment explaining why.

Examples of legitimate module-level Maps (cross-tenant-safe, do not
migrate):

- `cpFetchChain` — token mutex; **per-tab** semantics, not per-uid. The
  sidecar never sees more than one cp-fetcher per process.
- Manager-internal Maps inside `SaveCoordinatorManager` /
  `FailureAggregatorManager` / `ReporterManager` — the Manager class
  itself is the per-uid container; its private fields are correctly
  scoped.
- Type-registry maps (`registry: Map<UpstreamMsg["type"], Set<Handler>>`)
  — keyed by message type, lifetime = process. Never holds per-tenant
  data.

Everything else: use `TenantContext`.

## 3. Decision tree

```
Adding new state to the sidecar?
  │
  ├─ Is the key always unique across tenants (UUID4, message-type string)?
  │    yes → module-level Map is fine, add a `// @cross-tenant-safe` comment
  │    no  → continue ↓
  │
  ├─ Does the state describe a per-user resource (fleet, goal, planet,
  │  directive, world snapshot, subscription cache, ack timer, etc.)?
  │    yes → MUST use TenantContext
  │    no  → continue ↓
  │
  ├─ Is the state a per-tab / per-socket concern (token mutex, ws conn
  │  pool) with at-most-one instance per sidecar process?
  │    yes → module-level is fine
  │    no  → default to TenantContext (safer to over-scope than under-scope)
```

## 4. TenantContext API reference

Source: `packages/openclaw-plugin/src/sidecar/tenant_context.ts`.

```typescript
interface TenantContext {
  // Sprint 1 (v0.0.860)
  readonly expLastSeen:         Map<string, ExpLastSeenEntry>;
  readonly firedDebrisCheckFor: Map<string, Set<"B" | "C">>;
  readonly directiveToGoal:     Map<string, string>;

  // Sprint 2 (v0.0.861)
  worldState:                   WorldState | null;
  lastSeenAt:                   number | null;
  subPauseCache:                SubPauseCacheEntry | null;
  readonly directiveToParams:        Map<string, DirectiveParams>;
  readonly goalFailureCount:         Map<string, number>;
  readonly lastRefreshEmitAt:        Map<string, number>;
  readonly directiveToDiscoverCoord: Map<string, string>;
  readonly worldStatePersist:        WorldStatePersistSlot;
}
```

`TenantRegistry.get(uid)` — **lazy-mint**. First access for a uid
allocates an empty `TenantContext`; subsequent accesses return the
same instance. The caller never needs to check existence.

```typescript
const ctx = tenantRegistry.get(uid);
ctx.directiveToGoal.set(directiveId, goalId);
```

`EMPTY_LEGACY_UID = ""` — the single-tenant fallback bucket. Any
callsite without an ALS uid (operator's own userscript without a
Bearer; boot-time hydrate; some timer ticks) routes here. Persistence
emits **bare keys** for this bucket so a downgrade to v0.0.857 still
loads correctly.

Persistence hooks:

```typescript
hydrate(registry, parsedJson)
  // accepts both `${uid}::${fid}` (v0.0.857+) and bare `${fid}` (legacy)
  // keys; routes the latter to EMPTY_LEGACY_UID.

serialize(registry): SerializedExpState
  // emits prefixed keys for non-legacy uids, bare keys for the legacy bucket.
  // Schema is the v0.0.818-857 shape — on-disk format unchanged.
```

## 5. Migration recipe

When you need new per-tenant state:

1. **Add the field** to `interface TenantContext` in `tenant_context.ts`.
   Use `readonly` for collections (Map / Set); plain `let`-style fields
   for nullable scalars that get reassigned.
2. **Initialize** an empty value in `newContext()` so lazy-mint produces
   a fully-populated context (no `undefined` field hazards).
3. **Read / write** via `tenantRegistry.get(uid).<field>` at the
   callsite. Never close over the registry's internal `map` directly.
4. **Wrap handler entry points** with `runWithUser(uid, …)` so the ALS
   frame is populated before any nested callee tries to resolve the uid.
   In practice the four entrypoints are
   `ws_server.onMessage` (`ws_server.ts:359`),
   `http_server.dispatchPush` (`http_server.ts:1520`),
   `http_server.handleGoalCreate` (`http_server.ts:809`), and
   `http_server.routeAuthed` (`http_server.ts:694`).
5. **If persisted**, extend `SerializedExpState` and update
   `hydrate()` / `serialize()`. Keep prefix-vs-bare-key convention for
   backward compat.

## 6. ALS uid threading gotchas

`AsyncLocalStorage` (Node `async_hooks`) propagates through `await`,
`.then(…)`, `setTimeout` / `setImmediate` / `setInterval`,
`queueMicrotask`, and Promise chains. It does **NOT** propagate
through `EventEmitter` listeners (the `.emit` call inherits the
caller's ALS, not the registration site's), worker threads, or
some native re-entry paths.

**Concrete failure mode (v0.0.858)**: ALS is preserved across
`setTimeout`, so `getCurrentUserId()` inside the callback returns the
right uid. BUT if the callback reads module-level mutable state
(`stateRef.current`), another tenant's snapshot may have already
swapped it by the time the timer fires — wrong universe written to
the correct uid's PG row. Always capture the snapshot at **schedule
time**, not fire time. The Sprint 2 `worldStatePersist` slot in
`TenantContext` is exactly this pattern, per-uid.

## 7. Anti-patterns

The Sprint 3 CI gate (`scripts/check-no-tenant-globals.sh`, separate
PR) flags the three patterns below.

### Bad — module-level `Map` keyed by per-tenant id

```typescript
// BAD — colliding ids across tenants stomp each other
const goalState = new Map<string, GoalRecord>();
function onAck(ack: Ack) { goalState.set(ack.goalId, derive(ack)); }

// GOOD
function onAck(ack: Ack) {
  const uid = getCurrentUserId() ?? EMPTY_LEGACY_UID;
  tenantRegistry.get(uid).goalState.set(ack.goalId, derive(ack));
}
```

### Bad — debounced write capturing module-level mutable

```typescript
// BAD — stateRef.current can be swapped under the timer
setTimeout(() => writeToPg(stateRef.current), 1000);

// GOOD — snap + uid captured at schedule time, ALS re-entered on fire
const snap = ctx.worldState;
const uidAtSchedule = uid;
ctx.worldStatePersist.timer = setTimeout(
  () => runWithUser(uidAtSchedule, () => writeToPg(snap)), 1000);
```

### Bad — delete on skip-path (v0.0.856 fleet-id collision)

```typescript
// BAD — also fires on skip-origin → wipes a real entry under same fid
const r = fireFor(fid);
expLastSeen.delete(fid);

// GOOD — only delete on confirmed-fired
if (fireFor(fid) === "fired") {
  tenantRegistry.get(uid).expLastSeen.delete(fid);
}
```

## 8. Continuous verification

The Sprint 4 runtime verifier
(`packages/openclaw-plugin/scripts/verify-tenant-isolation.mjs`,
documented in §7 "Sprint 4") is wired into a **user-level systemd
timer** on europa so cross-tenant regressions surface without operator
intervention. Sprint 5 (`v0.0.864-ci`, this commit) added the wiring.

### Cadence

- **Service**: `ogamex-verify-tenant.service` — oneshot, runs the script
  with `--quiet` so PASS lines stay out of the journal; FAIL lines and
  the final summary always print.
- **Timer**: `ogamex-verify-tenant.timer` — first fire `OnBootSec=5min`,
  then `OnUnitActiveSec=30min`. `Persistent=true` so a missed fire
  during downtime catches up on next boot.
- Exit-code semantics: `0` pass, `1` at least one FAIL, `2` ssh target
  unreachable (sanity gate; treated as success by `SuccessExitStatus=2`
  so cron noise is suppressed during europa reboot windows).

### Installation (one-time, per host)

```
scp packages/openclaw-plugin/scripts/verify-tenant-isolation.mjs \
    ddxs@europa:~/.openclaw/workspace/ogamex/scripts/
scp packages/openclaw-plugin/scripts/systemd/ogamex-verify-tenant.{service,timer} \
    ddxs@europa:~/.config/systemd/user/
ssh ddxs@europa "systemctl --user daemon-reload && \
                 systemctl --user enable --now ogamex-verify-tenant.timer"
```

Verify the timer is scheduled:

```
ssh ddxs@europa "systemctl --user list-timers | grep verify-tenant"
```

### Manual invocation

From the repo root:

```
npm run verify-tenant --workspace=@ogamex/openclaw-plugin
```

Or directly: `node packages/openclaw-plugin/scripts/verify-tenant-isolation.mjs`.

### Optional Discord FAIL alerts

Drop a single line into
`~/.openclaw/workspace/ogamex/verify-tenant.env` (file is optional —
the unit's `EnvironmentFile=-…` prefix tolerates absence):

```
VERIFY_DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/…
```

On any FAIL, the script POSTs a one-line summary
(`🚨 ogamex tenant-isolation FAIL — N/M checks passed at <iso>. Failed: <names>.`)
to that webhook. Fire-and-forget — webhook errors do NOT mask the script's
exit code; failures are logged to stderr.

### Overriding tenant uids / names

Same EnvironmentFile pattern. All defaults match the operator's
europa setup, but any can be overridden:

- `VERIFY_ICARUS_UID`, `VERIFY_ICARUS_NAME`
- `VERIFY_CETI_UID`, `VERIFY_CETI_NAME`
- `SSH_TARGET` (default `ddxs@localhost` when running from the service
  unit on europa; `ddxs@europa` when running from a dev workstation)

### Logs

```
journalctl --user -u ogamex-verify-tenant.service --no-pager | tail -20
```

Healthy line:

```
ogamex-verify-tenant[…]: tenant-isolation: 5/5 checks passed
```

Run once on demand:

```
systemctl --user start ogamex-verify-tenant.service
```

## 9. Glossary

- **ALS** — `AsyncLocalStorage`, Node's `async_hooks`-based per-request
  context store. Propagates through await chains and timers.
- **uid** — Postgres `user_id` (UUID4) for an authenticated multi-tenant
  caller. Resolved from `user_settings.bridge_token` keyed on the
  Bearer header.
- **ctxUid** — the uid currently held in ALS (`getCurrentUserId()`).
  May be `undefined` outside an `runWithUser` frame.
- **EMPTY_LEGACY_UID** — the empty-string sentinel for the
  single-tenant fallback bucket (operator without Bearer, boot
  hydrate, etc.). Persisted as bare keys for v0.0.857 downgrade
  compatibility.
- **cross-tenant** — describes any state that may be observed or
  mutated by code running under more than one uid in the same
  sidecar process. Module-level Maps keyed by non-uid ids are
  cross-tenant by default — that is the failure mode this guide
  prevents.
- **TenantContext** — the per-uid record in `tenant_context.ts`.
- **TenantRegistry** — the `Map<uid, TenantContext>` container with
  lazy-mint, iteration, and persistence helpers.

## 10. Links

- Sprint 1 (v0.0.860): `1fc51ca` — TenantContext registry + 3-Map pilot
  migration.
- Sprint 2 (v0.0.861, in flight at time of writing): extends to
  `worldState`, `lastSeenAt`, `subPauseCache`,
  `directive*`/`goalFailureCount`/`lastRefreshEmitAt` + `worldStatePersist`.
- Sprint 3 (v0.0.86X, follow-up): CI gate
  `check-no-tenant-globals.sh` mirroring the style of
  `check-no-raw-cp.sh` / `check-no-direct-cp-fetch.sh` under
  `packages/runtime-userscript/scripts/`.
- Sprint 4 (v0.0.864 docs): **this file** + runtime verifier
  `packages/openclaw-plugin/scripts/verify-tenant-isolation.mjs`.
- Sprint 5 (v0.0.864-ci): CI-friendly verifier (env-configurable
  uids, `--quiet`, ssh sanity gate, optional Discord webhook),
  `npm run verify-tenant`, and the europa user-systemd timer pair
  (`packages/openclaw-plugin/scripts/systemd/ogamex-verify-tenant.{service,timer}`).
  See §8.
- Operator memory note: `feedback_cross_tenant_globals.md` in
  `~/.claude/projects/-home-ddxs-Sync-Works-ogamex/memory/` (not
  checked into git; private to operator's Claude memory).
- Related architectural rules: `cp-token-protected-access.md` (cp= URL
  unified entry) and `conflict-prevention.md` (frontend deferral).
