# Frontend Conflict Prevention

How userscript background dispatch coexists with operator's manual ogame UI
without breaking each other.

**Last updated:** 2026-05-28 (userscript v0.0.394)

## Problem

ogame v12 keeps **per-tab state** that multiple actors share:

| Shared state | Lifetime | Mutated by |
|---|---|---|
| `session-cp` (current planet) | session | every `&cp=PID` fetch |
| Global ajax token | rotates per POST | every ajax POST to `/game/index.php` |
| Fleet-selection state (`am20X` map) | per fleetdispatch page load | `fleetSelectionAjax` + `checkTarget` |

The userscript fires background ogame ajax (discovery sweep, expedition
dispatch, recall, cargo probe, jumpgate hydrate, eventbox harvest, etc).
The operator simultaneously clicks ogame UI. Without coordination, four
classes of failure show up:

1. **session-cp jump** — background fetch with `&cp=otherPlanet` flips
   ogame's top-bar planet selector while operator's mouse is mid-click.
2. **Token race** — both clients POST, one rotates the global token, the
   other's next POST gets `{"success":false}` with no error info
   (a 244-byte body). Visible to operator as `null.baseFuelCapacity`
   crashing the ogame fleetdispatch JS.
3. **Fleet selection clobber** — cargo-probe's `fleetSelectionAjax am202=1`
   overwrites ogame's server-side fleet selection while operator's UI
   reads it back, producing inconsistent ship counts in the dispatch form.
4. **Anti-bot throttle** — bursty POSTs from the same IP within a few
   seconds raise ogame's `"伺服器無回應"` rate-limit response.

## Solution Stack (current)

Four layers, top-to-bottom. Each layer handles a class of conflict the
layer below doesn't.

### Layer 1 — Page-aware defer (GoalRunner)

**File:** `packages/runtime-userscript/src/goal_runner.ts:138`
**Introduced:** v0.0.392

GoalRunner's `run()` checks `window.location.search.includes("component=
fleetdispatch")`. While operator is on fleetdispatch page, ALL incoming
directives go into `deferredQueue` (not `execQueue`). `schedulePollIdle`
wakes every 5s to recheck the page; on navigation away, drains
`deferredQueue` into `execQueue` and resumes.

**Why:** the fleetdispatch page is the only ogame page that crashes
visibly when token race happens (its render path calls
`FleetHelper.calcFuelCapacity` which dereferences a config that
`checkTarget` was supposed to populate). Other pages tolerate the race
silently. So we pay the throughput cost of deferral only on this one
page.

**Side effect:** background expedition / discover throughput drops to
zero while operator is composing a fleet. Acceptable — operator is also
not idle, and the deferral lifts the moment they navigate away.

### Layer 2 — Cargo-probe page skip

**File:** `packages/runtime-userscript/src/boot.ts:821`
**Introduced:** v0.0.391

`probeShipCargoCap()` checks `location.search` for `component=
fleetdispatch` and returns immediately if matched. Reason: the probe
POSTs `fleetSelectionAjax am202=1` + `checkTarget` — the same endpoints
ogame UI uses for form submission. On any other page these POSTs are
harmless to the rendering, but on fleetdispatch they mutate the form's
backing state and the UI re-renders with garbage.

This is redundant with Layer 1 in spirit (both block on fleetdispatch)
but probe is not routed through GoalRunner — it's a boot-time +10s
single-shot scheduled directly. The explicit check is the only gate.

### Layer 3 — Click intercept + replay

**File:** `packages/runtime-userscript/src/boot.ts:393` (clickInterceptSync)
**Introduced:** v0.0.386, hardened v0.0.389, extended v0.0.393

Capture-phase listener on `document` for `click` + `mousedown`. When the
operator clicks while any background ogame ajax is in flight:

```
mousedown captured
  → check window.__ogamexCpInFlight (synchronously)
  → > 0:
    → e.preventDefault()
    → e.stopPropagation()
    → show toast "⏳ 同步星球中…"
    → async await safe_fetch.awaitCpIdle()
    → hide toast
    → dispatchEvent(new MouseEvent(e.type, {...}, REPLAY_FLAG=true))
    → REPLAY_FLAG-marked event passes through the capture handler
       unmodified, so ogame's framework handlers process it normally
```

**Boot-time failsafe** (v0.0.389): before installing the listener, the
boot code tries to construct a `new MouseEvent("click", {...})`. If the
Tampermonkey sandbox rejects it (some sandboxes refused
`view: env.win`), `canReplayClick` stays false and the listener is
never attached. Worst-case outcome: no click protection, but clicks
are not eaten — the failure mode of an un-replayable intercept is
deadly (operator UI freezes), so this gate must remain.

**Synthetic MouseEvent options used:** `bubbles`, `cancelable`, `button`,
`buttons`, `clientX/Y`, modifier keys. `view` is intentionally omitted
because TM sandbox's `env.win` is a wrapped proxy that's not accepted
as a Window. jQuery + ogame's framework don't read `.view`.

### Layer 4 — In-flight tracking (safe_fetch)

**File:** `packages/runtime-userscript/src/api/safe_fetch.ts`
**Introduced:** v0.0.386, extended v0.0.393

The synchronous read in Layer 3 needs an O(1) counter the click handler
can check. `safe_fetch` maintains `inFlightCpFetches: Set<Promise>` and
mirrors `size` to `window.__ogamexCpInFlight` on every add/delete.

Two ways to add an entry:

1. **`fetchWithCp(url, init, sourcePID, opts)`** — the primary cp= fetch
   path. The Promise is added at start, deleted in the `finally` block
   after the request completes AND the session-cp restore fetch
   completes.

2. **`trackBackgroundOp(): release fn`** — for ogame ajax that doesn't
   carry `&cp=` but does rotate the global token. Caller pushes a
   placeholder promise and gets a `release()` function to call in
   `finally`.

   **Callers of `trackBackgroundOp`:**
   - `goal_runner.ts:155` — wraps the entire `chosen.execute(directive)`
     call so click_lock blocks for the full multi-stage ApiExec chain
     (token fetch → fleetSelectionAjax → checkTarget → sendFleet), not
     just individual cp= sub-fetches.
   - `fleet_api.ts:175` (recallFleet outer wrapper) — recall POSTs to
     `/movement` without cp= injection; without this wrap, click_lock
     would think recall is "off" the moment its inner ctx.fetch
     completes.

`awaitCpIdle()` returns a promise that resolves when
`inFlightCpFetches` empties (with a bounded retry loop to handle races
where a new fetch starts during the await).

## Layer interactions

```
              operator click
                    │
                    ▼
  ┌─────────────────────────────────────────┐
  │ Layer 3: clickInterceptSync (capture)   │
  │ — sync read window.__ogamexCpInFlight   │
  │ — if 0 → pass through                   │
  │ — if > 0 → preventDefault + replay      │
  └─────────────────────────────────────────┘
                    ▲
                    │ mirror updates
                    │
  ┌─────────────────────────────────────────┐
  │ Layer 4: safe_fetch inFlightCpFetches   │
  │ — fetchWithCp pushes Promise            │
  │ — trackBackgroundOp pushes Promise      │
  └─────────────────────────────────────────┘
                    ▲
                    │ pushes (during execute)
                    │
  ┌─────────────────────────────────────────┐
  │ GoalRunner.run() (boot.ts wires it)     │
  │ ┌─────────────────────────────────────┐ │
  │ │ Layer 1: fleetdispatch page check   │ │
  │ │   on → deferredQueue + poll         │ │
  │ │   off → trackBackgroundOp + execute │ │
  │ └─────────────────────────────────────┘ │
  └─────────────────────────────────────────┘

  ┌─────────────────────────────────────────┐
  │ Layer 2: probeShipCargoCap (independent)│
  │ — entry: skip if on fleetdispatch page  │
  │ — otherwise: fetchWithCp's already      │
  │   feed into Layer 4                     │
  └─────────────────────────────────────────┘
```

## What ISN'T protected (and why)

| Path | Tracked? | Reason |
|---|---|---|
| emergency FS save (FSM `sendFleet`) | Yes (via fetchWithCpBypassBusy) | Life-or-death; runs through fetchWithCp so it's tracked anyway. The `bypassBusy` flag is historical — its semantics are now "no defer", which is what we want here. |
| eventbox poll (sniffer-side) | No | ogame's framework fires these, not us. We can't track ogame's own fetches. We do parasitize their responses in `eventbox_hook`. |
| sidecar HTTP push/poll | No | Doesn't touch ogame's token at all (separate origin). |
| Discord bridge daemon goals | Yes (transitively) | Bridge dispatches sidecar goals → frontend GoalRunner → Layer 1/4. |
| Direct `fetch()` in test code | No | Tests run in jsdom; no ogame to race. |

## Historical mechanisms (removed)

These layers existed and have been deleted as Layers 1–4 matured.

| Mechanism | Lifetime | Removed in | Reason removed |
|---|---|---|---|
| `__ogamexUserBusyUntil` set by mousedown + 5s `IDLE_GUARD_MS` | v0.0.361 → v0.0.394 | v0.0.394 | Page-aware (Layer 1) + click intercept (Layer 3) are precise; mouse-based timer was both noisy (random clicks defer real work) and silently buggy (a unit mismatch made it permanent for several versions). |
| `user_busy_until` mirrored into `state.server` for sidecar | v0.0.361 → v0.0.394 | v0.0.394 | Same as above. Sidecar's `[merger] SKIP` log line is gone. |
| `discover/expedition bypass userBusy` | v0.0.361 / v0.0.377 → v0.0.382 | v0.0.382 | Bypass restored throughput at the cost of cp= shifts during operator activity. Layer 3 now protects clicks instead, so bypass is unnecessary. |
| `BusyDeferredError` thrown from `fetchWithCp` | → v0.0.387 | v0.0.387 | Defanged: `userBusyNow()` returns false unconditionally. |
| `daily/expedition/loop` (frontend daemon) | M3 → v0.0.374 | v0.0.374 | Always-disabled in strategy; sidecar discord-bridge daemon does the actual expedition dispatch. |

## Operator notes / runbook

- **Symptom:** ogame fleetdispatch UI shows
  `"Uncaught TypeError: Cannot read properties of null (reading 'baseFuelCapacity')"`.
  **Likely cause:** Layer 1 not active or being bypassed. Check
  `[GoalRunner] on fleetdispatch page — deferring ...` is being logged.

- **Symptom:** operator click does nothing.
  **Likely cause:** Layer 3 replay failed. Look for
  `[OgameX/click-lock] replay failed (click lost)` in console. If the
  sandbox can't construct synthetic MouseEvent, `canReplayClick` will
  be false at boot (warn logged) and the listener is never attached —
  in that case clicks pass through unprotected (no race protection,
  but also no eating).

- **Symptom:** `[merger] SKIP — operator active for Ns more` in sidecar
  log.
  **Likely cause:** running pre-v0.0.387 sidecar; the v0.0.387 sidecar
  no longer reads `user_busy_until`. Restart sidecar.

- **Tuning the page list:** Layer 1's gate is hard-coded to
  `component=fleetdispatch`. If a new ogame page surfaces similar
  crash patterns, add its component name to the `includes()` check in
  `goal_runner.ts:138` AND in `schedulePollIdle`'s wake condition.

## References

- `goal_runner.ts:138` — fleetdispatch defer entry
- `goal_runner.ts:218` — schedulePollIdle wake condition
- `boot.ts:317` (approx) — click intercept install
- `boot.ts:821` — cargo-probe page check
- `api/safe_fetch.ts` — inFlightCpFetches, trackBackgroundOp, awaitCpIdle
- `api/fleet_api.ts:175` — recallFleet outer trackBackgroundOp wrapper

Memory files that informed the current design:
- `feedback_cp_shift_visible` — cp= fetch flips ogame UI
- `feedback_official_api_exists` — ogame ajax endpoints discoverable
- `feedback_no_guessing` — verify endpoint shapes before code
- `reference_safe_fetch_arch` — every cp= fetch must go through safe_fetch
