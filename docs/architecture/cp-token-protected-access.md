# cp= / Token Protected Access — Unified Entry

> Owner: ddxs · 2026-06-01 · operator directive: "directive 的 cp= 用统一入口的保护方法"

## 1. The Problem

Every fetch to ogame with `cp=<planetId>` in the URL **immediately shifts the
ogame server-side session-cp**. The top-bar planet display jumps to the cp=
target until the next page-refresh OR until we explicitly restore.

User-visible symptom: "auto-switch planet" — operator is viewing Colony A,
sidecar dispatches a directive on Moon B, ogame UI jumps to Moon B for a
fraction of a second (or stays if `skipRestore:true`), then bounces back.

Each fetch can also rotate ogame's anti-CSRF `newAjaxToken`. If two cp=
fetches race, ogame may invalidate one or both tokens → next dispatch hits
140043 "cannot dispatch fleet".

## 2. The Unified Entry

**Every cp= fetch MUST go through `src/api/safe_fetch.ts`.** Three exported
functions:

```
fetchWithCp(baseUrl, init, sourcePID, opts?)       // generic; cp= URL inject
fetchWithCpBypassBusy(baseUrl, init, sourcePID, opts?)  // same + bypassBusy
restoreSessionCp(targetCp)                         // manual restore helper
```

Why these are the standard:

- **Mutex (`acquireCpSlot`)** — module-level `cpFetchChain` serializes ALL
  cp= fetches. Two concurrent cp= POSTs can never race ogame's session-cp.
- **Operator-cp capture** — reads `meta[name="ogame-planet-id"]` BEFORE the
  fetch, so the restore knows where to go back to.
- **Auto-restore** — `try { fetch } finally { if (!skipRestore && operatorCp
  !== sourceStr) restoreSessionCp(operatorCp) }`. Operator's view always
  returns to where they were.
- **Click-lock integration** — registers as in-flight, click_intercept
  delays operator clicks during the cp= window so ogame UI clicks can't
  race the cp= switch.

For POST-with-retry semantics (token chain + transient race + 401), use the
**higher-level wrappers in `src/api/fleet_api.ts`**:

```
sendFleet(p, ctx)                                  // fleet POST (mission 3/4/7/15)
cpPostWithRetry(opts)                              // any other cp= POST
```

These wrap `fetchWithCpBypassBusy` AND add:
- 4-attempt retry with TRANSIENT_RACE_RE / TOKEN_INVALID_RE detection
- newAjaxToken capture → TokenManager.set
- Loud per-attempt logging
- Module-level `sendFleetChain` mutex (for sendFleet specifically)

## 3. The Rule

```
directive's cp= ⇒ NEVER directly call fetchWithCp[BypassBusy]
                  ALWAYS go through sendFleet / cpPostWithRetry
```

The first-time architecture sweep already moved most dispatchers to
`cpPostWithRetry` (build / research / build_ships / etc go through
`execSimpleUpgrade` → `cpPostWithRetry`). The remaining direct callers
are listed below and slated for migration.

## 4. Current Audit (2026-06-01)

| File:Line | Path | Standard? | Notes |
|---|---|---|---|
| `fleet_api.ts:136` | inside `cpPostWithRetry` | ✅ wrapper | this IS the standard |
| `fleet_api.ts:267` | inside `sendFleet` | ✅ wrapper | this IS the standard |
| `api_executor.ts:545` | expedition legacy 3-stage POST helper | ❌ BYPASS | handrolled retry, multi-stage token chain |
| `api_executor.ts:635` | expedition legacy sendFleet final | ❌ BYPASS | same context as 545 |
| `api_executor.ts:725` | jumpgate overlay token GET | ❌ BYPASS | could use cpPostWithRetry GET mode |
| `api_executor.ts:774` | jumpgate executeJump POST | ❌ BYPASS | handrolled 4-attempt retry duplicates cpPostWithRetry |
| `api_executor.ts:1018` | discover/galaxy fetch | ❌ BYPASS | galaxy token chain (separate from TokenManager — legacy) |
| `api_executor.ts:1201` | discover POST | ❌ BYPASS | same |
| `api_executor.ts:1280/1326` | discover token-refresh retry | ❌ BYPASS | same |
| `boot.ts:854/866/884` | sniffer init triple-fetch | ❌ BYPASS | boot-time, low frequency, cp=any planet |
| `boot.ts:1028/1597` | sandbox CASE B overlay re-fetch | ❌ BYPASS | rare |
| `boot.ts:1856` | fetchResources periodic poll | ⚠️ safe | cp=operatorCp, no shift |
| `boot.ts:2003` | refreshOnePage chunk fetch | ⚠️ safe | cp=operatorCp, no shift |
| `boot.ts:2697` | fetchShips inline shipsOnPlanet | ❌ BYPASS | cp=any planet, may shift |

**No raw `&cp=`/`?cp=` in src/** — the prebuild gate
`scripts/check-no-raw-cp.sh` blocks all direct string-concat. Every BYPASS
row above still goes through `safe_fetch.ts` (so the mutex + restore still
fire), but it skips `cpPostWithRetry`'s retry/token-refresh standard.

## 5. Migration Plan (separate sprint)

Each BYPASS row needs:
1. Replace the inline `fetchWithCpBypassBusy(...)` with `cpPostWithRetry({
   endpoint, sourcePlanetId, token, action, method, buildBody })`
2. Delete the handrolled retry / token-rotation block
3. Trust `cpPostWithRetry` for: TOKEN_INVALID refresh, TRANSIENT_RACE
   backoff, 4-attempt retry, newAjaxToken capture

Special cases:
- **Multi-stage flows** (expedition legacy 3-stage at line 541-685):
  `cpPostWithRetry` supports per-call `buildBody`; each stage = one call.
  Token chains naturally because each call's `newAjaxToken` updates the
  shared `TokenManager`.
- **Discover/galaxy** (1018+): has its own token cache
  (`__ogamexLastGalaxyToken`, `dataset.ogamexToken`) intentionally — galaxy
  POST tokens have different lifetime than fleet tokens. Migration here
  needs a parallel `cpPostWithRetry` variant or a TokenManager-galaxy
  shim.
- **boot.ts:854/866/884** sniffer init: one-shot at boot, low risk; could
  stay or migrate for consistency.

## 6. Enforcement

`scripts/check-no-raw-cp.sh` (prebuild) catches **raw `&cp=`/`?cp=` literals**
in `src/`. Bypass detection (direct `fetchWithCpBypassBusy(...)` outside
`fleet_api.ts`) is NOT YET in the gate — a future enforcement script:

```bash
# proposed scripts/check-no-direct-cp-fetch.sh
grep -rnE "fetchWithCp(BypassBusy)?\\(" src/ \
  --include='*.ts' \
  | grep -v 'src/api/safe_fetch.ts' \
  | grep -v 'src/api/fleet_api.ts' \
  > /tmp/direct-cp.txt
# fail if any new entry not in ALLOW_LIST
```

## 7. What Operator Should See After Full Migration

- Top-bar planet jumps reduced to: 1 jump per `cpPostWithRetry` call, then
  jump back after restore. Same as today's safe paths.
- Token rotation consolidated in TokenManager (no more parallel galaxy
  token cache, unless deliberately retained).
- Transient 140043 / 100001 handled uniformly; no more bespoke
  per-action retry loops with different backoff curves.

## 8. Related

- Memory: `feedback_cp_unified_entry.md` — operator policy reminder.
- Memory: `feedback_cp_shift_visible.md` — original cp= visibility issue.
- Memory: `reference_safe_fetch_arch.md` — original architecture.
- Prebuild gate: `scripts/check-no-raw-cp.sh`.
