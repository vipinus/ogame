# Species Discovery (2026) — Design

**Operator request 2026-05-23**: "开一类新任务 2026 版的种族发现任务".

## Goal

Automate ogame v12 Lifeform "discovery missions" — the purple DNA icons in
Galaxy view. From a chosen source planet, sweep `±range` systems and dispatch
one exploration fleet per (galaxy, system, position 1..15) coordinate.

Operator constraints:
- **Full API**, zero DOM clicks (`用 api 执行 0 点击`).
- Keep **1 fleet slot empty** at all times.
- Auto-stop when all coords attempted.
- Panel UI with planet dropdown (sorted by coords) + Start/Stop buttons.

## OGame mechanic facts (verified)

- **Trigger**: Galaxy view → purple DNA icon → `discoverPlanet(url, {galaxy, system, position, token})`.
- **Endpoint** (from operator's DOM paste):
  ```
  POST /game/index.php?page=ingame&component=fleetdispatch
       &action=sendDiscoveryFleet&ajax=1&asJson=1&cp=<planet>
  Content-Type: application/x-www-form-urlencoded
  body: galaxy=N&system=N&position=N&token=...
  ```
- **Cost**: Metal 5000 / Crystal 1000 / Deuterium 500 per dispatch.
- **Cooldown**: per-coord 7 days.
- **Slot**: occupies 1 fleet slot during travel; slot frees when exploration
  fleet returns.
- **Prereq tech**: Humans' "Intergalactic Envoys" L1 + Research Centre.

## Architecture (5 抓手)

### 1. Shared types (`packages/shared/src/types.ts`)

Add `"species_discovery"` to the `GoalType` union. Goal `target` schema (runtime,
not statically typed — uses `Record<string, unknown>`):

```ts
{
  source_planet: string;   // planet ID (cp=PID)
  galaxy: number;
  base_system: number;     // anchor
  range: number;           // ±range systems (default 10)
  completed: string[];     // "G:S:P" coords already dispatched
}
```

### 2. Planner (`packages/openclaw-plugin/src/sidecar/planner.ts`)

`planSpeciesDiscoveryGoal(goal, state)`:

- Read target; validate.
- Compute `used_fleet_slots` / `max_fleet_slots` from `state.server`. If
  `used >= max - 1` → `{ blocked: "keep 1 fleet slot empty" }`.
- Build radial iteration order: `[base, base-1, base+1, base-2, base+2, ...]`.
- For each system × position 1..15, first coord NOT in `target.completed`
  becomes the next dispatch.
- If all `(2·range + 1) × 15` coords are in `completed` → blocked "all
  coords attempted" → goal terminates.
- Otherwise emit a `Directive` with `action: "discover"`, params containing
  `{galaxy, system, position, planet_id, goal_id}`.

### 3. ApiExec (`packages/runtime-userscript/src/api_executor.ts`)

`execDiscover(directive, planetId)`:

1. **Fetch fresh CSRF token** via background GET
   `/game/index.php?page=ingame&component=galaxy&cp=<planet>`. Parse the
   response HTML for `var token = "..."` or `<input name="token">` or
   `<meta name="ogame-token">`. Fall back to cached token in dataset.
   *No SPA nav, no DOM click.*
2. **POST sendDiscoveryFleet** with body `galaxy=N&system=N&position=N&token=...`.
3. Parse JSON response: `{success, newAjaxToken, errors?}`. Rotate token into
   dataset + localStorage. Throw on `success === false`.
4. Return `{action: "discover", clicked: true}` — sidecar handles bookkeeping.

`canHandle` includes `"discover"`.

### 4. Sidecar bookkeeping (`packages/openclaw-plugin/src/sidecar/index.ts`)

When the dispatch directive flows through sidecar's relay:

- Stamp `last_discover_coord = "G:S:P"` onto the goal row (in-memory metadata
  on the `GoalRow`, not persisted target).

When `event.directive_completed` arrives with `success: true` for a
`species_discovery` goal:

- Read `last_discover_coord` from the row.
- Append it to `target.completed[]` (if not already present).
- Goal stays `"active"` — planner picks next coord next tick.

When `success: false`:

- Goal flips to `"blocked"` with the rejection reason. Operator can retry
  manually or the planner re-emits if the failure clears (slot frees, token
  rotates, etc.).

### 5. HTTP endpoint (`packages/openclaw-plugin/src/sidecar/http_server.ts`)

- `POST /ogamex/v1/discovery/create` — public, no-auth (panel-only LAN).
  Body: JSON `{source_planet, galaxy, base_system, range?}`. Returns
  `{ok, goal_id, reason?}`.
- Handler calls `opts.createDiscoveryGoal(...)` wired in `sidecar/index.ts`,
  which adds a new goal to `goalsStore` after checking no existing active
  discovery on the same source planet.

### 6. Panel UI (`packages/runtime-userscript/src/overlay/goals_panel.ts`)

New section `🧬 Discovery` between Expedition and Goals:

- **No active discovery**: planet dropdown (planets from
  `window.__ogamexStore.state.planets`, sorted by `[g,s,p]` ascending) +
  range numeric input (default 10) + "Start Discovery" button.
- **Active discovery**: shows `[galaxy:base_system] ±range from <planet>` +
  `N/total done` + "Stop" button (cancels the goal).

Button click handlers POST to `/ogamex/v1/discovery/create` and
`/ogamex/v1/goals/<id>/cancel`. Panel auto-refreshes after each click.

## Slot accounting

`state.server.used_fleet_slots` / `max_fleet_slots` are written by
`harvestSlotsFromMovement`. Planner reads these directly. Each discovery
counts as 1 fleet slot. The "keep 1 empty" rule means `used + 1 <= max - 1`
→ planner blocks when `used >= max - 1`. Slot frees when ogame returns the
exploration fleet (visible in `/movement` page).

## Cooldown handling

We don't track ogame's per-coord 7-day cooldown explicitly. Rationale:
1. Operator's goal is typically a fresh sweep — every coord starts uncooled.
2. If ogame rejects a coord (cooldown active), the directive completes with
   `success: false` → goal becomes blocked; operator decides retry vs cancel.
3. After all 315 coords attempted (success OR cooldown-block), planner ends
   the goal.

If needed later, the rejection reason from ogame can be parsed for "cooldown"
hints and `target.cooldown_until[coord] = next_eligible_ts` stored. Out of
scope for v1.

## Why this is fully API

- **GET** `/component=galaxy&cp=PID` — pure HTTP, no DOM mutation. (Reads
  HTML body for CSRF token; doesn't render in browser tab.)
- **POST** `sendDiscoveryFleet` — pure HTTP. No clicks.
- **Panel UI** — only buttons in our overlay; ogame DOM untouched.
- **No `kickMenuNav`**, no iframe loading, no `link.click()`.

## Race conditions

- **Same-planet multiple goals**: blocked at `createDiscoveryGoal` —
  returns `{ok: false, reason: "discovery already active"}` if any
  non-terminal `species_discovery` goal exists for that planet.
- **Multi-tick dispatch**: planner emits 1 directive per `planGoal` call.
  Sidecar merger ticks every ~500ms; ApiExec executes sequentially per
  `pumpQueue`. No parallel POSTs from same goal.
- **Fleet slot race vs expedition**: both planners read the same
  `used_fleet_slots`. Expedition's daemon tick + planner discovery tick
  may both see N free and queue → ogame may reject the second. ApiExec
  preflight pollEmpire + ogame's own validation will block the actual
  POST. Worst case: 1 wasted directive cycle, goal stays blocked.

## Open items (out of v1 scope)

- 7-day cooldown awareness (planner currently retries blocked coords next
  goal).
- Multi-planet load balancing (sweep system X from planet A, system X+1
  from planet B for energy spread).
- Cost gating — block when planet resources < 5000M/1000C/500D.
- Daemon-side trigger (currently sidecar planner-driven; daemon doesn't know
  about discovery goals).

## Files changed

- `packages/shared/src/types.ts` — `species_discovery` in GoalType union.
- `packages/openclaw-plugin/src/sidecar/planner.ts` — `planSpeciesDiscoveryGoal`.
- `packages/openclaw-plugin/src/sidecar/index.ts` —
  `createDiscoveryGoal` callback + directive_completed handler for
  species_discovery (`last_discover_coord` → `target.completed[]`).
- `packages/openclaw-plugin/src/sidecar/http_server.ts` —
  `POST /v1/discovery/create` endpoint.
- `packages/runtime-userscript/src/api_executor.ts` — `execDiscover`,
  canHandle expanded.
- `packages/runtime-userscript/src/overlay/goals_panel.ts` — `🧬 Discovery`
  section, planet dropdown, Start/Stop wiring.
