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

## Cooldown handling (v0.0.240 — implemented)

Per-coord 7-day cooldown is now detected **before** the dispatch POST,
not after. The original "let ogame reject + mark blocked" design wasted
one POST per coord per tick (315 POSTs for a full sweep, every minute,
trips WAF rate limits and pollutes session).

### Galaxy state pre-check

`execDiscover` first calls `fetchGalaxyContent` for the target system
and parses `system.galaxyContent[]`. The result is cached for 5 minutes
per `(galaxy, system)` key — repeated discovers in the same tick reuse
the cache.

```
POST /game/index.php?page=ingame&component=galaxy
     &action=fetchGalaxyContent&ajax=1&asJson=1
body: galaxy=N&system=N
```

Response shape (verified 2026-05-23 from operator's sniff):

```json
{
  "system": {
    "galaxy": 1, "system": 484,
    "galaxyContent": [
      {
        "position": 5,
        "planets": [...],
        "availableMissions": [
          {
            "missionType": 18,
            "canSend": "您可以在 1日 7時 之後再次搜索生命形式\n",
            "discoveryCount": "（1106/2700）",
            "link": ".../sendDiscoveryFleet..."
          }
        ]
      }
    ]
  }
}
```

### `availableMissions[].canSend` semantics

ogame returns `canSend` as a **union type** across coords (verified via
two galaxies: 1:484 returned strings, 1:483 returned booleans). The
parser must handle both:

| `canSend` value | Meaning | Position state |
|-----------------|---------|----------------|
| string non-empty (e.g. cooldown countdown) | This coord on 7-day cooldown | `cooldown` — skip POST |
| string empty `""` | Free to dispatch | `available` |
| `undefined` | Free to dispatch | `available` |
| `true` (boolean) | Free to dispatch | `available` |
| `false` (boolean) | Blocked (cooldown / no planet / no tech) | `cooldown` |
| missionType=18 entry absent | Mechanically impossible (empty position, no tech) | `unavailable` |

**Type guard required**: an earlier `(canSend ?? "").trim()` form threw
`TypeError: trim is not a function` when ogame returned boolean — the
fix is explicit `typeof` branching (see `api_executor.ts` execDiscover
parser block, lines ~860–880).

### Pre-check flow

```
execDiscover(galaxy, system, position):
  states = cached[galaxy:system] or fetchGalaxyContent(galaxy, system)
  state  = states.get(position) ?? "unknown"
  if state !== "available":
    log "pre-check SKIP (state=...)"
    return {clicked: true}      ← no POST, no token burn
  POST sendDiscoveryFleet ...
```

Net effect (measured 2026-05-23): 30 directives dispatched, 27 SKIP
(cooldown), 3 POST attempts — request rate drops 10× and stays under
WAF threshold.

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

## Goal completion bookkeeping (v0.0.234 — implemented)

Original design said "directive_completed handler appends to
`target.completed[]`". In practice the ack arrives **3–10 seconds**
after dispatch (event-list poll cycle). Within that window the planner
ticks again, re-reads `target.completed[]`, picks the **same coord** —
operator saw 50+ POSTs to `1:486:1` before the first ack arrived.

Fix: **optimistic completed[] write at dispatch time**, not at ack time.

```ts
// sidecar/index.ts on directive.dispatch:
if (d.action === "discover" && d.goal_id && d.params) {
  const coord = `${d.params.galaxy}:${d.params.system}:${d.params.position}`;
  const row = goalsStore.list().find(r => r.goal.id === d.goal_id);
  if (row?.goal.type === "species_discovery") {
    const tgt = row.goal.target as { completed?: string[] };
    const completed = [...(tgt.completed ?? [])];
    if (!completed.includes(coord)) completed.push(coord);
    goalsStore.updateTarget(d.goal_id, { ...row.goal.target, completed });
  }
}
```

### Directive shape critical detail (commit b538499)

The first implementation nested `goal_id` inside `params` — sidecar's
handlers read `d.goal_id` from **top level**. The mismatch silently
failed every update; `completed[]` stayed empty across hundreds of
dispatches. The Directive shape is:

```ts
{
  id: "dir-xxxx",
  action: "discover",
  goal_id: "g-xxxx",          // ← TOP LEVEL, not in params
  planet_id: "33642996",
  params: { galaxy, system, position }
}
```

Any planner emitting a new action type must put `goal_id` at the top
level — otherwise sidecar bookkeeping silently no-ops.

## Open items (out of v1 scope)

- Cost gating — block when planet resources < 5000M/1000C/500D (currently
  ogame rejects, directive flips success:false, blocked).
- Multi-planet load balancing (sweep system X from planet A, system X+1
  from planet B for energy spread).
- Daemon-side trigger (currently sidecar planner-driven; daemon doesn't know
  about discovery goals — fine because slot frees emit `data.refresh`
  which re-ticks planner).
- Persisted galaxy cache (current cache is in-memory, blown on reload —
  acceptable since fetchGalaxyContent is cheap).

## Implementation timeline

| Version | Commit | Change |
|---------|--------|--------|
| v0.0.228 | initial | Plan, ApiExec, panel, sidecar HTTP create endpoint. |
| v0.0.232 | b538499 | **Critical**: moved `goal_id` from `params` to top-level Directive. Before this, completed[] never updated → stuck on first coord. |
| v0.0.234 | (same day) | Optimistic `completed[]` append at dispatch (ack arrives too late to gate the next planner tick). |
| v0.0.238 | (debug) | Galaxy state cache (5min) + per-position state map. Initial parser only checked `missionType=18` presence — every position reported "available" but POSTs returned cooldown. |
| v0.0.240 | 99a2111 | `canSend` string-only parser: empty → available, non-empty → cooldown. Worked on systems where ogame returns strings (1:484). |
| v0.0.241 | this commit | `canSend` boolean union handling: type guard for `boolean` (1:483 returned `true`/`false` rather than countdown strings). Earlier `(canSend ?? "").trim()` threw `TypeError: trim is not a function`, fall-through left states map empty, all positions defaulted to cooldown. |

## Debug helpers

For investigating new galaxies, two helpers are exposed on both
`env.win` (sandbox) and `unsafeWindow` (page-world, accessible from
DevTools console):

```js
__ogamexDebugGalaxy(galaxy, system)
  // → POSTs fetchGalaxyContent, logs first 2000 chars of response,
  //   writes full response to clipboard. Returns response text.

__ogamexDbgMis(galaxy, system, position)
  // → calls __ogamexDebugGalaxy + extracts one position's
  //   availableMissions and full row. Use when you need to inspect
  //   what canSend / availableMissions look like for a specific coord.
```

If `canSend` ever returns a third shape (object, number, array), add a
branch to the type guard in `api_executor.ts` execDiscover parser.

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
