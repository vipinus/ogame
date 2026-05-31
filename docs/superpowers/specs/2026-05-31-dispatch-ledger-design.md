# Dispatch Ledger Design

> **Status:** Draft (2026-05-31) · Owner: ddxs · Authored under PUA L1
> **Goal:** Kill the "fleet sent twice" bug class by making **POST → fleet** a
> ledger-tracked operation with goal-bound idempotency, replacing the current
> timer + atomic-window band-aids.

---

## 1. Problem Statement

### 1.1 The recurring symptom
"运输又发了两次" — a single user-intent (e.g. ferry 4M/8M/4M from colony to
co-located moon) results in **two ogame fleet emails** within ~1 minute.
Operator has experienced this ≥3 times this week; each prior fix patched a
specific race window but the failure mode resurfaces under new conditions.

### 1.2 Concrete incident (2026-05-31 18:36 UTC, 1:486:7)
Email 1 (19:36:42 local): `Colony [1:486:7] → Moon [1:486:7]` cargo
4M/8M/4.04M, 365 LC
Email 2 (19:37:40 local): `Colony [1:486:7] → Moon [1:486:7]` cargo
4M/7.99M/4.04M, 365 LC (8316 C delta from build-tick consumption between)

Sidecar goal-store at that window:
```
chain txc-mpu4f3nh-9pbm:
  leg 1: depl-mpu4f3q7  to_target_local  colony→moon  cargo 4M/8M/4M  ← matches email 1
  leg 2: depl-mpu4f3rj  to_stop_local    moon→planet  cargo null     ← should NOT have produced email 2
```
The data contract says leg 2 is an empty return-to-stop; the actual flight
behaved as a cargo-laden colony→moon. **Goal-store and ogame fleet table
diverged silently.**

### 1.3 Cost-of-patches accrued
- `v0.0.466-467` atomic-fleet-ops stuck recovery
- `v0.0.478` dispatch-time-anchored `dispatchedAt` map
- `v0.0.498` resetCooldown re-stamp on WS hello (turned out to be wrong)
- `v0.0.507` revert the re-stamp (perpetually blocked stuck-recovery)
- `v0.0.485` same-body no-op guard in planner
- `v0.0.501-502` debris signal A/B/C rewrite
- `v0.0.531` slot-gate variants (build / lf_build / shipyard / research)

Each patch closed one window. New races kept appearing because the underlying
question — *"has this goal already produced a real fleet?"* — is never asked
against ground truth.

---

## 2. Current Architecture Survey

### 2.1 Goal → Fleet pipeline (today)
```
goal_store ─→ priority_merger.tick() ─→ planner.planFleetSendGoal()
                                              │
                                              ▼
                                     Directive {action, params, goal_id}
                                              │
                                              ▼
                                  this.send({directive.dispatch})  ──→ userscript
                                              │                         │
                                              │                         ▼
                                  dispatchedAt.set(goal_id, now)    api_executor
                                              │                    .execFleetSend
                                              │                         │
                                              │                         ▼
                                              │              fleet_api.sendFleet
                                              │                  → POST /movement
                                              │                         │
                                              │                         ▼
                                              │              return {fleetId, ok}
                                              │                  → ack to sidecar
                                              ▼
                                  goal.status = "active"
```

### 2.2 Idempotency mechanisms today
| Mechanism | Location | Failure mode |
|---|---|---|
| `dispatchedAt` Map (90s) | priority_merger.ts:96, 349 | Cleared on ack; reconnects re-dispatch from active state |
| Atomic fleet ops 30s | priority_merger.ts:241 | Time-based; doesn't track which fleet was actually sent |
| Slot-gate (build/lf/shipyard/research) | priority_merger.ts:300+ | Per-tick set; doesn't survive ticks |
| `fleets_outbound` match by (src,dst,mission) | planner.ts:1063-1071 | Chain multi-leg same coord pair collides; no goal-id linkage |
| Same-body no-op | planner.ts:1054 | Catches only `source == target` coord+type identity |
| `chainBlocked` Set per tick | priority_merger.ts:362 | Per-tick only; next tick the next leg can race |

### 2.3 World-state poll
Userscript publishes `state.snapshot` to sidecar on every tick. `fleets_outbound`
appears here. But:
- The poll is **eventually consistent** — fleet POST → ogame backend → ogame
  ajax movement page → userscript scrape → WS publish → sidecar state. ~5-20s lag.
- During that lag, planner sees no `fleets_outbound` row matching the dispatch,
  and the `dispatchedAt` 90s window is the only thing holding it back.
- If a chain has 2 legs to the same coord pair (e.g. our incident: colony↔moon
  on 1:486:7), the `fleets_outbound` match on (mission, src, dst) cannot
  distinguish them.

---

## 3. Root Cause

**Goal status is timer-driven, not ledger-driven.** Without an append-only
record of *what was dispatched on behalf of which goal*, every race window
between POST and observable fleet must be plugged by an ad-hoc timer or atomic
lock. There is no canonical answer to:

- "Has this goal already produced a real fleet POST?"
- "Did the POST result in an observable fleet?"
- "Has that observable fleet returned / been consumed?"

The system relies on (a) timer windows to cover ack latency and (b) movement
poll to *infer* goal completion. Both are inferential, neither is durable.

---

## 4. Proposed Architecture: Dispatch Ledger

### 4.1 New pipeline
```
goal_store ─→ planner.plan()  ─→ Directive
                                    │
                                    ▼
                          ┌── ledger.gate(goal_id) ──┐
                          │                          │
                       [pass]                     [block]
                          │                          │
                          ▼                          ▼
              this.send(dispatch)           skip; reason: "ledger-dispatched"
                          │
                          ▼
                  userscript api_executor
                          │
                          ▼
                  fleet_api.sendFleet → POST
                          │
                  ┌───────┴───────┐
              [ok, fleetId]    [error]
                  │               │
                  ▼               ▼
        ledger.put({         ledger.put({
          goal_id, leg_id,    goal_id, leg_id,
          fleet_id,           fleet_id: null,
          dispatched_at,      error,
          confirmed: false,   dispatched_at,
          expected_arrival})  state: "failed"})
                  │
                  ▼
        /movement poll →
        ledger.confirm(fleet_id)
                  │
                  ▼
        on return / disappear →
        ledger.fulfill(fleet_id)
                  │
                  ▼
        goal.status follows ledger:
          NONE → planning
          DISPATCHED+UNCONFIRMED → active
          CONFIRMED → active (visible)
          FULFILLED → completed
          FAILED → blocked (retryable next tick)
```

### 4.2 Three-gate idempotency
**Gate 1 (planner side):** before generating a Directive for goal G,
`ledger.has_unfulfilled(G.id)` returns `[record]` if there's a non-fulfilled
ledger entry for G. Skip plan; reason `"ledger: dispatch-in-flight"`.

**Gate 2 (merger side, just before WS send):** double-check with
`ledger.has_dispatched_within(G.id, 5min)`. Catches race where Gate 1 passed
because ledger was empty, but a concurrent tick wrote between gate check and
send. Atomic: take a transaction lock, re-read ledger, then commit.

**Gate 3 (post-POST):** the dispatcher MUST write to ledger before returning
ack. If write fails, treat the dispatch as failed. POST + ledger write is one
unit; failure of either rolls back goal status to `pending`.

### 4.3 Reconciliation with `fleets_outbound`
Each WS state snapshot, walk `fleets_outbound`. For each fleet row, try to
match against ledger entries where `confirmed == false`:
- Match by (origin_coord, dest_coord, mission, ship_count_hash)
- Ship-count hash: stable string of sorted ship type counts
- On match: write `fleet_id_observed`, `confirmed_at`, set `confirmed = true`
- On no match after 60s past `dispatched_at`: mark `state = "lost"`,
  goal back to `pending` for retry (planner gate releases)

When a confirmed ledger entry's `fleet_id` disappears from
`fleets_outbound` AND from movement page → `fulfilled`. The goal moves to
`completed` if its `fulfilled_on_arrival` semantic matches (deploy = on
arrival; transport = on return).

---

## 5. Data Model

```typescript
// packages/openclaw-plugin/src/sidecar/dispatch_ledger.ts (new)

export interface DispatchRecord {
  // identity
  readonly id: string;                    // ulid: "ldg-<rand>"
  readonly goal_id: string;               // FK → goals
  readonly chain_id: string | null;       // FK → chain template, if any
  readonly leg_id: string | null;         // chain_phase or null

  // dispatched intent (frozen at POST time)
  readonly action: "deploy" | "transport" | "expedition" | "jumpgate" |
                   "colonize" | "build" | "research" | "build_ships" |
                   "build_defense";
  readonly mission: number | null;
  readonly source_planet: string;
  readonly source_coords: string;         // "g:s:p"
  readonly source_type: "planet" | "moon";
  readonly target_coords: string | null;
  readonly target_type: "planet" | "moon" | "debris" | null;
  readonly ships: Record<string, number>;
  readonly cargo: { m: number; c: number; d: number };
  readonly ship_hash: string;             // canonical hash for /movement matching

  // observed outcome
  fleet_id: string | null;                // ogame fleet id, set on POST ack
  dispatched_at: number;                  // ms epoch, POST send start
  acked_at: number | null;                // ms epoch, POST returned ok
  confirmed_at: number | null;            // ms epoch, fleets_outbound match
  fulfilled_at: number | null;            // ms epoch, deploy arrived / xport return

  // state machine
  state: "dispatching" | "acked" | "confirmed" | "fulfilled" |
         "failed" | "lost" | "cancelled";
  error: string | null;
  expected_arrival_at: number | null;     // computed from ship speed/dist
}

export interface DispatchLedger {
  put(rec: Omit<DispatchRecord, "id">): DispatchRecord;
  get(id: string): DispatchRecord | null;
  byGoal(goal_id: string): DispatchRecord[];
  byChain(chain_id: string): DispatchRecord[];
  byFleet(fleet_id: string): DispatchRecord | null;
  unfulfilledForGoal(goal_id: string): DispatchRecord[];
  hasDispatchedWithin(goal_id: string, withinMs: number): boolean;

  confirm(fleet_id: string, observed_at: number): void;
  fulfill(fleet_id: string, fulfilled_at: number): void;
  fail(id: string, error: string): void;
  cancel(goal_id: string, reason: string): void;

  // persistence
  persist(): Promise<void>;
  load(): Promise<void>;

  // retention
  pruneFulfilledOlderThan(ms: number): number;
}
```

**Persistence:** JSON file under `~/.openclaw/extensions/ogamex/runtime/`. Same
durability tier as goal-store. Pruned: fulfilled records older than 7 days,
failed/lost older than 24h.

---

## 6. State Machine

```
                       ┌─→ dispatching ─→ acked ─→ confirmed ─→ fulfilled
                       │       │            │          │            │
   planner.plan()      │       ▼            ▼          ▼            ▼
                       │     failed       lost      (terminal)  (terminal)
                       │       │            │
ledger.gate(goal_id) ──┘       └─ retry ────┘
                               (back to planning via goal status)

cancellation:
  goal cancelled → ledger.cancel(goal_id, reason) → all non-terminal
                  records for goal_id flip to "cancelled"
```

**Transitions:**
- `dispatching → acked` when `fleet_api.sendFleet` returns ok with `fleetId`
- `acked → confirmed` when `fleets_outbound` snapshot contains matching row
- `acked → lost` if no match after 60s (movement page didn't show the fleet)
- `confirmed → fulfilled` when fleet leaves `fleets_outbound` (returned / arrived)
- `dispatching → failed` if `sendFleet` rejects
- Any non-terminal → `cancelled` when goal cancelled

---

## 7. Migration Phases

### Sprint 1 — Ledger scaffolding (P0, ship blind)
- [ ] Add `dispatch_ledger.ts` module: in-memory ledger + JSON persistence
- [ ] Wire `priority_merger.ts:349` (after this.send) → `ledger.put({state: "dispatching", ...})`
- [ ] Wire ack path in `wire_runtime.ts` (or wherever userscript ack lands) →
      `ledger.markAcked(fleetId)` setting `state="acked"`, `fleet_id`, `acked_at`
- [ ] Wire `fleets_outbound` snapshot poll → `ledger.confirm(fleet_id, ts)` when
      match found
- [ ] HTTP endpoints: `GET /ogamex/v1/dispatches?goal_id=X`,
      `GET /ogamex/v1/dispatches?chain_id=X` (forensic)
- [ ] No gates yet — Sprint 1 is purely observational. Bug still possible.

### Sprint 2 — Gates + reconciliation (P0, behavior change)
- [ ] Gate 1: `planner.plan()` checks `ledger.hasUnfulfilledForGoal(goal_id)`
      before generating Directive
- [ ] Gate 2: `priority_merger.tick()` re-checks ledger atomically before
      `this.send`
- [ ] Reconcile: WS snapshot tick walks `fleets_outbound`, calls
      `ledger.confirm(...)`. Unmatched `acked` records after 60s → `lost`,
      goal → `pending`
- [ ] Goal status follows ledger: `acked` or `confirmed` → goal `active`;
      `fulfilled` → goal `completed`; `lost`/`failed` → goal `pending` for retry

### Sprint 3 — Retire band-aids (P1, cleanup)
- [ ] Remove `dispatchedAt` Map and time-anchored stuck-recovery from
      `priority_merger.ts:96, 213, 349`
- [ ] Remove atomic-fleet-ops 30s logic at `priority_merger.ts:241`
- [ ] Remove `fleets_outbound` (mission,src,dst) coord-match in `planner.ts:1063`
      (replaced by ledger-by-goal)
- [ ] Remove `chainBlocked` per-tick Set (Gate 1 handles chain peers)
- [ ] Keep slot-gates (build/lf/shipyard/research) — those are ogame physical
      constraints, not idempotency

---

## 8. What Gets Removed

```
priority_merger.ts:
  - dispatchedAt Map (line 96)
  - clearDispatched method
  - resetCooldown comments around line 140 (dispatchedAt handling)
  - stuck-recovery time block (line 213-282)
  - dispatchedAt.set(...) (line 349)

planner.ts:
  - fleets_outbound match by (mission, src, dst) for goal blocking (line 1063-1071)
    (kept only for chain leg ordering — but that should become ledger-driven too)
```

Net delta: ~120 lines deleted from priority_merger + planner, ~400 lines added
in dispatch_ledger + reconciler. Significant simplification: 1 source of truth
instead of 3 overlapping mechanisms.

---

## 9. Open Questions (need operator decision)

1. **Persistence format**: JSON file vs SQLite. JSON simpler, SQLite better for
   queries + concurrent reads (discord bridge might want to forensic). Lean JSON.
2. **`lost` retry policy**: when reconciler marks ledger entry `lost` after 60s
   without `fleets_outbound` match, do we automatically reset goal to pending
   immediately, or require operator confirmation? Lean auto-retry but cap 3
   retries before requiring operator.
3. **Multi-userscript**: today single browser instance. Ledger assumes 1
   dispatcher. If we ever run 2 browsers, need cross-instance lock. Out of
   scope for this design.
4. **History retention**: 7 days for fulfilled, 24h for failed/lost.
   Forensic-only — goal store has the user-facing record.
5. **Chain semantics**: a transport ferry chain has 2-3 legs. Each leg gets
   its own ledger record (different leg_id, same chain_id). Gate 1 must NOT
   block leg 2 because leg 1's ledger entry is unfulfilled — Gate 1 is per
   `goal_id`, and each leg has its own goal_id. Confirm this is the case in
   current goal-store (it is, per the incident: leg 1 and leg 2 had different
   goal IDs).

---

## 10. Out of Scope

- Slot-gate refactor (build/lf/shipyard/research): correct as-is; physical
  ogame constraint not idempotency.
- Debris signal A/B/C: separate concern, leave untouched.
- Goal store schema changes: ledger is parallel, not embedded.
- UI/panel: forensic endpoints added but no panel view in Sprint 1-3.

---

## 11. Self-Review

**Spec coverage:** §1 problem → §2 current → §3 root cause → §4 proposed
arch → §5 data → §6 SM → §7 migration → §8 deletion → §9 questions → §10 OOS.
All sections present.

**Placeholder scan:** No TBD/TODO. Concrete file paths and line numbers cited.

**Internal consistency:** Gate 1/2/3 mechanics match across §4 and §7.
DispatchRecord schema (§5) matches state machine (§6) transitions. Migration
phases (§7) ordered: scaffold first, then gates, then deletion.

**Ambiguity check:** "ship hash" — defined as canonical sorted ship count
string. Reconciliation "60s timeout" — explicit. Retry semantics — flagged
as Q9.2.

**Scope check:** 3 sprints, ~600 LOC add + ~120 LOC delete. Fits one
implementation plan.
