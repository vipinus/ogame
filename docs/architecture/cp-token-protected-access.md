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

## 4. Current Audit (2026-06-01, updated after Phase 3)

| File:Line | Path | Standard? | Notes |
|---|---|---|---|
| `fleet_api.ts:136` | inside `cpPostWithRetry` | ✅ wrapper | this IS the standard |
| `fleet_api.ts:267` | inside `sendFleet` | ✅ wrapper | this IS the standard |
| `api_executor.ts:545` | expedition legacy 3-stage POST helper | ❌ BYPASS | handrolled retry, multi-stage token chain |
| `api_executor.ts:635` | expedition legacy sendFleet final | ❌ BYPASS | same context as 545 |
| ~~`api_executor.ts:725`~~ | ~~jumpgate overlay token GET~~ | ✅ MIGRATED v0.0.558 | now `cpPostWithRetry({method:"GET"})` |
| ~~`api_executor.ts:774`~~ | ~~jumpgate executeJump POST~~ | ✅ MIGRATED v0.0.558 | now `cpPostWithRetry({tokenProvider,refreshTokenOnInvalid,successCheck})` |
| ~~`api_executor.ts:994`~~ | ~~discover/galaxy fetch~~ | ✅ MIGRATED v0.0.559 | now `cpPostWithRetry({successCheck:j=>!!j.system, tokenProvider:""})` |
| ~~`api_executor.ts:1177`~~ | ~~discover POST~~ | ✅ MIGRATED v0.0.559 | now `cpPostWithRetry({tokenProvider, maxAttempts:1})`; business retry kept |
| ~~`api_executor.ts:1256/1302`~~ | ~~discover token-refresh retry~~ | ✅ MIGRATED v0.0.559 | inline retries also via `cpPostWithRetry` maxAttempts=1 |
| `boot.ts:854/866/884` | sniffer init triple-fetch | ❌ BYPASS | boot-time, low frequency, cp=any planet |
| `boot.ts:1028/1597` | sandbox CASE B overlay re-fetch | ❌ BYPASS | rare |
| `boot.ts:1856` | fetchResources periodic poll | ⚠️ safe | cp=operatorCp, no shift |
| `boot.ts:2003` | refreshOnePage chunk fetch | ⚠️ safe | cp=operatorCp, no shift |
| `boot.ts:2697` | fetchShips inline shipsOnPlanet | ❌ BYPASS | cp=any planet, may shift |

**No raw `&cp=`/`?cp=` in src/** — the prebuild gate
`scripts/check-no-raw-cp.sh` blocks all direct string-concat. Every BYPASS
row above still goes through `safe_fetch.ts` (so the mutex + restore still
fire), but it skips `cpPostWithRetry`'s retry/token-refresh standard.

## 5. Migration Plan

The 16 grandfathered sites split into 2 buckets (operator A 2026-06-01
拍板 "all → 0", refined after honest scope re-read):

### Bucket 1: INFRASTRUCTURE (8 sites — permanent allow)

These are userscript-internal data fetches (NOT directive dispatchers).
They use `fetchWithCp[BypassBusy]` directly because:
- One-shot at boot OR periodic poll
- cp = operator's current planet (no actual session shift)
- Read-only data harvesting (no token rotation required)
- cpPostWithRetry's POST-retry / TOKEN_INVALID semantics don't apply

Sites:
- `boot.ts:854/866/884` — cargo-probe boot 3-stage (token harvested from
  responses, used immediately, no cross-flow lifetime)
- `boot.ts:1028/1597` — sandbox CASE B overlay re-fetch (rare, internal)
- `boot.ts:1856` — fetchResources periodic poll (cp=operator)
- `boot.ts:2003` — refreshOnePage chunk fetch (cp=operator)
- `boot.ts:2697` — fetchShips inline GET (single read, no retry needed)

Decision: **stay grandfathered** in `ALLOW_LIST_INFRA`. cp= protection
still active via `safe_fetch.ts` (mutex + restore + click-lock). Reviewed.

### Bucket 2: DIRECTIVE-DISPATCH (8 sites — TODO migrate)

`api_executor.ts` multi-stage flows that DO dispatch directives. Each
has custom token handling that requires `cpPostWithRetry` extension OR
careful per-stage refactoring.

| File:Line | Flow | Migration complexity |
|---|---|---|
| `api_executor.ts:545` | expedition legacy 3-stage POST helper | HIGH — token chain across 3 calls, each stage's newAjaxToken feeds next |
| `api_executor.ts:635` | expedition legacy sendFleet final | HIGH — same context as 545 |
| `api_executor.ts:725` | jumpgate overlay token GET | LOW — single GET, parse HTML for token |
| `api_executor.ts:774` | jumpgate executeJump POST | MEDIUM — handrolled 4-attempt retry duplicates cpPostWithRetry; token comes from overlay, not TokenManager |
| `api_executor.ts:1018` | discover/galaxy fetch | LOW — single POST, no retry, response has no success field |
| `api_executor.ts:1201` | discover sendDiscoveryFleet POST | MEDIUM — uses galaxy-specific token cache (`__ogamexLastGalaxyToken`) |
| `api_executor.ts:1280/1326` | discover token-refresh retry | MEDIUM — refetches galaxy when token stale |

### Required cpPostWithRetry extensions (proposed)

1. **Custom token provider**: today `cpPostWithRetry` reads token only via
   `opts.token: TokenManager`. For JG / discover flows that have their
   own token source (overlay HTML, galaxy cache), need `opts.tokenProvider:
   () => Promise<string>` to override.
2. **Custom success-check**: today okFlag = `success===true ||
   status==="success"`. Galaxy response has no such field; needs caller
   to specify `opts.successCheck: (json) => boolean`.
3. **Token-refresh hook**: on TOKEN_INVALID, today `cpPostWithRetry`
   calls `opts.token.invalidate()`. Galaxy/JG need a different refetch
   path (re-GET overlay, re-fetch galaxy). Hook: `opts.refreshTokenOnInvalid:
   () => Promise<string>`.

Once these extensions land, migration is mechanical per row. Each row
gets its own commit.

### Migration phases (proposed)

- **Phase 1 DONE (v0.0.557)**: extended `cpPostWithRetry` with the 3 hooks
  (`tokenProvider`, `successCheck`, `refreshTokenOnInvalid`).
- **Phase 2 DONE (v0.0.558)**: migrated jumpgate. Overlay GET → `cpPostWithRetry({
  method:"GET", skipRestore:true})`; executeJump POST → `cpPostWithRetry({
  tokenProvider, refreshTokenOnInvalid:fetchOverlayToken, successCheck:strict
  ghost-ack defense, buildBody, skipRestore:true})`. Inline 4-attempt loop +
  local TRANSIENT_RACE_RE / TOKEN_INVALID_RE removed (now centralized).
- **Phase 3 DONE (v0.0.559)**: migrated discover/galaxy chain.
  - galaxy fetchGalaxyContent → `cpPostWithRetry({tokenProvider:async()=>"",
    successCheck:j=>!!j["system"], maxAttempts:1})`. No `success` field; gates
    on `system` field presence.
  - sendDiscoveryFleet → `cpPostWithRetry({tokenProvider:async()=>cachedToken,
    buildBody, successCheck:()=>true, maxAttempts:1})`. successCheck always
    true → business retry logic (cooldown / token-race / 資源不足) lives in
    caller; cpPost only standardizes cp= protection, not the 3-branch retry.
  - 2 inline retries (token-race, 資源不足) also use cpPostWithRetry maxAttempts=1
    with retry token from `parsed.newAjaxToken`.
- **Phase 4 next**: migrate expedition 3-stage (545/635) — most complex token
  chain, validate token-flow semantics carefully.

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
