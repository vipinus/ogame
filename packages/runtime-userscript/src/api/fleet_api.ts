import {
  SHIP_IDS,
  type ShipKey,
  type ShipCount,
  type Coords,
  type CargoResources,
  type MissionCode,
} from "@ogamex/shared";
import type { TokenManager } from "./token_manager.js";

export interface SendFleetParams {
  ships: ShipCount;
  cargo: CargoResources;
  coords: Coords;
  destType: 1 | 2 | 3;       // 1=planet, 2=debris, 3=moon
  mission: MissionCode;
  speed: number;             // 1..10
  holdingTime?: number;      // for ACS defend / expedition duration
  /** Source planet PID. APPENDED to URL as `cp=<sourcePlanetId>` so the
   *  fleet POST lands on the source planet regardless of operator's
   *  current page navigation. Without this, ogame uses session-cp =
   *  whichever planet the operator was last viewing, and the fleet
   *  launches from the wrong planet. Operator 2026-05-24: case_decider
   *  picked source=33650372 (3:260:9), but operator was on 33637818
   *  (3:279:7) → fleet flew from 3:279:7 instead. */
  sourcePlanetId?: string;
}

export interface SendFleetCtx {
  fetch: typeof fetch;
  token: TokenManager;
  endpoint?: string;
}

export interface SendFleetResult {
  fleetId: number;
  raw: { success: boolean; fleetIdToReturn?: number; message?: string; newAjaxToken?: string };
}

export class FleetApiError extends Error {
  constructor(message: string, public readonly raw?: unknown) {
    super(message);
    this.name = "FleetApiError";
  }
}

const DEFAULT_ENDPOINT =
  "/game/index.php?page=ingame&component=fleetdispatch&action=sendFleet&ajax=1&asJson=1";
const RECALL_ENDPOINT =
  "/game/index.php?page=ingame&component=movement&action=recallFleetAjax&ajax=1&asJson=1";

const TOKEN_INVALID_RE = /invalid token|csrf|session expired/i;
// Operator 2026-05-28: ogame 140043 "艦隊派遣失敗:無法派遣艦隊.請稍後再試"
// is a transient dispatch-race (internal ogame lock contention during burst
// fleet POSTs, NOT slot-full — slot-full would be a different code path
// where exp/fleet slot counts are visible to gate). ogame self-describes
// as "please try again later". For emergency FS save, retry within attempt
// loop instead of bouncing to FSM FALLBACK (which costs 10s reset window
// while resources sit on planet under hostile incoming).
const TRANSIENT_RACE_RE = /140043|請稍後再試|请稍后再试|稍後再試|try again later/i;
// Operator 2026-05-28: ogame 140028 "倉存容量不足!" = dest planet/moon
// storage cap can't accept the cargo we're sending. For emergency FS save,
// what we ACTUALLY need is to get the SHIPS off the planet — the cargo is
// only the side-payload. Self-heal: strip metal/crystal/deuterium to 0 and
// retry, sending only ships. Operator loses the resource transport
// optimization for this save, but keeps the fleet alive.
const STORAGE_OVERFLOW_RE = /140028|倉存容量不足|仓存容量不足|storage.*insufficient|insufficient.*storage/i;

function buildBody(p: SendFleetParams, token: string): URLSearchParams {
  const body = new URLSearchParams();
  body.set("token", token);
  body.set("galaxy", String(p.coords[0]));
  body.set("system", String(p.coords[1]));
  body.set("position", String(p.coords[2]));
  body.set("type", String(p.destType));
  body.set("mission", String(p.mission));
  body.set("speed", String(p.speed));
  body.set("metal", String(p.cargo.m));
  body.set("crystal", String(p.cargo.c));
  body.set("deuterium", String(p.cargo.d));
  if (p.holdingTime !== undefined) body.set("holdingtime", String(p.holdingTime));
  for (const [shipKey, count] of Object.entries(p.ships)) {
    if (count === undefined || count <= 0) continue;
    const id = SHIP_IDS[shipKey as ShipKey];
    if (id === undefined) continue;
    body.set(`am${id}`, String(count));
  }
  return body;
}

export async function sendFleet(
  p: SendFleetParams,
  ctx: SendFleetCtx,
): Promise<SendFleetResult> {
  // cp= 通过 fetchWithCpBypassBusy 自动注入 + restore — FS emergency path
  // 不 gated by userBusy (life-or-death). Caller passes sourcePlanetId.
  const endpoint = ctx.endpoint ?? DEFAULT_ENDPOINT;
  let token = ctx.token.getFreshToken();
  let body = buildBody(p, token);
  const { fetchWithCpBypassBusy } = await import("./safe_fetch.js");

  // Operator 2026-05-28: bumped 2 → 4 attempts for emergency FS save. 140043
  // transient race needs more retry budget than token-invalid edge case.
  for (let attempt = 1; attempt <= 4; attempt++) {
    const sourcePID = p.sourcePlanetId ?? "";
    console.log(`[fleet_api/sendFleet] attempt=${attempt} POST ${endpoint}${sourcePID ? ` (cp=${sourcePID})` : ""} body=${body.toString().replace(/token=[^&]+/, "token=***")}`);
    const res = sourcePID
      ? await fetchWithCpBypassBusy(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Requested-With": "XMLHttpRequest" },
          body: body.toString(),
          credentials: "same-origin",
        }, sourcePID)
      : await ctx.fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Requested-With": "XMLHttpRequest" },
          body: body.toString(),
          credentials: "same-origin",
        });
    if (!res.ok) throw new FleetApiError(`HTTP ${res.status}`);
    const rawText = await res.text();
    let json: SendFleetResult["raw"];
    try { json = JSON.parse(rawText) as SendFleetResult["raw"]; }
    catch {
      console.error(`[fleet_api/sendFleet] non-JSON response (attempt ${attempt}):`, rawText.slice(0, 400));
      throw new FleetApiError(`non-JSON response: ${rawText.slice(0, 200)}`);
    }
    // Always log the raw response — operator 2026-05-24: fsm went to FALLBACK
    // with err="unknown failure" because json.message was empty and the raw
    // body was thrown away. Now every sendFleet response is loud.
    console.log(`[fleet_api/sendFleet] attempt=${attempt} resp success=${json.success} message=${json.message ?? "<none>"} errors=${JSON.stringify((json as { errors?: unknown }).errors ?? null)} raw[0:300]=${rawText.slice(0, 300)}`);
    if (json.success) {
      // Operator 2026-05-26 live verify: ogame v12 sendFleet response shape is
      //   {"success":true,"message":"您已成功發送艦隊.","redirectUrl":"...","components":[],"newAjaxToken":"..."}
      // — there is NO fleetIdToReturn field. Prior code required fleetIdToReturn
      // and treated this success as failure, sending fsm to FALLBACK with
      // err="您已成功發送艦隊." even though the fleet actually launched. Trust
      // success=true; fleet ID is harvested from the next /movement scrape by
      // boot.ts:761 harvestSlotsFromMovement (and matched by mission+origin).
      if (json.newAjaxToken) ctx.token.set(json.newAjaxToken);
      return { fleetId: json.fleetIdToReturn ?? 0, raw: json };
    }
    if (attempt === 1 && json.message && TOKEN_INVALID_RE.test(json.message)) {
      await ctx.token.invalidate();
      token = ctx.token.getFreshToken();
      body = buildBody(p, token);
      continue;
    }
    // Surface as much of the raw body as possible so the operator can see
    // what ogame actually said. Cap at 300 chars to keep error messages
    // readable in panel/Discord; full body is in console log above.
    const errsField = (json as { errors?: Array<{ message?: string }> }).errors;
    const errMsg = json.message
      ?? (Array.isArray(errsField) && errsField[0]?.message)
      ?? `success=${json.success} raw=${rawText.slice(0, 200)}`;
    // Operator 2026-05-28: 140043 transient race — backoff + retry within
    // this attempt loop instead of throwing to FSM FALLBACK (10s reset).
    const errCode = Array.isArray(errsField) ? errsField[0]?.error : undefined;
    const isTransientRace = TRANSIENT_RACE_RE.test(errMsg) || TRANSIENT_RACE_RE.test(String(errCode ?? ""));
    if (isTransientRace && attempt < 4) {
      const backoffMs = 200 * attempt;
      console.warn(`[fleet_api/sendFleet] attempt=${attempt} transient race (${errMsg.slice(0, 80)}) — backoff ${backoffMs}ms then retry`);
      if (json.newAjaxToken) {
        ctx.token.set(json.newAjaxToken);
        token = json.newAjaxToken;
        body = buildBody(p, token);
      }
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
      continue;
    }
    // 140028 storage overflow — strip cargo and retry with ships only.
    // Goal of FS save is to get ships off the planet; cargo is incidental.
    const isStorageOverflow = STORAGE_OVERFLOW_RE.test(errMsg) || STORAGE_OVERFLOW_RE.test(String(errCode ?? ""));
    if (isStorageOverflow && attempt < 4 && (p.cargo.m > 0 || p.cargo.c > 0 || p.cargo.d > 0)) {
      console.warn(`[fleet_api/sendFleet] attempt=${attempt} dest storage full (${errMsg.slice(0, 80)}) — strip cargo m/c/d and retry with ships only`);
      const strippedParams: SendFleetParams = { ...p, cargo: { m: 0, c: 0, d: 0 } };
      p = strippedParams;
      if (json.newAjaxToken) {
        ctx.token.set(json.newAjaxToken);
        token = json.newAjaxToken;
      }
      body = buildBody(p, token);
      continue;
    }
    throw new FleetApiError(errMsg, json);
  }
  throw new FleetApiError("retry exhausted");
}

interface RecallResponse {
  success: boolean;
  newAjaxToken?: string;
  message?: string;
}

export async function recallFleet(fleetId: number, ctx: SendFleetCtx): Promise<void> {
  // Operator 2026-05-28 "cp 的点击保护机制能不能一起保护 token": recall
  // POST rotates the global ajax token but goes through raw ctx.fetch
  // (no cp= injection). Wrap the whole recall sequence in
  // trackBackgroundOp so click_lock delays operator clicks for the
  // duration — just like cp= fetches.
  const { trackBackgroundOp } = await import("./safe_fetch.js");
  const releaseOp = trackBackgroundOp();
  try {
    return await recallFleetInner(fleetId, ctx);
  } finally {
    releaseOp();
  }
}

async function recallFleetInner(fleetId: number, ctx: SendFleetCtx): Promise<void> {
  let token = ctx.token.getFreshToken();
  // Operator 2026-05-28 evidence: recall POST returned success:false (no
  // errors, no message — just {success:false, components:[], newAjaxToken})
  // while fleet still in outbound. Both FSM-side and bridge-side calls
  // got same response. ogame transient — single retry with fresh token
  // recovered in similar cases (sendFleet 140043 pattern). Bumped 2→4.
  for (let attempt = 1; attempt <= 4; attempt++) {
    const body = new URLSearchParams();
    body.set("fleetId", String(fleetId));
    body.set("token", token);
    console.log(`[fleet_api/recallFleet] attempt=${attempt} POST ${RECALL_ENDPOINT} body=fleetId=${fleetId}&token=***`);
    const res = await ctx.fetch(RECALL_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Requested-With": "XMLHttpRequest",
      },
      body: body.toString(),
      credentials: "same-origin",
    });
    const rawText = await res.text();
    console.log(`[fleet_api/recallFleet] attempt=${attempt} HTTP ${res.status} raw[0:400]=${rawText.slice(0, 400)}`);
    if (!res.ok) throw new FleetApiError(`HTTP ${res.status}: ${rawText.slice(0, 200)}`);
    let json: RecallResponse;
    try { json = JSON.parse(rawText) as RecallResponse; }
    catch {
      // Operator 2026-05-27: recall POST returning non-JSON HTML means we hit
      // wrong endpoint (or ogame redirected to movement page). Surface raw.
      throw new FleetApiError(`non-JSON response (likely wrong endpoint): ${rawText.slice(0, 300)}`);
    }
    if (json.success) {
      if (json.newAjaxToken) ctx.token.set(json.newAjaxToken);
      return;
    }
    if (attempt === 1 && json.message && TOKEN_INVALID_RE.test(json.message)) {
      await ctx.token.invalidate();
      token = ctx.token.getFreshToken();
      continue;
    }
    // Surface full message + errors[] + raw — operator 2026-05-27 evidence:
    // recall POST fails silently with "recall failed" default. Need the real
    // ogame body to identify wrong endpoint/field-name.
    const errsField = (json as { errors?: Array<{ message?: string }> }).errors;
    const errMsg = json.message
      ?? (Array.isArray(errsField) && errsField[0]?.message)
      ?? `success=${json.success} raw=${rawText.slice(0, 200)}`;
    // Operator 2026-05-28: recall returning bare {success:false} (no message,
    // no error code) while fleet still flying = ogame transient state.
    // Retry with fresh token + backoff before throwing. attempt<4 enforced
    // by the outer loop bound.
    const bareFailure = !json.message && (!Array.isArray(errsField) || errsField.length === 0);
    if (bareFailure && attempt < 4) {
      const backoffMs = 250 * attempt;
      console.warn(`[fleet_api/recallFleet] attempt=${attempt} bare success=false — backoff ${backoffMs}ms then retry`);
      if (json.newAjaxToken) {
        ctx.token.set(json.newAjaxToken);
        token = json.newAjaxToken;
      }
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
      continue;
    }
    throw new FleetApiError(errMsg, json);
  }
}
