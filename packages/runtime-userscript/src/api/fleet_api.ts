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
  const endpoint = ctx.endpoint ?? DEFAULT_ENDPOINT;
  let token = ctx.token.getFreshToken();
  let body = buildBody(p, token);

  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await ctx.fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Requested-With": "XMLHttpRequest",
      },
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
    if (json.success && json.fleetIdToReturn !== undefined) {
      if (json.newAjaxToken) ctx.token.set(json.newAjaxToken);
      return { fleetId: json.fleetIdToReturn, raw: json };
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
  let token = ctx.token.getFreshToken();
  for (let attempt = 1; attempt <= 2; attempt++) {
    const body = new URLSearchParams();
    body.set("fleetId", String(fleetId));
    body.set("token", token);
    const res = await ctx.fetch(RECALL_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Requested-With": "XMLHttpRequest",
      },
      body: body.toString(),
      credentials: "same-origin",
    });
    if (!res.ok) throw new FleetApiError(`HTTP ${res.status}`);
    const json = (await res.json()) as RecallResponse;
    if (json.success) {
      if (json.newAjaxToken) ctx.token.set(json.newAjaxToken);
      return;
    }
    if (attempt === 1 && json.message && TOKEN_INVALID_RE.test(json.message)) {
      await ctx.token.invalidate();
      token = ctx.token.getFreshToken();
      continue;
    }
    throw new FleetApiError(json.message ?? "recall failed", json);
  }
}
