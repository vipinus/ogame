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
// v0.0.469: + 100001 + 未知错误 (operator 2026-05-30 "build naniteFactory 7
// ↳ rejected: error 100001 未知错误"). 100001 is ogame's catch-all "未知错
// 误" — it can be token desync, internal race, transient state mismatch.
// Treating as transient is safe: retry with backoff + fresh token refresh
// (cpPostWithRetry rotates newAjaxToken between attempts). If 4 retries all
// fail, falls through to caller. Most observed 100001 cases have resolved
// on attempt 2.
const TRANSIENT_RACE_RE = /140043|100001|請稍後再試|请稍后再试|稍後再試|未知的錯誤|未知的错误|try again later/i;
// Operator 2026-05-28: ogame 140028 "倉存容量不足!" — DEST-SIDE complement
// to case_decider.ts's source-side cargo sizing (commit c8d2ead, 2026-05-24:
// case_decider sizes cargo ≤ FLEET capacity using ship_cargo_capacity).
// case_decider can compute fleet capacity exactly (live harvest from
// expedition checkTarget), but has no visibility into dest planet/moon
// storage caps — especially moon storage which is small. So when ogame
// rejects with 140028 here, it means cargo ≤ fleet capacity but >
// dest storage cap. Self-heal: peel ONE resource per retry attempt in
// REVERSE of operator's priority (operator 2026-05-28: "优先装载重氢，
// 其次晶体，最后金属"). FS save's primary goal is ships off the planet;
// resource transport is secondary.
const STORAGE_OVERFLOW_RE = /140028|倉存容量不足|仓存容量不足|storage.*insufficient|insufficient.*storage/i;

/* ─────────────────────────────────────────────────────────────────────────
 * v0.0.438: cpPostWithRetry — generic cp-shift POST with 4-attempt retry,
 * TRANSIENT_RACE_RE / TOKEN_INVALID_RE handling, loud per-attempt logging.
 * Operator 2026-05-29 directive: "需要切cp的都改成 fleet_api.sendFleet 模式".
 * Every exec* in api_executor.ts that does fetchWithCpBypassBusy should
 * route through this so the retry / token-refresh / transient detection
 * lives in one place — mirrors what sendFleet does for fleet POSTs.
 * ───────────────────────────────────────────────────────────────────── */
export interface CpPostOptions {
  /** Full ogame URL (including page/component/action/ajax=1). */
  endpoint: string;
  /** Source planet/moon PID → cp= URL param + session-cp shift. */
  sourcePlanetId: string;
  /**
   * Token manager — default token source. cpPostWithRetry calls
   * `getFreshToken()` per attempt and `set(newAjaxToken)` on success.
   * OPTIONAL when `tokenProvider` is set (v0.0.557 extension for flows
   * that don't share the global fleet ajax token: jumpgate overlay
   * token, discover galaxy token cache, etc).
   */
  token?: TokenManager;
  /** Action label for logs. */
  action: string;
  /** "GET" for overlay fetches; "POST" (default) for everything else. */
  method?: "GET" | "POST";
  /** Body builder — called per attempt with the current token so retries
   *  pick up refreshed tokens. Return undefined for GET. */
  buildBody?: (token: string) => URLSearchParams | undefined;
  /** Max attempts; default 4 (mirrors sendFleet). */
  maxAttempts?: number;
  /** Pass-through to fetchWithCpBypassBusy. */
  skipRestore?: boolean;
  /**
   * v0.0.557 — Custom token provider. When set, REPLACES the default
   * `opts.token.getFreshToken()` initial fetch. Use for flows whose
   * token comes from a non-TokenManager source: jumpgate overlay HTML
   * scrape, discover galaxy chain cache (`__ogamexLastGalaxyToken`),
   * etc. Called once at the start of cpPostWithRetry; subsequent
   * iterations use the local `token` var (updated by newAjaxToken in
   * responses) UNLESS `refreshTokenOnInvalid` re-fires it.
   */
  tokenProvider?: () => Promise<string>;
  /**
   * v0.0.557 — Custom success-flag detector. When set, REPLACES the
   * default `success===true || status===true || status==="success"`
   * check. Use for endpoints that return data without a success flag
   * (galaxy fetchGalaxyContent returns `{token, system: {...}}` with
   * no top-level success). Return true → cpPostWithRetry treats as
   * success → captures newAjaxToken (if present + opts.token set) and
   * returns json+raw. Return false → falls into error/retry path.
   */
  successCheck?: (json: Record<string, unknown>) => boolean;
  /**
   * v0.0.557 — Custom token-refresh on TOKEN_INVALID. When set,
   * REPLACES the default `opts.token.invalidate() + getFreshToken()`
   * path. Use for flows whose token is refreshed by a domain-specific
   * step: re-GET overlay (jumpgate), re-fetch galaxy chunk (discover).
   * Called when attempt 1 hits TOKEN_INVALID_RE; the returned token
   * becomes the local `token` for attempt 2's buildBody.
   */
  refreshTokenOnInvalid?: () => Promise<string>;
}

export interface CpPostResult {
  /** Parsed JSON if response was JSON, else null. */
  json: Record<string, unknown> | null;
  /** Raw response text (also useful when response is HTML overlay). */
  raw: string;
  /** HTTP status code. */
  status: number;
}

export async function cpPostWithRetry(opts: CpPostOptions): Promise<CpPostResult> {
  const { fetchWithCpBypassBusy } = await import("./safe_fetch.js");
  const maxAttempts = opts.maxAttempts ?? 4;
  const method = opts.method ?? "POST";
  // v0.0.557 — token sourcing via tokenProvider OR opts.token. Caller
  // must supply at least one; both undefined is a programmer error.
  if (!opts.token && !opts.tokenProvider) {
    throw new FleetApiError(`${opts.action}: cpPostWithRetry needs opts.token (TokenManager) or opts.tokenProvider`);
  }
  const initialToken = opts.tokenProvider
    ? await opts.tokenProvider()
    : opts.token!.getFreshToken();
  let token = initialToken;
  let lastErrMsg = "";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const body = opts.buildBody ? opts.buildBody(token) : undefined;
    const bodyStr = body ? body.toString().replace(/token=[^&]+/, "token=***") : "<no body>";
    console.log(`[cpPost/${opts.action}] attempt=${attempt} ${method} ${opts.endpoint} cp=${opts.sourcePlanetId} body=${bodyStr}`);
    const requestInit: RequestInit = {
      method,
      credentials: "same-origin",
      headers: method === "POST"
        ? { "Content-Type": "application/x-www-form-urlencoded", "X-Requested-With": "XMLHttpRequest" }
        : { "X-Requested-With": "XMLHttpRequest" },
    };
    if (method === "POST" && body) requestInit.body = body;
    const r = await fetchWithCpBypassBusy(
      opts.endpoint,
      requestInit,
      opts.sourcePlanetId,
      opts.skipRestore === true ? { skipRestore: true } : {},
    );
    const raw = await r.text();
    let json: Record<string, unknown> | null;
    try { json = JSON.parse(raw) as Record<string, unknown>; } catch { json = null; }
    console.log(`[cpPost/${opts.action}] attempt=${attempt} HTTP ${r.status} json=${json ? JSON.stringify(json).slice(0, 200) : "<non-JSON>"} raw[0:200]=${raw.slice(0, 200)}`);
    // Non-JSON (overlay HTML etc) → return as-is to caller.
    if (!json) return { json: null, raw, status: r.status };
    // v0.0.555 — accept "status":"success" string form too (ogame v12
    // buildlistactions endpoint returns it instead of success:true boolean).
    // v0.0.557 — custom successCheck overrides default for endpoints without
    // a success flag (e.g. galaxy fetchGalaxyContent).
    const okFlag = opts.successCheck
      ? opts.successCheck(json)
      : (json["success"] === true || json["status"] === true || json["status"] === "success");
    if (okFlag) {
      const newToken = (json as { newAjaxToken?: unknown }).newAjaxToken;
      if (typeof newToken === "string" && opts.token) opts.token.set(newToken);
      return { json, raw, status: r.status };
    }
    const errsField = (json as { errors?: Array<{ message?: string }> }).errors;
    const errMsgRaw = (json as { message?: unknown }).message;
    const errMsg = (typeof errMsgRaw === "string" ? errMsgRaw : null)
      ?? (Array.isArray(errsField) && errsField[0]?.message)
      ?? `success=${json["success"]} raw=${raw.slice(0, 200)}`;
    lastErrMsg = errMsg;
    if (attempt === 1 && TOKEN_INVALID_RE.test(errMsg)) {
      // v0.0.557 — refreshTokenOnInvalid hook overrides default
      // TokenManager.invalidate+getFreshToken path. Use for domain-
      // specific refresh (re-GET overlay, re-fetch galaxy chunk).
      if (opts.refreshTokenOnInvalid) {
        token = await opts.refreshTokenOnInvalid();
      } else if (opts.token) {
        await opts.token.invalidate();
        token = opts.token.getFreshToken();
      }
      continue;
    }
    if (TRANSIENT_RACE_RE.test(errMsg) && attempt < maxAttempts) {
      const backoffMs = 200 * attempt;
      console.warn(`[cpPost/${opts.action}] attempt=${attempt} transient race (${errMsg.slice(0, 80)}) — backoff ${backoffMs}ms`);
      const newToken = (json as { newAjaxToken?: unknown }).newAjaxToken;
      if (typeof newToken === "string") {
        if (opts.token) opts.token.set(newToken);
        token = newToken;
      }
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
      continue;
    }
    // Non-transient failure → return json to caller; caller decides what to do.
    return { json, raw, status: r.status };
  }
  throw new FleetApiError(`${opts.action} failed after ${maxAttempts} attempts: ${lastErrMsg.slice(0, 200)}`);
}

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

// Operator 2026-05-29 evidence: two concurrent FSM sendFleet calls
// (cp=A then cp=B fired ~100ms apart on parallel spy events) race ogame's
// global session-cp. ogame's POST handler reads session-cp at response
// time, so the first POST's response was processed against the SECOND
// planet's session — yielding "沒有選擇艦船" (140042) on both. Serialize
// sendFleet at the module level so only one fleet POST is in flight at
// a time across emergency FSMs, GoalRunner-routed dispatches, and any
// other path. Recall path uses its own non-cp= endpoint; mutex not
// shared with recallFleet.
let sendFleetChain: Promise<unknown> = Promise.resolve();
async function acquireSendFleetSlot(): Promise<() => void> {
  const prev = sendFleetChain;
  let release!: () => void;
  sendFleetChain = new Promise<void>((resolve) => { release = resolve; });
  try { await prev; } catch { /* prior failure isn't ours to handle */ }
  return release;
}

export async function sendFleet(
  p: SendFleetParams,
  ctx: SendFleetCtx,
): Promise<SendFleetResult> {
  const release = await acquireSendFleetSlot();
  try {
    return await sendFleetInner(p, ctx);
  } finally {
    release();
  }
}

async function sendFleetInner(
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
    // v0.0.506 forensic — gated off in v0.0.508 (operator 2026-05-31 chrome
    // 崩, stuck-recovery 风暴时一波派 6-10 sendFleet → forensic POST 堆 → 助推
    // 浏览器内存压力)。 留 fleet-strip POST (罕见, 真有 strip 时才发) 跟
    // empire-dump (一次性). 这条 sendFleet-post 暂时 mute, 真要查再开。
    if (false as boolean) {
    try {
      const ctxWin = (typeof window !== "undefined" ? window : globalThis) as Window & { localStorage?: Storage };
      const bridgeBase = ctxWin.localStorage?.getItem("OGAMEX_BRIDGE_URL") ?? "https://ogame.anyfq.com";
      void fetch(`${bridgeBase.replace(/\/$/, "")}/ogamex/v1/debug/log`, {
        method: "POST", credentials: "omit", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tag: "sendFleet-post",
          text: `attempt=${attempt} cp=${sourcePID} dest=${p.coords.join(":")}(type=${p.destType}) mission=${p.mission} ships=${JSON.stringify(p.ships)} cargo=${JSON.stringify(p.cargo)}`,
        }),
      }).catch(() => {});
    } catch { /* */ }
    }
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
    // 140028 storage overflow — peel cargo in REVERSE of operator's
    // priority (operator 2026-05-28: "优先装载重氢，其次晶体，最后金属").
    // Drop metal first (lowest priority), then crystal, last deuterium
    // (highest priority — and also fuel + the fleet's escape oxygen).
    // Each strip retry gives ogame a fresh attempt with less cargo.
    const isStorageOverflow = STORAGE_OVERFLOW_RE.test(errMsg) || STORAGE_OVERFLOW_RE.test(String(errCode ?? ""));
    if (isStorageOverflow && attempt < 4 && (p.cargo.m > 0 || p.cargo.c > 0 || p.cargo.d > 0)) {
      const stripped = { ...p.cargo };
      let peeled = "";
      if (stripped.m > 0) {
        peeled = `metal (${stripped.m})`;
        stripped.m = 0;
      } else if (stripped.c > 0) {
        peeled = `crystal (${stripped.c})`;
        stripped.c = 0;
      } else if (stripped.d > 0) {
        peeled = `deuterium (${stripped.d}) — ships only`;
        stripped.d = 0;
      }
      console.warn(`[fleet_api/sendFleet] attempt=${attempt} dest storage full (${errMsg.slice(0, 80)}) — drop ${peeled} and retry`);
      // v0.0.503 — forward strip event to sidecar so journal can show it.
      // operator 2026-05-30 实证: 多次 transport 漏 m, console.warn 看不到,
      // 没人知道 silent strip 发生了。
      try {
        const ctxWin = (typeof window !== "undefined" ? window : globalThis) as Window & { localStorage?: Storage };
        const bridgeBase = ctxWin.localStorage?.getItem("OGAMEX_BRIDGE_URL") ?? "https://ogame.anyfq.com";
        void fetch(`${bridgeBase.replace(/\/$/, "")}/ogamex/v1/debug/log`, {
          method: "POST", credentials: "omit", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            tag: "fleet-strip",
            text: `attempt=${attempt} src=${p.sourcePlanetId} dest=${p.coords.join(":")}(type=${p.destType}) mission=${p.mission} dropped=${peeled} prev_cargo=${JSON.stringify(p.cargo)} new_cargo=${JSON.stringify(stripped)} ogame_err=${errMsg.slice(0, 120)}`,
          }),
        }).catch(() => {});
      } catch { /* */ }
      p = { ...p, cargo: stripped };
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
