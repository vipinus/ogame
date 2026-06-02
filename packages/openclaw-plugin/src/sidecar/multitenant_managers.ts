/**
 * Phase 9c.3 — Per-user SaveCoordinator + FailureAggregator managers.
 *
 * 顶层设计:
 *   - Each user gets a private instance, lazily created on first access.
 *   - getOrCreate hydrates per-user FSM state + cooldowns from PG (via the
 *     existing user-scoped persistence sinks).
 *   - state.snapshot / event.daily_failure / event.emergency handlers
 *     route by ALS user_id (set by HttpServer.dispatchPush when Bearer
 *     resolves to a PG user).
 *   - Legacy single-tenant operator (no ALS frame): falls back to env
 *     OGAMEX_LEGACY_USER_ID → same manager bucket → behaves identically
 *     to pre-9c.3.
 *
 * What's deliberately NOT here:
 *   - send() downstream queue isn't yet user-scoped — every per-user
 *     instance shares the same global http.queueDownstream sink. Phase
 *     9c.5 (poll endpoint multi-tenancy) lifts that.
 *   - PriorityMerger reads SaveCoordinator via cross-talk only in legacy
 *     paths; 9c.2 made dispatch user-aware but doesn't yet consult the
 *     per-user SaveCoord. That seam will close in 9c.6.
 */

import { SaveCoordinator, type SaveCoordinatorOptions } from "./save_coordinator.js";
import {
  createFailureAggregator,
  type FailureAggregator,
  type FailureAggregatorDeps,
  type FailureAggregatorOptions,
} from "./failure_aggregator.js";

export interface SaveCoordinatorManagerDeps {
  /** Per-user constructor opts. The caller supplies a factory because
   *  saveCoordinator needs a `stateRef` per user (the per-user
   *  WorldState mirror), `send`, and `persistence`. */
  buildOptionsFor(userId: string): SaveCoordinatorOptions;
}

export class SaveCoordinatorManager {
  private readonly map = new Map<string, SaveCoordinator>();
  constructor(private readonly deps: SaveCoordinatorManagerDeps) {}

  /** Get or lazily create the coordinator for a user. Caller is expected
   *  to call rehydrate() on the returned instance from outside if PG has
   *  prior save_records — we don't auto-rehydrate because that's an
   *  async DB call and this getter is sync. */
  get(userId: string): SaveCoordinator {
    let inst = this.map.get(userId);
    if (!inst) {
      inst = new SaveCoordinator(this.deps.buildOptionsFor(userId));
      this.map.set(userId, inst);
    }
    return inst;
  }

  /** Iterate all live coordinators — used by per-tick scans. */
  *entries(): IterableIterator<[string, SaveCoordinator]> {
    yield* this.map.entries();
  }

  size(): number { return this.map.size; }
}

export interface FailureAggregatorManagerDeps {
  buildDepsFor(userId: string): FailureAggregatorDeps;
  baseOptions?: FailureAggregatorOptions;
}

export class FailureAggregatorManager {
  private readonly map = new Map<string, FailureAggregator>();
  constructor(private readonly deps: FailureAggregatorManagerDeps) {}

  get(userId: string): FailureAggregator {
    let inst = this.map.get(userId);
    if (!inst) {
      inst = createFailureAggregator(
        this.deps.buildDepsFor(userId),
        this.deps.baseOptions,
      );
      this.map.set(userId, inst);
    }
    return inst;
  }

  size(): number { return this.map.size; }
}
