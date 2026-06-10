/**
 * Floating in-page panel showing OgameX's active goals + cancel buttons.
 *
 * Renders into a fixed-position `<div id="ogamex-goals-panel">` overlaid on
 * the ogame page. Polls `GET /ogamex/v1/goals` every `pollMs` and re-renders
 * on change. Action buttons (cancel/pause/resume) hit
 * `POST /ogamex/v1/goals/<id>/<action>`. Paused goals are reported as
 * status="blocked" with reason starting with "PAUSED" — the panel detects
 * that and shows a Resume button instead of a Pause button.
 *
 * Operator HTTP endpoints are no-auth on the sidecar — same threat model
 * as the existing /v1/debug page.
 */
import { LIFEFORM_TECH } from "@ogamex/shared";
import { TECH_ID_BY_NAME } from "@ogamex/shared";
import { planTransportChain, makeTransportChainId, type PlannerPlanet } from "@ogamex/shared";
import { t } from "../i18n/t.js";
import { techName } from "../i18n/tech_name.js";
import { setVisibleInterval } from "../util/visible_interval.js";

// 2026-06-05 — module-level bridge-token reader. Used by every POST to a
// sidecar endpoint that needs per-user routing (createGoal, discovery
// create, expedition config, etc). Without the Authorization header,
// sidecar resolveBearer returns "legacy" and goals land on the env
// operator's uid instead of the actual web user's uid (eb990432 etc.).
// Symptom historic: web user adds goal in TM panel → PG ogame_goals
// has 0 rows for their uid → goal silently lost.
function readBridgeTok(injected?: string): string | null {
  if (injected) return injected;
  try {
    return (typeof window !== "undefined" ? window.localStorage.getItem("OGAMEX_BRIDGE_TOKEN") : null);
  } catch { return null; }
}
function authHeadersGlobal(extra: Record<string, string> = {}): Record<string, string> {
  const tok = readBridgeTok();
  return tok ? { ...extra, "Authorization": `Bearer ${tok}` } : extra;
}
import { getOgameLocaleWithOverride } from "../i18n/locale.js";

// v0.0.665 — operator 2026-06-02 "LF 建筑中文名不对" + "中文名称不是
// ogame 专有名词": handcrafted display_name_zh in shared/lifeform/*_tech.ts
// does NOT match ogame's actual TC labels (e.g. shared said "心靈網絡",
// ogame page shows "靈能網路"). techLabels[k] is harvested live from
// ogame's lfresearch/lfbuilding DOM via extractTechLabels — IT is the
// ogame TC ground truth. Prefer it when locale matches the server.
// EN mode: catalog display_name_en (handcrafted) since operator's
// ogame server is TC so DOM labels can't supply EN.
function pickLfName(
  v: { display_name_zh?: string; display_name_en?: string },
  k: string,
  techLabels?: Record<string, string>,
): string {
  // v0.0.768 — operator 2026-06-04 "TM 中文界面 混排德语": techLabels DOM
  // scrape 在切服 (DE → TW) 后旧标签残留, 中文 panel 显德语. 让
  // techName() 27-locale canonical dict 优先, ogameLabel 仅当 canonical
  // miss 时兜底; 这样 server switch 不再污染显示.
  const canonical = techName(k);
  if (canonical && canonical !== k) return canonical;
  const locale = getOgameLocaleWithOverride();
  const ogameLabel = techLabels?.[k];
  if (locale === "tw") {
    return ogameLabel ?? v.display_name_zh ?? v.display_name_en ?? k;
  }
  return v.display_name_en ?? ogameLabel ?? v.display_name_zh ?? k;
}

// v0.0.665 — operator 2026-06-02 "月球都不用翻译吗?": ogame moon.name
// defaults to server-localized "Moon"/"月球"/"Mond"/... and leaks raw
// into panel when panel toggles to a different locale. Detect known
// default moon names across ogame locales and substitute t("auto.118").
// If operator renamed the moon to a custom string, it falls through.
const KNOWN_DEFAULT_MOON_NAMES = new Set<string>([
  "Moon", "月球", "Mond", "Lune", "Luna", "Lua",
  "Księżyc", "Луна", "Ay", "Maan", "Måne", "月", "달", "Måni",
]);
function localizeMoonName(raw: string | undefined | null): string {
  if (!raw || KNOWN_DEFAULT_MOON_NAMES.has(raw)) return t("auto.118");
  return raw;
}


/** Prereq tree node — recursive structure mirroring TECH_TREE's `requires`
 *  graph for the player's main goal. Attached by sidecar listGoals only on
 *  the row flagged is_main_goal=true. */
export interface PrereqTreeNode {
  tech: string;
  targetLevel: number;
  currentLevel: number;
  kind: "research" | "building";
  met: boolean;
  children: PrereqTreeNode[];
  /** Seconds to complete this node alone (research time or build time). */
  eta_seconds?: number | null;
  /** Seconds to complete this node + all unmet descendants, serialized. */
  subtree_eta_seconds?: number;
  /** v0.0.791 — ogame queue label (R1/R2 research_q serial, B1/B2 build_q serial).
   *  DFS post-order = ogame "prereq 先 root 后" 真实执行序. operator 直击
   *  "建造和研究看不出先后顺序". */
  queue_label?: string;
}


export interface GoalRowFromHttp {
  /** Sidecar's listGoals enriches each row with this flag so the panel can
   *  show ⭐ on the row currently selected as the player's main objective. */
  is_main_goal?: boolean;
  /** v0.0.481 architecture B: parent-child sub-goal relationship. When set,
   *  this row renders nested under its parent and shares cascade-cancel. */
  parent_goal_id?: string;
  /** v0.0.483 — body's currently-active queue snapshot (any tech building on
   *  this goal's body, regardless of whether it serves this goal's target).
   *  Panel uses this as TOP-priority display override so "building lunarBase
   *  L7" shows for jumpgate L2 goal on same moon. */
  body_build_q?: { queue: "build" | "lf_build" | "shipyard"; tech: string; level: number | null; ends_at: number } | null;
  prereq_tree?: PrereqTreeNode | null;
  /** M5 — total resource cost across the entire prereq chain. */
  total_cost?: { m: number; c: number; d: number };
  /** M5 — max(0, total_cost - planet bank). What operator must still ship in. */
  resource_shortage?: { m: number; c: number; d: number };
  id: string;
  type: string;
  target: Record<string, unknown>;
  priority: number;
  status: "pending" | "active" | "blocked" | "completed" | "cancelled";
  reason?: string;
  planet?: string;
  created_at: number;
  updated_at: number;
  eta_at?: number | null;
  /** v0.0.460: event-triggered awaiting set from sidecar. Empty → ready to
   *  dispatch on next event. Non-empty → goal waits for one of these events
   *  (e.g. "empire_poll" arrives via state.snapshot, "operator_retry" via
   *  /v1/goals/{id}/resume). Rendered as ⏸ chip with hint. */
  awaiting_events?: string[];
  /** v0.0.461: deepest-leaf next-step cost + shortage. Tells operator what's
   *  blocking RIGHT NOW (vs total_cost which is the full chain). Rendered
   *  next to chain shortage chip. */
  current_step?: {
    tech: string;
    kind: "research" | "building";
    level: number;
    cost: { m: number; c: number; d: number };
    shortage: { m: number; c: number; d: number };
  } | null;
}

export interface GoalsPanelOptions {
  /** Base URL for sidecar HTTP. Default http://127.0.0.1:18791. */
  httpBaseUrl?: string;
  /** Poll interval. Default 3000ms. */
  pollMs?: number;
  /** Show terminal (completed/cancelled) goals too? Default false. */
  showTerminal?: boolean;
  /** Injectable fetch — tests stub via vi.fn. */
  fetch?: typeof fetch;
  /** Injectable doc — tests stub via jsdom. */
  doc?: Document;
  /** Bearer token for sidecar auth-required endpoints (pause/resume daemon, etc).
   *  Same as bridge token. main.ts reads via readConfig("OGAMEX_BRIDGE_TOKEN"). */
  bridgeToken?: string;
}

export interface GoalsPanelHandle {
  /** Force a refresh now. */
  refresh(): Promise<void>;
  /** Remove panel from DOM + halt polling. */
  stop(): void;
}

const PANEL_ID = "ogamex-goals-panel";
// 30% idle opacity — partly transparent so ogame stays visible behind
// the panel, fully opaque on hover. Adjusted from initial 20% per
// operator feedback (20 was too faint to read at a glance).
const PANEL_STYLE = `
  position: fixed; top: 80px; right: 12px; z-index: 99999;
  width: 320px; max-height: 60vh; overflow-y: auto;
  background: rgba(15, 20, 30, 0.92); color: #d8e0ec;
  border: 1px solid #2a3a52; border-radius: 6px;
  font-family: -apple-system, system-ui, "Helvetica Neue", sans-serif;
  font-size: 12px; padding: 8px;
  box-shadow: 0 4px 12px rgba(0,0,0,0.4);
  opacity: 0.30;
  transition: opacity 150ms ease-in-out;
`.replace(/\s+/g, " ").trim();

const PANEL_HOVER_CSS = `
  #ogamex-goals-panel:hover { opacity: 1 !important; }
`.trim();

// Operator 2026-05-29: semver compare for runtime update detection.
// Returns positive when a > b, negative when a < b, zero when equal.
// Forgiving — non-numeric segments compare lexicographically (e.g. dev tags).
function cmpSemver(a: string, b: string): number {
  const sa = a.split(".");
  const sb = b.split(".");
  const len = Math.max(sa.length, sb.length);
  for (let i = 0; i < len; i++) {
    const ax = sa[i] ?? "0";
    const bx = sb[i] ?? "0";
    const an = parseInt(ax, 10);
    const bn = parseInt(bx, 10);
    if (!isNaN(an) && !isNaN(bn) && an !== bn) return an - bn;
    if (ax !== bx) return ax < bx ? -1 : 1;
  }
  return 0;
}

// Operator 2026-05-29: per-feature settings modal infra.
// Each section (emergency/expedition/discovery/goals) gets its own ⚙️ button
// in the section header → opens a translucent fullscreen overlay with the
// feature's config controls. Modal is dismissed by clicking the backdrop,
// the × close button, or pressing Escape. Layout: fixed inset-0 backdrop
// (rgba 60% black) with a dark card centered inside.
function openSettingsModal(
  doc: Document,
  feature: string,
  title: string,
  bodyHTML: string,
  wireBody?: (modalEl: HTMLElement) => void,
): void {
  // Reject duplicate opens for the same feature — clicking ⚙️ twice should
  // not stack modals.
  const existingId = `ogamex-settings-modal-${feature}`;
  if (doc.getElementById(existingId)) return;
  const modal = doc.createElement("div");
  modal.id = existingId;
  modal.setAttribute("style", [
    "position:fixed", "inset:0", "z-index:1000000",
    "background:rgba(8,12,20,0.55)",
    "backdrop-filter:blur(2px)",
    "display:flex", "align-items:center", "justify-content:center",
    "font-family:Tahoma, Arial, sans-serif", "color:#d0d8e0",
  ].join(";"));
  modal.innerHTML = `
    <div role="dialog" aria-label="${escapeHtml(title)}" style="
      background:#0e1420; border:1px solid #2a3a52; border-radius:6px;
      min-width:360px; max-width:560px; max-height:80vh; overflow:auto;
      box-shadow:0 10px 40px rgba(0,0,0,0.6); padding:14px 16px;
    ">
      <div style="display:flex; justify-content:space-between; align-items:center; padding-bottom:10px; border-bottom:1px solid #2a3a52;">
        <strong style="color:#e0e8f0; font-size:13px;">${escapeHtml(title)}</strong>
        <button data-modal-close="1" style="background:transparent; color:#8090a8; border:none; cursor:pointer; font-size:18px; line-height:1; padding:0 4px;" title="Close">×</button>
      </div>
      <div style="padding-top:10px; font-size:12px; line-height:1.5;">
        ${bodyHTML}
      </div>
    </div>
  `;
  doc.body.appendChild(modal);
  const close = (): void => { modal.remove(); doc.removeEventListener("keydown", onEsc); };
  const onEsc = (e: KeyboardEvent): void => { if (e.key === "Escape") close(); };
  doc.addEventListener("keydown", onEsc);
  // Backdrop click (but not card click) closes.
  modal.addEventListener("click", (e) => { if (e.target === modal) close(); });
  modal.querySelector<HTMLElement>("[data-modal-close]")?.addEventListener("click", close);
  if (wireBody) wireBody(modal);
}

function renderToggleRow(label: string, isOn: boolean, dataAttr: string, hint?: string): string {
  const onStyle = "background:#205a20; color:#fff; border:1px solid #408a40;";
  const offStyle = "background:#5a2020; color:#fff; border:1px solid #8a4040;";
  const btnStyleS = `padding:2px 10px; border-radius:3px; cursor:pointer; font-size:11px; font-weight:bold;`;
  return `<div style="padding:8px 0; border-bottom:1px solid #1a2030; display:flex; justify-content:space-between; align-items:center;">
    <span>
      <div style="color:#d0d8e0;">${escapeHtml(label)}</div>
      ${hint ? `<div style="color:#7080a0; font-size:10px; margin-top:2px;">${escapeHtml(hint)}</div>` : ""}
    </span>
    <button data-${dataAttr}="1" style="${btnStyleS}${isOn ? onStyle : offStyle}">${isOn ? "ON" : "OFF"}</button>
  </div>`;
}

function openEmergencySettings(doc: Document): void {
  const lsGet = (k: string): string | null => { try { return window.localStorage.getItem(k); } catch { return null; } };
  const lsSet = (k: string, v: string): void => { try { window.localStorage.setItem(k, v); } catch { /* */ } };
  // Read current values.
  const paused = lsGet("ogamex.emergency.paused") === "true";
  const spyOn = lsGet("OGAMEX_SPY_TRIGGERS_SAVE") !== "off";  // default ON
  // v0.0.764 — operator 2026-06-04 "两边紧急任务里面都添加声音警报开关".
  const soundOn = lsGet("OGAMEX_EMERGENCY_SOUND_ALARM") !== "off"; // default ON
  const bodyHTML = `
    <div style="color:#7080a0; font-size:11px; padding-bottom:6px;">${escapeHtml(t('auto.181'))}</div>
    ${renderToggleRow(t("auto.103"), !paused, "em-paused", t("auto.104"))}
    ${renderToggleRow(t("auto.105"), spyOn, "em-spy", t("auto.106"))}
    ${renderToggleRow("🔔 声音警报", soundOn, "em-sound", "hostile incoming 检测到时播放警报声 (跟 flagship 网页同步)")}
    <div style="color:#5a7090; font-size:10px; padding-top:10px;">${escapeHtml(t('auto.182'))}</div>
  `;
  openSettingsModal(doc, "emergency", t("modal.emergency.title"), bodyHTML, (m) => {
    const reflect = (sel: string, isOn: boolean): void => {
      const btn = m.querySelector<HTMLElement>(sel);
      if (!btn) return;
      btn.textContent = isOn ? "ON" : "OFF";
      btn.setAttribute("style", `padding:2px 10px; border-radius:3px; cursor:pointer; font-size:11px; font-weight:bold;${isOn
        ? "background:#205a20; color:#fff; border:1px solid #408a40;"
        : "background:#5a2020; color:#fff; border:1px solid #8a4040;"}`);
    };
    // S4 — operator 2026-06-04 "全做" — POST toggle to PG for cross-device sync.
    const syncToPg = (key: string, value: string): void => {
      try {
        const baseUrl = (window as Window & { __OGAMEX_BRIDGE_URL_RUNTIME?: string }).__OGAMEX_BRIDGE_URL_RUNTIME
          ?? "https://ogame.anyfq.com";
        const tok = lsGet("OGAMEX_BRIDGE_TOKEN") ?? "";
        if (!tok) return;
        void fetch(`${baseUrl}/ogamex/v1/section-settings`, {
          method: "POST",
          headers: { "content-type": "application/json", "authorization": `Bearer ${tok}` },
          body: JSON.stringify({ [key]: value }),
        }).catch(() => { /* sync best-effort */ });
      } catch { /* */ }
    };
    m.querySelector<HTMLElement>("[data-em-paused]")?.addEventListener("click", () => {
      const next = !(lsGet("ogamex.emergency.paused") === "true");  // toggle the paused-flag → enabled-flag
      const v = next ? "false" : "true";
      lsSet("ogamex.emergency.paused", v);
      syncToPg("ogamex.emergency.paused", v);
      reflect("[data-em-paused]", next);
    });
    m.querySelector<HTMLElement>("[data-em-spy]")?.addEventListener("click", () => {
      const cur = lsGet("OGAMEX_SPY_TRIGGERS_SAVE") !== "off";
      const next = !cur;
      const v = next ? "on" : "off";
      lsSet("OGAMEX_SPY_TRIGGERS_SAVE", v);
      syncToPg("OGAMEX_SPY_TRIGGERS_SAVE", v);
      (window as Window & { __ogamexSpyTriggersSave?: boolean }).__ogamexSpyTriggersSave = next;
      reflect("[data-em-spy]", next);
    });
    m.querySelector<HTMLElement>("[data-em-sound]")?.addEventListener("click", () => {
      const cur = lsGet("OGAMEX_EMERGENCY_SOUND_ALARM") !== "off";
      const next = !cur;
      const v = next ? "on" : "off";
      lsSet("OGAMEX_EMERGENCY_SOUND_ALARM", v);
      syncToPg("OGAMEX_EMERGENCY_SOUND_ALARM", v);
      reflect("[data-em-sound]", next);
      // 试听一次反馈
      if (next) {
        try {
          const audio = new Audio("data:audio/wav;base64,UklGRl9vT19XQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQA=");
          audio.volume = 0.4;
          void audio.play().catch(() => { /* */ });
        } catch { /* */ }
      }
    });
  });
}

// M2 — expedition settings modal. Reads the on-disk config via sidecar
// `GET /v1/expedition/config` and writes back via POST. Now split into two
// v0.0.937 — owner 2026-06-07 "取消TM 标题栏的折叠和审计, 删除tm里对应的代码":
// openAuditModal 函数整段删除. 📋 按钮跟 handler 都已删, 不再有调用者.

// tabs (operator 2026-05-29: "改成兩個 tab"): t("auto.121") (per-planet
// checkboxes for opt-in source pool) and t("auto.122") (per-ship-type number
// inputs). Target-position removed (always G:S:16). Paused toggle is
// global, lives above the tabs.
function openExpeditionSettings(
  doc: Document,
  baseUrl: string,
  fetchFn: typeof fetch,
): void {
  // Full ship roster (ogame v12 SHIP_IDS, ascending tid). solarSatellite
  // (212) + crawler (217) are stationary — excluded. pathfinder/explorer
  // share tid 219; only `explorer` (canonical v12 name) is exposed.
  const SHIP_FIELDS: Array<{ key: string; label: string }> = [
    { key: "smallCargo",     label: t("auto.107") },
    { key: "largeCargo",     label: t("auto.108") },
    { key: "lightFighter",   label: t("auto.109") },
    { key: "heavyFighter",   label: t("auto.110") },
    { key: "cruiser",        label: t("auto.111") },
    { key: "battleship",     label: t("auto.001") },
    { key: "colonyShip",     label: t("auto.112") },
    { key: "recycler",       label: t("auto.113") },
    { key: "espionageProbe", label: t("auto.114") },
    { key: "bomber",         label: t("auto.002") },
    { key: "destroyer",      label: t("auto.003") },
    { key: "deathstar",      label: t("auto.115") },
    { key: "battlecruiser",  label: t("auto.004") },
    { key: "reaper",         label: t("auto.116") },
    { key: "explorer",       label: t("auto.117") },
  ];
  const placeholder = `<div style="color:#7080a0; padding:8px 0;">loading expedition config…</div>`;
  openSettingsModal(doc, "expedition", t("modal.expedition.title"), placeholder, async (m) => {
    const body = m.querySelector<HTMLElement>("div[role='dialog'] > div:nth-of-type(2)");
    if (!body) return;
    let initial: { template?: Record<string, number>; paused?: boolean; enabled?: boolean; enabled_planets?: string[]; auto_build_ships?: boolean } = {};
    try {
      // v0.0.845 — operator 2026-06-06 "新账号的远征设置存不住": GET 老逻辑
      // 没带 Bearer → sidecar uid=undefined → 读 legacy 主号文件 (per-uid POST
      // 写的新号文件读不到). 同 fetchExpedition/fetchEmergency 修同款.
      // v0.0.855 — operator 2026-06-06 "新账号 远征舰队设置显示不了以前保持的
      // 舰队设置": 845 用了 `authHeaders` 但这个 helper 是 startGoalsPanel 闭包
      // 内变量, openExpeditionSettings 是 module-level fn 拿不到 → ReferenceError
      // 被 try/catch 吞 → initial={} → 渲染空. rollup TS plugin 不 fail TS error
      // 所以 dist 静默出错. 改用 module-level `authHeadersGlobal` (同 localStorage
      // 兜底, save/POST L697 用的就是它).
      const r = await fetchFn(`${baseUrl}/ogamex/v1/expedition/config`, { method: "GET", headers: authHeadersGlobal() });
      if (r.ok) initial = await r.json();
    } catch (e) { console.warn("[panel/expedition-settings] GET failed:", e); }
    // Pull live planet+moon list from the frontend store. Operator 2026-05-29:
    // "加上月球列" — moons (mission=15 from a moon is legal in ogame v12)
    // get their own column next to the parent planet. Both checkboxes write
    // into the same `enabled_planets` array (id, type-agnostic).
    interface StorePlanet { id: string; type?: string; coords?: number[]; name?: string }
    const storeRef = (window as Window & { __ogamexStore?: { state?: { planets?: Record<string, StorePlanet> } } }).__ogamexStore;
    const planetMap = storeRef?.state?.planets ?? {};
    // Group by coord-string so planet + sibling moon render on the same row.
    const groupedByCoord = new Map<string, { planet?: StorePlanet; moon?: StorePlanet }>();
    for (const p of Object.values(planetMap)) {
      const coords = p?.coords;
      if (!Array.isArray(coords) || coords.length !== 3) continue;
      const key = coords.join(":");
      const slot = groupedByCoord.get(key) ?? {};
      if (p.type === "moon") slot.moon = p;
      else slot.planet = p;
      groupedByCoord.set(key, slot);
    }
    const sortedCoordKeys = [...groupedByCoord.keys()].sort((a, b) => {
      const an = a.split(":").map((s) => parseInt(s, 10));
      const bn = b.split(":").map((s) => parseInt(s, 10));
      for (let i = 0; i < 3; i++) {
        const av = an[i] ?? 0;
        const bv = bn[i] ?? 0;
        if (av !== bv) return av - bv;
      }
      return 0;
    });
    const paused = initial.paused === true;
    const tmpl = (initial.template ?? {}) as Record<string, number>;
    // Operator 2026-05-29: align with daemon — `if (cfg.enabled_planets.length
    // > 0)` means an empty array OR a missing field both disable the filter
    // and let every planet through. UI mirrors that: a "blank" config shows
    // every checkbox as ✓ on (matches what's actually running). Only a non-
    // empty array makes the unchecked entries truly excluded.
    const rawEnabled = Array.isArray(initial.enabled_planets) ? initial.enabled_planets : null;
    const allEnabledFallback = rawEnabled === null || rawEnabled.length === 0;
    const isPlanetEnabled = (pid: string): boolean => (allEnabledFallback ? true : rawEnabled!.includes(pid));
    const inputStyle = "background:#0a1018; color:#e0e8f0; border:1px solid #2a3a52; border-radius:3px; padding:3px 6px; width:90px; font-size:11px; text-align:right;";
    const tabBtn = (key: string, label: string, active: boolean): string =>
      `<button data-exp-tab="${escapeHtml(key)}" style="background:${active ? "#1a2840" : "transparent"}; color:${active ? "#e0e8f0" : "#7080a0"}; border:1px solid ${active ? "#2a3a52" : "transparent"}; border-bottom:none; padding:6px 14px; cursor:pointer; font-size:11px; border-radius:4px 4px 0 0;">${escapeHtml(label)}</button>`;
    // Two-column row layout: planet checkbox | moon checkbox per coord.
    // Coord shown once on the left so operator can scan G:S:P quickly.
    const cellStyle = "flex:1; display:flex; align-items:center; gap:6px; font-size:11px; color:#d0d8e0;";
    const emptyCell = `<span style="${cellStyle} color:#3a4658; font-style:italic;">—</span>`;
    const renderCheckbox = (p: StorePlanet, icon: string): string => {
      const checked = isPlanetEnabled(p.id);
      // v0.0.666 — operator screenshot showed "🌙 月球" leaked in expedition
      // pane even after v0.0.665. p.name comes through verbatim when set; ??
      // only fired when null. Route moons through localizeMoonName so
      // server-default TC/DE/FR moon names get substituted in EN mode.
      const name = p.type === "moon"
        ? localizeMoonName(p.name)
        : (p.name ?? t("auto.119"));
      return `<label style="${cellStyle} cursor:pointer;">
        <input data-exp-planet="${escapeHtml(p.id)}" type="checkbox" ${checked ? "checked" : ""} style="vertical-align:middle;"/>
        <span>${icon} ${escapeHtml(name)}</span>
      </label>`;
    };
    const planetRows = sortedCoordKeys.length === 0
      ? t("auto.005")
      : t("auto.006") + sortedCoordKeys.map((k) => {
          const { planet, moon } = groupedByCoord.get(k)!;
          return `<div style="padding:5px 0; border-bottom:1px solid #1a2030; display:flex; gap:8px; align-items:center;">
            <span style="width:78px; color:#7080a0; font-size:11px;">[${escapeHtml(k)}]</span>
            ${planet ? renderCheckbox(planet, "🌍") : emptyCell}
            ${moon   ? renderCheckbox(moon,   "🌙") : emptyCell}
          </div>`;
        }).join("");
    const shipRows = SHIP_FIELDS.map((f) => {
      const cur = tmpl[f.key] ?? 0;
      // Operator 2026-05-29: ogame jumpgate UX — clicking the input
      // selects all so typing replaces (no backspace needed).
      // Both onclick and onfocus to cover keyboard tab-in too.
      return `<div style="padding:6px 0; border-bottom:1px solid #1a2030; display:flex; justify-content:space-between; align-items:center;">
        <span style="color:#d0d8e0;">${escapeHtml(f.label)}</span>
        <input data-tmpl-key="${escapeHtml(f.key)}" data-tmpl-label="${escapeHtml(f.label)}" type="number" min="0" step="1" value="${escapeHtml(String(cur))}" onclick="this.select()" onfocus="this.select()" style="${inputStyle}"/>
      </div>`;
    }).join("");
    body.innerHTML = `
      <div style="color:#7080a0; font-size:11px; padding-bottom:6px;">${escapeHtml(t('auto.183'))}</div>
      ${renderToggleRow(t("auto.103"), !paused, "exp-paused", t("auto.120"))}
      <div style="padding-top:10px; display:flex; gap:0; border-bottom:1px solid #2a3a52;">
        ${tabBtn("planets", t("auto.121"), true)}
        ${tabBtn("template", t("auto.122"), false)}
      </div>
      <div data-exp-pane="planets" style="display:block; padding-top:8px;">
        <div style="display:flex; justify-content:space-between; padding:4px 0; font-size:10px;">
          <span style="color:#7080a0;">${escapeHtml(t('auto.208'))}</span>
          <span>
            <button data-exp-planet-all="1" style="background:transparent; color:#7cfc00; border:none; cursor:pointer; font-size:10px; padding:0 4px;">${escapeHtml(t('auto.228'))}</button>
            <button data-exp-planet-none="1" style="background:transparent; color:#ff9b9b; border:none; cursor:pointer; font-size:10px; padding:0 4px;">${escapeHtml(t('auto.229'))}</button>
          </span>
        </div>
        ${planetRows}
      </div>
      <div data-exp-pane="template" style="display:none; padding-top:8px;">
        <!-- Operator 2026-05-29: 頂部 chips summary 顯示當前艦隊組成,
             跟着 input 變化實時更新. 無船時顯 placeholder. -->
        <div style="padding:6px 8px; background:#0a1018; border:1px solid #2a3a52; border-radius:4px; margin-bottom:8px;">
          <div style="color:#7080a0; font-size:10px; padding-bottom:4px;">${escapeHtml(t('auto.205'))}</div>
          <div data-exp-fleet-summary style="display:flex; flex-wrap:wrap; gap:6px; min-height:18px;"></div>
          <div data-exp-fleet-total style="color:#7080a0; font-size:10px; padding-top:6px; text-align:right;"></div>
        </div>
        ${renderToggleRow(t("auto.123"), initial.auto_build_ships === true, "exp-autobuild", t("auto.124"))}
        <div style="color:#7080a0; font-size:10px; padding-bottom:4px;">${escapeHtml(t('auto.206'))}</div>
        <!-- Operator 2026-05-29: 改成兩列 — grid 自動按行填充, 高度對半 -->
        <div style="display:grid; grid-template-columns:1fr 1fr; column-gap:14px;">${shipRows}</div>
      </div>
      <div style="display:flex; justify-content:flex-end; gap:8px; padding-top:12px;">
        <span data-exp-status style="color:#7080a0; font-size:10px; align-self:center;"></span>
        <button data-exp-save="1" style="background:#205a20; color:#fff; border:1px solid #408a40; padding:4px 14px; border-radius:3px; cursor:pointer; font-size:11px;">${escapeHtml(t('auto.230'))}</button>
      </div>
    `;
    // Operator 2026-05-29: live "current fleet composition" summary chips at
    // the top of the template tab. Updates on every input event so operator
    // sees the build before pressing 保存.
    const fmtNum = (n: number): string => n.toLocaleString("en-US");
    const updateFleetSummary = (): void => {
      const summary = m.querySelector<HTMLElement>("[data-exp-fleet-summary]");
      const total = m.querySelector<HTMLElement>("[data-exp-fleet-total]");
      if (!summary || !total) return;
      const chips: string[] = [];
      let totalShips = 0;
      for (const inp of m.querySelectorAll<HTMLInputElement>("[data-tmpl-key]")) {
        const n = parseInt(inp.value, 10);
        if (!Number.isFinite(n) || n <= 0) continue;
        const label = inp.getAttribute("data-tmpl-label") ?? inp.getAttribute("data-tmpl-key") ?? "?";
        totalShips += n;
        chips.push(`<span style="background:#1a2840; color:#d0d8e0; border:1px solid #2a3a52; border-radius:3px; padding:2px 8px; font-size:11px;">${escapeHtml(label)} × ${escapeHtml(fmtNum(n))}</span>`);
      }
      summary.innerHTML = chips.length === 0
        ? t("auto.007")
        : chips.join("");
      total.textContent = totalShips > 0 ? t("auto.155", { n: fmtNum(totalShips) }) : "";
    };
    for (const inp of m.querySelectorAll<HTMLInputElement>("[data-tmpl-key]")) {
      inp.addEventListener("input", updateFleetSummary);
    }
    updateFleetSummary();
    // Tab switching.
    const switchTab = (key: string): void => {
      m.querySelectorAll<HTMLElement>("[data-exp-tab]").forEach((b) => {
        const active = b.getAttribute("data-exp-tab") === key;
        b.style.background = active ? "#1a2840" : "transparent";
        b.style.color = active ? "#e0e8f0" : "#7080a0";
        b.style.borderColor = active ? "#2a3a52" : "transparent";
        b.style.borderBottomColor = "transparent";
      });
      m.querySelectorAll<HTMLElement>("[data-exp-pane]").forEach((p) => {
        p.style.display = p.getAttribute("data-exp-pane") === key ? "block" : "none";
      });
    };
    m.querySelectorAll<HTMLElement>("[data-exp-tab]").forEach((b) => {
      b.addEventListener("click", () => { switchTab(b.getAttribute("data-exp-tab") ?? "planets"); });
    });
    // ${escapeHtml(t('auto.228'))} / ${escapeHtml(t('auto.229'))} helpers.
    m.querySelector<HTMLElement>("[data-exp-planet-all]")?.addEventListener("click", () => {
      m.querySelectorAll<HTMLInputElement>("[data-exp-planet]").forEach((cb) => { cb.checked = true; });
    });
    m.querySelector<HTMLElement>("[data-exp-planet-none]")?.addEventListener("click", () => {
      m.querySelectorAll<HTMLInputElement>("[data-exp-planet]").forEach((cb) => { cb.checked = false; });
    });
    // Paused toggle (immediate, no save needed).
    let liveExpPaused = paused;
    const reflectPaused = (isOn: boolean): void => {
      const btn = m.querySelector<HTMLElement>("[data-exp-paused]");
      if (!btn) return;
      btn.textContent = isOn ? "ON" : "OFF";
      btn.setAttribute("style", `padding:2px 10px; border-radius:3px; cursor:pointer; font-size:11px; font-weight:bold;${isOn
        ? "background:#205a20; color:#fff; border:1px solid #408a40;"
        : "background:#5a2020; color:#fff; border:1px solid #8a4040;"}`);
    };
    m.querySelector<HTMLElement>("[data-exp-paused]")?.addEventListener("click", async () => {
      const nextEnabled = liveExpPaused;  // current ON (paused=false) → click → OFF (paused=true)
      liveExpPaused = !nextEnabled;
      reflectPaused(nextEnabled);
      try {
        await fetchFn(`${baseUrl}/ogamex/v1/expedition/${liveExpPaused ? "pause" : "resume"}`, { method: "POST", headers: authHeadersGlobal() });
      } catch (e) { console.warn("[panel/expedition-settings] pause/resume failed:", e); }
    });
    // Auto-build toggle (saved with main 保存 button — no instant POST since
    // the daemon reads it on next tick anyway, and bundling with save is the
    // standard pattern for the template tab).
    let liveAutoBuild = initial.auto_build_ships === true;
    const reflectAutoBuild = (isOn: boolean): void => {
      const btn = m.querySelector<HTMLElement>("[data-exp-autobuild]");
      if (!btn) return;
      btn.textContent = isOn ? "ON" : "OFF";
      btn.setAttribute("style", `padding:2px 10px; border-radius:3px; cursor:pointer; font-size:11px; font-weight:bold;${isOn
        ? "background:#205a20; color:#fff; border:1px solid #408a40;"
        : "background:#5a2020; color:#fff; border:1px solid #8a4040;"}`);
    };
    m.querySelector<HTMLElement>("[data-exp-autobuild]")?.addEventListener("click", () => {
      liveAutoBuild = !liveAutoBuild;
      reflectAutoBuild(liveAutoBuild);
    });
    // Save: POST template + enabled_planets (paused handled by toggle).
    m.querySelector<HTMLElement>("[data-exp-save]")?.addEventListener("click", async () => {
      const status = m.querySelector<HTMLElement>("[data-exp-status]");
      const template: Record<string, number> = {};
      for (const inp of m.querySelectorAll<HTMLInputElement>("[data-tmpl-key]")) {
        const key = inp.getAttribute("data-tmpl-key") ?? "";
        const n = parseInt(inp.value, 10);
        if (!key || !Number.isFinite(n) || n < 0) continue;
        if (n > 0) template[key] = n;
      }
      const enabled_planets: string[] = [];
      for (const cb of m.querySelectorAll<HTMLInputElement>("[data-exp-planet]")) {
        if (cb.checked) enabled_planets.push(cb.getAttribute("data-exp-planet") ?? "");
      }
      if (status) { status.textContent = "saving…"; status.style.color = "#7080a0"; }
      try {
        const r = await fetchFn(`${baseUrl}/ogamex/v1/expedition/config`, {
          method: "POST",
          headers: authHeadersGlobal({ "Content-Type": "application/json" }),
          body: JSON.stringify({ template, enabled_planets, auto_build_ships: liveAutoBuild }),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        if (status) { status.textContent = "✓ saved"; status.style.color = "#7cfc00"; }
        setTimeout(() => m.remove(), 600);
      } catch (e) {
        if (status) { status.textContent = `× ${(e as Error).message}`; status.style.color = "#ff6b6b"; }
      }
    });
  });
}

// M3 — discovery settings modal. Mirrors the existing panel inline UI
// (planet dropdown + range input + Start) into the modal layout and adds a
// live status block + Stop button when an active species_discovery goal
// already exists. Posts to /v1/discovery/create on save and to
// /v1/goals/<id>/cancel for Stop.
function openDiscoverySettings(
  doc: Document,
  baseUrl: string,
  fetchFn: typeof fetch,
): void {
  const placeholder = `<div style="color:#7080a0; padding:8px 0;">loading discovery state…</div>`;
  openSettingsModal(doc, "discovery", t("auto.008"), placeholder, async (m) => {
    const body = m.querySelector<HTMLElement>("div[role='dialog'] > div:nth-of-type(2)");
    if (!body) return;
    // Pull goals list (active species_discovery only) + planet list.
    type ActiveGoal = { id: string; planet?: string; target?: { source_planet?: string; galaxy?: number; base_system?: number; range?: number; completed?: string[] }; status?: string; progress_pct?: number; current_step?: string };
    let activeGoal: ActiveGoal | null = null;
    try {
      const r = await fetchFn(`${baseUrl}/ogamex/v1/goals`, { method: "GET" });
      if (r.ok) {
        const json = await r.json() as { goals?: unknown[] } | unknown[];
        const list = (Array.isArray(json) ? json : json.goals ?? []) as Array<ActiveGoal & { type?: string }>;
        activeGoal = list.find((g) => g?.type === "species_discovery" && !["completed", "cancelled"].includes(String(g.status ?? ""))) ?? null;
      }
    } catch (e) { console.warn("[panel/discovery-settings] goals GET failed:", e); }
    interface StorePlanet { id: string; type?: string; coords?: number[]; name?: string }
    const storeRef = (window as Window & { __ogamexStore?: { state?: { planets?: Record<string, StorePlanet> } } }).__ogamexStore;
    const planets = Object.values(storeRef?.state?.planets ?? {})
      .filter((p): p is StorePlanet => p?.type === "planet")
      .sort((a, b) => {
        const ac = a.coords ?? [0, 0, 0]; const bc = b.coords ?? [0, 0, 0];
        for (let i = 0; i < 3; i++) {
          const av = ac[i] ?? 0; const bv = bc[i] ?? 0;
          if (av !== bv) return av - bv;
        }
        return 0;
      });
    const inputStyle = "background:#0a1018; color:#e0e8f0; border:1px solid #2a3a52; border-radius:3px; padding:3px 6px; font-size:11px;";
    // Status block (when goal is active). Operator 2026-05-29: 來源星球
    // 顯示坐標 (+ name), 不要 internal planet id.
    let statusHTML = "";
    if (activeGoal) {
      const tgt = activeGoal.target ?? {};
      const completedCount = Array.isArray(tgt.completed) ? tgt.completed.length : 0;
      const total = ((tgt.range ?? 10) * 2 + 1) * 15;
      const pct = total > 0 ? Math.floor((completedCount / total) * 100) : 0;
      const srcId = String(tgt.source_planet ?? activeGoal.planet ?? "");
      const srcPlanet = srcId ? (storeRef?.state?.planets?.[srcId] ?? null) : null;
      const srcDisplay = srcPlanet?.coords
        ? `${srcPlanet.name ?? t("auto.119")} [${srcPlanet.coords.join(":")}]`
        : (srcId || "?");
      statusHTML = `<div style="padding:8px 10px; background:#0a1018; border:1px solid #2a3a52; border-radius:4px; margin-bottom:10px;">
        <div style="color:#7080a0; font-size:10px; padding-bottom:4px;">${escapeHtml(t('auto.204'))}</div>
        <div style="color:#d0d8e0; font-size:11px;">
          <div>★ ${escapeHtml(t('auto.231'))}: <span style="color:#c080ff;">${escapeHtml(srcDisplay)}</span></div>
          <div>★ ${escapeHtml(t('auto.232'))}: <span style="color:#c080ff;">${escapeHtml(String(tgt.galaxy ?? "?"))}:${escapeHtml(String(tgt.base_system ?? "?"))}</span> · 半徑 ${escapeHtml(String(tgt.range ?? 10))}</div>
          <div>★ ${escapeHtml(t('auto.233'))}: ${completedCount} / ${total} (${pct}%)</div>
          <div>★ ${escapeHtml(t('auto.234'))}: ${escapeHtml(String(activeGoal.current_step ?? "—"))}</div>
        </div>
        <div style="display:flex; justify-content:flex-end; padding-top:8px;">
          <button data-disc-stop="1" data-disc-goal-id="${escapeHtml(activeGoal.id)}" style="background:#5a2020; color:#fff; border:1px solid #8a4040; padding:3px 12px; border-radius:3px; cursor:pointer; font-size:11px;">${escapeHtml(t('auto.235'))}</button>
        </div>
      </div>`;
    }
    const planetOpts = planets.map((p) => {
      const cs = (p.coords ?? []).join(":");
      return `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name ?? t("auto.119"))} [${escapeHtml(cs)}]</option>`;
    }).join("");
    body.innerHTML = `
      <div style="color:#7080a0; font-size:11px; padding-bottom:6px;">${escapeHtml(t('auto.184'))}</div>
      ${statusHTML}
      <div style="padding:8px 10px; background:#0a1018; border:1px solid #2a3a52; border-radius:4px;">
        <div style="color:#7080a0; font-size:10px; padding-bottom:6px;">${activeGoal ? t("auto.125") : t("auto.126")}</div>
        <div style="display:flex; gap:8px; align-items:center; padding:6px 0;">
          <span style="color:#d0d8e0; font-size:11px; width:80px;">${escapeHtml(t('auto.202'))}</span>
          <select data-disc-planet style="${inputStyle} flex:1;">${planetOpts || `<option value="">${escapeHtml(t('auto.236'))}</option>`}</select>
        </div>
        <div style="display:flex; gap:8px; align-items:center; padding:6px 0;">
          <span style="color:#d0d8e0; font-size:11px; width:80px;">${escapeHtml(t('auto.203'))}</span>
          <input data-disc-range type="number" min="1" max="20" value="${escapeHtml(String(activeGoal?.target?.range ?? 10))}" onclick="this.select()" style="${inputStyle} width:80px;"/>
          <span style="color:#7080a0; font-size:10px;">${escapeHtml(t('auto.207'))}</span>
        </div>
        <div style="display:flex; justify-content:flex-end; gap:8px; padding-top:8px;">
          <span data-disc-status style="color:#7080a0; font-size:10px; align-self:center;"></span>
          <button data-disc-start="1" style="background:#205a20; color:#fff; border:1px solid #408a40; padding:4px 14px; border-radius:3px; cursor:pointer; font-size:11px;">Start Discovery</button>
        </div>
      </div>
    `;
    // v0.0.688 — operator 2026-06-03 "发现任务星球选择器默认为当前星球".
    {
      const ogameCurrentPid = doc.querySelector<HTMLMetaElement>('meta[name="ogame-planet-id"]')?.content ?? "";
      const sel = m.querySelector<HTMLSelectElement>("[data-disc-planet]");
      if (ogameCurrentPid && sel && planets.some((p) => p.id === ogameCurrentPid)) {
        sel.value = ogameCurrentPid;
      }
    }
    // Wire Stop button.
    m.querySelector<HTMLElement>("[data-disc-stop]")?.addEventListener("click", async (e) => {
      const btn = e.currentTarget as HTMLElement;
      const gid = btn.getAttribute("data-disc-goal-id") ?? "";
      if (!gid) return;
      btn.textContent = "stopping…";
      try {
        await fetchFn(`${baseUrl}/ogamex/v1/goals/${encodeURIComponent(gid)}/cancel`, { method: "POST", headers: authHeadersGlobal() });
        setTimeout(() => m.remove(), 400);
      } catch (err) {
        btn.textContent = `× ${(err as Error).message}`;
      }
    });
    // Wire Start button.
    m.querySelector<HTMLElement>("[data-disc-start]")?.addEventListener("click", async () => {
      const status = m.querySelector<HTMLElement>("[data-disc-status]");
      const sel = m.querySelector<HTMLSelectElement>("[data-disc-planet]");
      const rng = m.querySelector<HTMLInputElement>("[data-disc-range]");
      const pid = sel?.value ?? "";
      const range = Math.max(1, Math.min(20, parseInt(rng?.value ?? "10", 10) || 10));
      if (!pid) {
        if (status) { status.textContent = t("auto.009"); status.style.color = "#ff6b6b"; }
        return;
      }
      const planet = planets.find((p) => p.id === pid);
      const coords = planet?.coords ?? [];
      const galaxy = coords[0] ?? 0;
      const baseSystem = coords[1] ?? 0;
      if (status) { status.textContent = "creating…"; status.style.color = "#7080a0"; }
      try {
        const _bodyStr = JSON.stringify({ source_planet: pid, galaxy, base_system: baseSystem, range });
        // v0.0.977 — owner 2026-06-08 "HTTP 400" diagnostic: 抓真 POST body
        try {
          const _winF = window as Window & { localStorage?: Storage };
          const _bU = _winF.localStorage?.getItem("OGAMEX_BRIDGE_URL") ?? "https://ogame.anyfq.com";
          const _tk = _winF.localStorage?.getItem("OGAMEX_BRIDGE_TOKEN") ?? "smoke-test-token";
          void fetch(`${_bU.replace(/\/$/, "")}/ogamex/v1/debug/log`, {
            method: "POST", credentials: "omit",
            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${_tk}` },
            body: JSON.stringify({ tag: "DISCOVERY-PANEL-POST-v0977", text: `pid=${pid} galaxy=${galaxy} baseSystem=${baseSystem} range=${range} planet=${JSON.stringify(planet || null)} body=${_bodyStr}` }),
          }).catch(() => { /* */ });
        } catch { /* */ }
        const r = await fetchFn(`${baseUrl}/ogamex/v1/discovery/create`, {
          method: "POST",
          headers: authHeadersGlobal({ "Content-Type": "application/json" }),
          body: _bodyStr,
        });
        if (!r.ok) {
          const respText = await r.text().catch(() => "");
          // forensic 失败响应内容
          try {
            const _winF2 = window as Window & { localStorage?: Storage };
            const _bU2 = _winF2.localStorage?.getItem("OGAMEX_BRIDGE_URL") ?? "https://ogame.anyfq.com";
            const _tk2 = _winF2.localStorage?.getItem("OGAMEX_BRIDGE_TOKEN") ?? "smoke-test-token";
            void fetch(`${_bU2.replace(/\/$/, "")}/ogamex/v1/debug/log`, {
              method: "POST", credentials: "omit",
              headers: { "Content-Type": "application/json", "Authorization": `Bearer ${_tk2}` },
              body: JSON.stringify({ tag: "DISCOVERY-PANEL-RESP-v0977", text: `status=${r.status} resp=${respText.slice(0,400)}` }),
            }).catch(() => { /* */ });
          } catch { /* */ }
          throw new Error(`HTTP ${r.status}: ${respText.slice(0,80)}`);
        }
        const j = await r.json() as { ok?: boolean; reason?: string };
        if (!j.ok) throw new Error(j.reason ?? "create rejected");
        if (status) { status.textContent = "✓ created"; status.style.color = "#7cfc00"; }
        setTimeout(() => m.remove(), 600);
      } catch (e) {
        if (status) { status.textContent = `× ${(e as Error).message}`; status.style.color = "#ff6b6b"; }
      }
    });
  });
}

// M4 — generic goals settings modal. Adds an entry point to create any
// supported goal type (build/research/colonize/build_ships/...) via the
// sidecar's new POST /v1/goals/create. The active goals list itself stays
// in the main panel's Goals section — this modal focuses on creation.
function openGoalsSettings(
  doc: Document,
  baseUrl: string,
  fetchFn: typeof fetch,
): void {
  // Each entry: goal type + the target-shape placeholder shown in the
  // textarea. Operator can edit / paste / rewrite freely. Submit just sends
  // whatever JSON is in the textarea — sidecar validates type, planner
  // surfaces target-shape issues via "blocked: …".
  const GOAL_PRESETS: Array<{ value: string; label: string; planetReq: boolean; targetPlaceholder: string }> = [
    { value: "build",             label: t("auto.010"),           planetReq: true,  targetPlaceholder: `{"building":"metalMine","level":42}` },
    { value: "research",          label: t("auto.011"),         planetReq: true,  targetPlaceholder: `{"tech":"astrophysics","level":18}` },
    { value: "build_universal",   label: t("auto.012"), planetReq: false, targetPlaceholder: `{"building":"shipyard","level":12}` },
    { value: "build_ships",       label: t("auto.013"),      planetReq: true,  targetPlaceholder: `{"ship":"largeCargo","amount":500}` },
    { value: "build_defense",     label: t("auto.014"),    planetReq: true,  targetPlaceholder: `{"defense":"rocketLauncher","amount":1000}` },
    { value: "colonize",          label: t("auto.015"),         planetReq: true,  targetPlaceholder: `{"target_coords":"3:280:7"}` },
    { value: "lifeform_building", label: t("auto.016"), planetReq: true,  targetPlaceholder: `{"building":"residentialSector","level":40}` },
    { value: "lifeform_research", label: t("auto.017"), planetReq: true,  targetPlaceholder: `{"tech":"intergalacticEnvoys","level":10}` },
    { value: "lifeform_level_to", label: t("auto.018"), planetReq: true,  targetPlaceholder: `{"level":3}` },
    { value: "pick_lifeform",     label: t("auto.019"), planetReq: true,  targetPlaceholder: `{"species":"kaelesh"}` },
    { value: "terraformer_to",    label: t("auto.020"), planetReq: true,  targetPlaceholder: `{"level":8}` },
    { value: "expedition",        label: t("auto.021"),       planetReq: false, targetPlaceholder: `{"source_planet":"<id>","ships":{"largeCargo":1600,"explorer":1000}}` },
    { value: "deploy",            label: t("auto.022"),           planetReq: true,  targetPlaceholder: `{"target_coords":"4:241:8","target_type":"moon","ships":{"largeCargo":100}}` },
    { value: "transport",         label: t("auto.023"),        planetReq: true,  targetPlaceholder: `{"target_coords":"4:241:8","ships":{"largeCargo":100},"cargo":{"m":1000000,"c":0,"d":0}}` },
  ];
  const placeholder = `<div style="color:#7080a0; padding:8px 0;">loading planet list…</div>`;
  openSettingsModal(doc, "goals", t("modal.goals.title"), placeholder, async (m) => {
    const body = m.querySelector<HTMLElement>("div[role='dialog'] > div:nth-of-type(2)");
    if (!body) return;
    interface StorePlanet { id: string; type?: string; coords?: number[]; name?: string }
    const storeRef = (window as Window & { __ogamexStore?: { state?: { planets?: Record<string, StorePlanet> } } }).__ogamexStore;
    // Operator 2026-05-29: "星球選擇改成兩列 星球在第一列，月球在第二列".
    // Group by coord G:S:P so each row carries the planet (col 1) and its
    // sibling moon (col 2). Single radio group across all rows so only one
    // celestial body is selected at a time.
    const groupedByCoord = new Map<string, { planet?: StorePlanet; moon?: StorePlanet }>();
    for (const p of Object.values(storeRef?.state?.planets ?? {})) {
      const coords = p?.coords;
      if (!Array.isArray(coords) || coords.length !== 3) continue;
      const key = coords.join(":");
      const slot = groupedByCoord.get(key) ?? {};
      if (p.type === "moon") slot.moon = p;
      else slot.planet = p;
      groupedByCoord.set(key, slot);
    }
    const sortedCoordKeys = [...groupedByCoord.keys()].sort((a, b) => {
      const an = a.split(":").map((s) => parseInt(s, 10));
      const bn = b.split(":").map((s) => parseInt(s, 10));
      for (let i = 0; i < 3; i++) {
        const av = an[i] ?? 0; const bv = bn[i] ?? 0;
        if (av !== bv) return av - bv;
      }
      return 0;
    });
    // v0.0.611 — operator 2026-06-01 "選種族的時候只有對應種族的星球亮起
    // — 這個問題修了 6 次了". Root cause across multiple panes: each pane's
    // {} block scoped its own copy of livePlanetSpecies; lf-research's
    // copy referenced the lf-build version (out of block scope) → silent
    // ReferenceError, applyLrSpeciesFilter never fired. Lift the helper
    // to modal-outer scope so every pane reuses the same function.
    const livePlanetSpecies = (pid: string): string | null => {
      const p = storeRef?.state?.planets?.[pid] as {
        lifeform?: { species?: string } | null;
        lifeform_buildings?: Record<string, number>;
      } | undefined;
      if (!p) return null;
      const direct = p.lifeform?.species;
      if (direct) return direct;
      const lfb = p.lifeform_buildings ?? {};
      const speciesMaxLevel: Record<string, number> = {};
      for (const [name, lvl] of Object.entries(lfb)) {
        if (lvl <= 0) continue;
        const tid = TECH_ID_BY_NAME[name];
        if (typeof tid !== "number") continue;
        const prefix = Math.floor(tid / 1000);
        const sp = prefix === 11 ? "humans" : prefix === 12 ? "rocktal" : prefix === 13 ? "mechas" : prefix === 14 ? "kaelesh" : null;
        if (!sp) continue;
        speciesMaxLevel[sp] = Math.max(speciesMaxLevel[sp] ?? 0, lvl);
      }
      let best: string | null = null;
      let bestMax = 0;
      for (const [sp, mx] of Object.entries(speciesMaxLevel)) {
        if (mx > bestMax) { bestMax = mx; best = sp; }
      }
      return best;
    };

    // v0.0.582 — operator 2026-06-01: tab mode. 6 tabs:
    //   1. 星球建築 — build (planet), build_universal, terraformer_to
    //   2. 月球建築 — build (moon-only buildings: jumpgate, sensorPhalanx, lunarBase, moonShield)
    //   3. 生命形態建築 — lifeform_building, pick_lifeform, lifeform_level_to
    //   4. 普通研究 — research
    //   5. 生命形態研究 — lifeform_research
    //   6. 艦隊任務 — colonize, expedition, deploy, transport, build_ships, build_defense
    // Tab switch filters goal type select options + dims planet/moon rows
    // that don't match the tab's body kind.
    type TabId = "planet-build" | "moon-build" | "lf-build" | "research" | "lf-research" | "colonize";
    const TAB_DEFS: Array<{ id: TabId; label: string; goalTypes: string[]; bodyFilter: "planet" | "moon" | "any" }> = [
      { id: "planet-build", label: t("auto.024"), goalTypes: ["build", "build_universal", "terraformer_to"], bodyFilter: "planet" },
      { id: "moon-build",   label: t("auto.025"), goalTypes: ["build"],                                       bodyFilter: "moon"   },
      { id: "lf-build",     label: t("auto.026"), goalTypes: ["lifeform_building", "pick_lifeform", "lifeform_level_to"], bodyFilter: "planet" },
      { id: "research",     label: t("auto.027"), goalTypes: ["research"],                                    bodyFilter: "planet" },
      { id: "lf-research",  label: t("auto.028"), goalTypes: ["lifeform_research"],                            bodyFilter: "planet" },
      { id: "colonize",     label: t("auto.276"), goalTypes: ["colonize"],                                    bodyFilter: "planet" },
    ];
    const presetByValue = new Map(GOAL_PRESETS.map((g) => [g.value, g] as const));
    const renderTabBar = (): string => TAB_DEFS.map((t) =>
      `<button data-tab-btn="${t.id}" style="background:#0a1018; color:#7080a0; border:1px solid #2a3a52; border-bottom:none; padding:6px 10px; font-size:11px; cursor:pointer; border-top-left-radius:4px; border-top-right-radius:4px;">${escapeHtml(t.label)}</button>`,
    ).join("");
    const inputStyle = "background:#0a1018; color:#e0e8f0; border:1px solid #2a3a52; border-radius:3px; padding:3px 6px; font-size:11px;";
    // v0.0.583 — operator 2026-06-01: "星球建築 tab" 獨立 form (去掉 NL,
    // 只列 planet, 佔用灰顯, 建築 radio + level input + 實時描述). Other 5
    // tabs continue using the shared (NL + free-form target JSON) panel.
    // v0.0.588 — operator 2026-06-01 "要支持 terraformer". Re-added after
    // shared/tech_tree.ts gained a terraformer entry (prereqs naniteFactory
    // L1 + energyTech L12, cost 0/50k/100k × 2^L). Planner planBuild now
    // resolves terraformer correctly.
    const PLANET_BUILDING_KEYS = [
      "metalMine", "crystalMine", "deuteriumSynth",
      "solarPlant", "fusionReactor",
      "metalStorage", "crystalStorage", "deuteriumTank",
      "roboticsFactory", "shipyard", "researchLab", "naniteFactory",
      "terraformer",
    ] as const;
    const PLANET_BUILDING_LABEL: Record<string, string> = {
      metalMine: t("auto.127"), crystalMine: t("auto.128"), deuteriumSynth: t("auto.129"),
      solarPlant: t("auto.030"), fusionReactor: t("auto.031"),
      metalStorage: t("auto.032"), crystalStorage: t("auto.033"), deuteriumTank: t("auto.034"),
      roboticsFactory: t("auto.035"), shipyard: t("auto.036"), researchLab: t("auto.037"), naniteFactory: t("auto.038"),
      terraformer: t("auto.039"),
    };
    // v0.0.584 — operator 2026-06-01 "都是灰色是不對的, 多數星球上沒有建造任務":
    // occupied judgment was based on sidecar goal queue (always many blocked
    // resource-shortage goals → all planets flagged occupied). Fix: read
    // ogame's REAL build_q.ends_at — only planets actively building right
    // now occupy a queue slot. Idle planets (no build_q OR build_q expired)
    // are free for new tasks.
    const nowMs = Date.now();
    const planetCoordById = new Map<string, string>();
    for (const k of sortedCoordKeys) {
      const { planet } = groupedByCoord.get(k)!;
      if (planet) planetCoordById.set(planet.id, k);
    }
    type BuildQ = { ends_at?: number; tech?: string; level?: number } | null | undefined;
    const planetBuildQ = (pid: string): BuildQ => {
      const p = (storeRef?.state?.planets?.[pid] as { build_q?: BuildQ } | undefined);
      return p?.build_q;
    };
    const planetOccupied = (pid: string): boolean => {
      const bq = planetBuildQ(pid);
      return !!bq && (bq.ends_at ?? 0) > nowMs;
    };
    body.innerHTML = `
      <div style="color:#7080a0; font-size:11px; padding-bottom:6px;">${escapeHtml(t('auto.185'))}</div>
      <div data-tab-bar style="display:flex; gap:2px; margin-bottom:0;">${renderTabBar()}</div>
      <!-- v0.0.583 — 星球建築獨立 pane / v0.0.584 — 2-col + ogame-real-occupancy -->
      <div data-pane="planet-build" style="padding:8px 10px; background:#0a1018; border:1px solid #2a3a52; border-top:none; border-radius:0 4px 4px 4px;">
        <div style="padding:6px 0;">
          <div style="color:#d0d8e0; font-size:11px; padding-bottom:4px;">${escapeHtml(t('auto.186'))}</div>
          <div style="border:1px solid #2a3a52; border-radius:3px; max-height:240px; overflow-y:auto; background:#06090f;">
            <div style="padding:4px 8px; display:flex; gap:16px; border-bottom:1px solid #1a2030;">
              <label data-pb-all-wrap style="flex:1; display:flex; align-items:center; gap:6px; cursor:pointer; color:#d0d8e0; font-size:11px;">
                <input data-pb-planet type="radio" name="pb-planet-radio" value="all-planets" style="vertical-align:middle;"/>
                <span>🌍 ${escapeHtml(t('auto.194'))}</span>
              </label>
              <label data-pb-idle-wrap style="flex:1; display:flex; align-items:center; gap:6px; cursor:pointer; color:#d0d8e0; font-size:11px;">
                <input data-pb-planet type="radio" name="pb-planet-radio" value="idle-planets" style="vertical-align:middle;"/>
                <span>🌍 ${escapeHtml(t('auto.195'))}</span>
              </label>
            </div>
            <div style="display:grid; grid-template-columns:1fr 1fr; gap:0;">
            ${sortedCoordKeys
              .filter((k) => groupedByCoord.get(k)!.planet)
              .map((k) => {
                const { planet } = groupedByCoord.get(k)!;
                const p = planet!;
                const occ = planetOccupied(p.id);
                const bq = planetBuildQ(p.id);
                const eta = occ && bq?.ends_at ? Math.max(0, Math.round((bq.ends_at - nowMs) / 60000)) : 0;
                const tip = occ ? t("auto.156", { eta }) : "";
                const dim = occ ? "opacity:0.4; cursor:not-allowed;" : "cursor:pointer;";
                const occSuffix = occ ? ` <span style=\"color:#a06060; font-size:10px;\">[${eta}m]</span>` : "";
                return `<div style="padding:4px 8px; display:flex; gap:6px; align-items:center; border-bottom:1px solid #1a2030;">
                  <span style="width:60px; color:#7080a0; font-size:11px;">[${escapeHtml(k)}]</span>
                  <label style="flex:1; display:flex; align-items:center; gap:4px; color:#d0d8e0; font-size:11px; ${dim}" ${tip}>
                    <input data-pb-planet type="radio" name="pb-planet-radio" value="${escapeHtml(p.id)}" ${occ ? "disabled" : ""} style="vertical-align:middle;"/>
                    <span>🌍 ${escapeHtml(p.name ?? t("auto.119"))}${occSuffix}</span>
                  </label>
                </div>`;
              }).join("")}
            </div>
          </div>
        </div>
        <div style="padding:6px 0;">
          <div style="color:#d0d8e0; font-size:11px; padding-bottom:4px;">${escapeHtml(t('auto.188'))}</div>
          <div style="border:1px solid #2a3a52; border-radius:3px; padding:6px 8px; background:#06090f; display:grid; grid-template-columns:repeat(3, 1fr); gap:4px 8px;">
            ${PLANET_BUILDING_KEYS.map((bk) => `
              <label style="display:flex; align-items:center; gap:6px; cursor:pointer; color:#d0d8e0; font-size:11px;">
                <input data-pb-building type="radio" name="pb-building-radio" value="${escapeHtml(bk)}" style="vertical-align:middle;"/>
                <span>${escapeHtml(PLANET_BUILDING_LABEL[bk] ?? bk)}</span>
              </label>
            `).join("")}
          </div>
        </div>
        <div style="display:flex; gap:8px; align-items:center; padding:6px 0;">
          <span style="color:#d0d8e0; font-size:11px; width:80px;">${escapeHtml(t('auto.189'))}</span>
          <input data-pb-level type="number" min="1" max="50" value="" placeholder="${escapeHtml(t('auto.130'))}" onclick="this.select()" style="${inputStyle} width:100px;"/>
          <span data-pb-cur-display style="color:#7cfc00; font-size:11px; min-width:80px;"></span>
          <span style="color:#7080a0; font-size:10px;">${escapeHtml(t('auto.191'))}</span>
        </div>
        <!-- v1.0.0 — owner 2026-06-10 checkbox 自动建矿 / 自动建存储, 替代 astro≥16 阈值. -->
        <div style="display:flex; gap:14px; align-items:center; padding:6px 0; border-top:1px dashed #2a3a52; border-bottom:1px dashed #2a3a52; margin-top:4px;">
          <label style="display:inline-flex; align-items:center; gap:5px; cursor:pointer; color:#d0d8e0; font-size:11px;" title="${escapeHtml(t('auto.295'))}">
            <input data-pb-auto-mine type="checkbox" checked style="margin:0;"/>
            <span>${escapeHtml(t('auto.293'))}</span>
          </label>
          <label style="display:inline-flex; align-items:center; gap:5px; cursor:pointer; color:#d0d8e0; font-size:11px;" title="${escapeHtml(t('auto.296'))}">
            <input data-pb-auto-storage type="checkbox" checked style="margin:0;"/>
            <span>${escapeHtml(t('auto.294'))}</span>
          </label>
        </div>
        <div style="padding:6px 0; min-height:22px;">
          <span data-pb-desc style="color:#7cfc00; font-size:11px;"></span>
        </div>
        <div style="display:flex; gap:8px; align-items:center; padding:6px 0;">
          <span style="color:#d0d8e0; font-size:11px; width:80px;">${escapeHtml(t('auto.190'))}</span>
          <input data-pb-priority type="number" min="1" max="20" value="5" onclick="this.select()" style="${inputStyle} width:80px;"/>
          <span style="color:#7080a0; font-size:10px;">${escapeHtml(t('auto.193'))}</span>
        </div>
        <div style="display:flex; justify-content:flex-end; gap:8px; padding-top:8px;">
          <span data-pb-status style="color:#7080a0; font-size:10px; align-self:center;"></span>
          <button data-pb-create style="background:#205a20; color:#fff; border:1px solid #408a40; padding:4px 14px; border-radius:3px; cursor:pointer; font-size:11px;">${escapeHtml(t('auto.237'))}</button>
        </div>
      </div>
      <!-- v0.0.589 — 月球建築獨立 pane (類似 planet-build, 僅月球 + 月球建築) -->
      <div data-pane="moon-build" style="display:none; padding:8px 10px; background:#0a1018; border:1px solid #2a3a52; border-top:none; border-radius:0 4px 4px 4px;">
        <div style="padding:6px 0;">
          <div style="color:#d0d8e0; font-size:11px; padding-bottom:4px;">${escapeHtml(t('auto.187'))}</div>
          <div style="border:1px solid #2a3a52; border-radius:3px; max-height:240px; overflow-y:auto; background:#06090f;">
            <div style="padding:4px 8px; display:flex; gap:16px; border-bottom:1px solid #1a2030;">
              <label style="flex:1; display:flex; align-items:center; gap:6px; cursor:pointer; color:#d0d8e0; font-size:11px;">
                <input data-mb-moon type="radio" name="mb-moon-radio" value="all-moons" style="vertical-align:middle;"/>
                <span>🌙 ${escapeHtml(t('auto.196'))}</span>
              </label>
              <label style="flex:1; display:flex; align-items:center; gap:6px; cursor:pointer; color:#d0d8e0; font-size:11px;">
                <input data-mb-moon type="radio" name="mb-moon-radio" value="idle-moons" style="vertical-align:middle;"/>
                <span>🌙 ${escapeHtml(t('auto.197'))}</span>
              </label>
            </div>
            <div style="display:grid; grid-template-columns:1fr 1fr; gap:0;">
            ${sortedCoordKeys
              .filter((k) => groupedByCoord.get(k)!.moon)
              .map((k) => {
                const { moon } = groupedByCoord.get(k)!;
                const mb = moon!;
                const occ = planetOccupied(mb.id);
                const bq = planetBuildQ(mb.id);
                const eta = occ && bq?.ends_at ? Math.max(0, Math.round((bq.ends_at - nowMs) / 60000)) : 0;
                const tip = occ ? t("auto.156", { eta }) : "";
                const dim = occ ? "opacity:0.4; cursor:not-allowed;" : "cursor:pointer;";
                const occSuffix = occ ? ` <span style=\"color:#a06060; font-size:10px;\">[${eta}m]</span>` : "";
                return `<div style="padding:4px 8px; display:flex; gap:6px; align-items:center; border-bottom:1px solid #1a2030;">
                  <span style="width:60px; color:#7080a0; font-size:11px;">[${escapeHtml(k)}]</span>
                  <label style="flex:1; display:flex; align-items:center; gap:4px; color:#d0d8e0; font-size:11px; ${dim}" ${tip}>
                    <input data-mb-moon type="radio" name="mb-moon-radio" value="${escapeHtml(mb.id)}" ${occ ? "disabled" : ""} style="vertical-align:middle;"/>
                    <span>🌙 ${escapeHtml(localizeMoonName(mb.name))}${occSuffix}</span>
                  </label>
                </div>`;
              }).join("")}
            </div>
          </div>
        </div>
        <div style="padding:6px 0;">
          <div style="color:#d0d8e0; font-size:11px; padding-bottom:4px;">${escapeHtml(t('auto.188'))}</div>
          <div style="border:1px solid #2a3a52; border-radius:3px; padding:6px 8px; background:#06090f; display:grid; grid-template-columns:repeat(3, 1fr); gap:4px 8px;">
            <label style="display:flex; align-items:center; gap:6px; cursor:pointer; color:#d0d8e0; font-size:11px;"><input data-mb-building type="radio" name="mb-building-radio" value="lunarBase" style="vertical-align:middle;"/><span>${techName('lunarBase')}</span></label>
            <label style="display:flex; align-items:center; gap:6px; cursor:pointer; color:#d0d8e0; font-size:11px;"><input data-mb-building type="radio" name="mb-building-radio" value="sensorPhalanx" style="vertical-align:middle;"/><span>${techName('sensorPhalanx')}</span></label>
            <label style="display:flex; align-items:center; gap:6px; cursor:pointer; color:#d0d8e0; font-size:11px;"><input data-mb-building type="radio" name="mb-building-radio" value="jumpgate" style="vertical-align:middle;"/><span>${techName('jumpgate')}</span></label>
            <!-- v0.0.592 — operator 2026-06-01 t("auto.131"): ogame moon has its own independent roboticsFactory / shipyard counters from the planet sibling. Adding to moon-build options. -->
            <label style="display:flex; align-items:center; gap:6px; cursor:pointer; color:#d0d8e0; font-size:11px;"><input data-mb-building type="radio" name="mb-building-radio" value="roboticsFactory" style="vertical-align:middle;"/><span>${techName('roboticsFactory')}</span></label>
            <label style="display:flex; align-items:center; gap:6px; cursor:pointer; color:#d0d8e0; font-size:11px;"><input data-mb-building type="radio" name="mb-building-radio" value="shipyard" style="vertical-align:middle;"/><span>${techName('shipyard')}</span></label>
          </div>
        </div>
        <div style="display:flex; gap:8px; align-items:center; padding:6px 0;">
          <span style="color:#d0d8e0; font-size:11px; width:80px;">${escapeHtml(t('auto.189'))}</span>
          <input data-mb-level type="number" min="1" max="50" value="" placeholder="${escapeHtml(t('auto.132'))}" onclick="this.select()" style="${inputStyle} width:100px;"/>
          <span style="color:#7080a0; font-size:10px;">${escapeHtml(t('auto.191'))}</span>
        </div>
        <div style="padding:6px 0; min-height:22px;">
          <span data-mb-desc style="color:#7cfc00; font-size:11px;"></span>
        </div>
        <div style="display:flex; gap:8px; align-items:center; padding:6px 0;">
          <span style="color:#d0d8e0; font-size:11px; width:80px;">${escapeHtml(t('auto.190'))}</span>
          <input data-mb-priority type="number" min="1" max="20" value="5" onclick="this.select()" style="${inputStyle} width:80px;"/>
          <span style="color:#7080a0; font-size:10px;">${escapeHtml(t('auto.193'))}</span>
        </div>
        <div style="display:flex; justify-content:flex-end; gap:8px; padding-top:8px;">
          <span data-mb-status style="color:#7080a0; font-size:10px; align-self:center;"></span>
          <button data-mb-create style="background:#205a20; color:#fff; border:1px solid #408a40; padding:4px 14px; border-radius:3px; cursor:pointer; font-size:11px;">${escapeHtml(t('auto.237'))}</button>
        </div>
      </div>
      <!-- v0.0.593 — 生命建築獨立 pane -->
      <div data-pane="lf-build" style="display:none; padding:8px 10px; background:#0a1018; border:1px solid #2a3a52; border-top:none; border-radius:0 4px 4px 4px;">
        <div style="padding:6px 0;">
          <div style="color:#d0d8e0; font-size:11px; padding-bottom:4px;">${escapeHtml(t('auto.198'))}</div>
          <div style="border:1px solid #2a3a52; border-radius:3px; padding:6px 8px; background:#06090f; display:grid; grid-template-columns:repeat(4, 1fr); gap:4px 8px;">
            <label style="display:flex; align-items:center; gap:6px; cursor:pointer; color:#d0d8e0; font-size:11px;"><input data-lf-species type="radio" name="lf-species-radio" value="humans" style="vertical-align:middle;"/><span>${escapeHtml(t('auto.056'))}</span></label>
            <label style="display:flex; align-items:center; gap:6px; cursor:pointer; color:#d0d8e0; font-size:11px;"><input data-lf-species type="radio" name="lf-species-radio" value="rocktal" style="vertical-align:middle;"/><span>${escapeHtml(t('auto.057'))}</span></label>
            <label style="display:flex; align-items:center; gap:6px; cursor:pointer; color:#d0d8e0; font-size:11px;"><input data-lf-species type="radio" name="lf-species-radio" value="mechas" style="vertical-align:middle;"/><span>${escapeHtml(t('auto.058'))}</span></label>
            <label style="display:flex; align-items:center; gap:6px; cursor:pointer; color:#d0d8e0; font-size:11px;"><input data-lf-species type="radio" name="lf-species-radio" value="kaelesh" checked style="vertical-align:middle;"/><span>${escapeHtml(t('auto.059'))}</span></label>
          </div>
        </div>
        <div style="padding:6px 0;">
          <div style="color:#d0d8e0; font-size:11px; padding-bottom:4px;">${escapeHtml(t('auto.199'))}</div>
          <div style="border:1px solid #2a3a52; border-radius:3px; max-height:240px; overflow-y:auto; background:#06090f;">
            <div style="padding:4px 8px; display:flex; gap:16px; border-bottom:1px solid #1a2030;">
              <label style="flex:1; display:flex; align-items:center; gap:6px; cursor:pointer; color:#d0d8e0; font-size:11px;">
                <input data-lf-planet type="radio" name="lf-planet-radio" value="all-planets" style="vertical-align:middle;"/>
                <span>🌍 ${escapeHtml(t('auto.194'))}</span>
              </label>
              <label style="flex:1; display:flex; align-items:center; gap:6px; cursor:pointer; color:#d0d8e0; font-size:11px;">
                <input data-lf-planet type="radio" name="lf-planet-radio" value="idle-planets" style="vertical-align:middle;"/>
                <span>🌍 ${escapeHtml(t('auto.195'))}</span>
              </label>
            </div>
            <div style="display:grid; grid-template-columns:1fr 1fr; gap:0;">
            ${sortedCoordKeys
              .filter((k) => groupedByCoord.get(k)!.planet)
              .map((k) => {
                const { planet } = groupedByCoord.get(k)!;
                const p = planet!;
                // lf-build occupancy: planet has lf_build_q.ends_at > now
                const lfBq = (storeRef?.state?.planets?.[p.id] as { lf_build_q?: { ends_at?: number } } | undefined)?.lf_build_q;
                const occ = !!lfBq && (lfBq.ends_at ?? 0) > nowMs;
                const eta = occ && lfBq?.ends_at ? Math.max(0, Math.round((lfBq.ends_at - nowMs) / 60000)) : 0;
                const tip = occ ? t("auto.157", { eta }) : "";
                const dim = occ ? "opacity:0.4; cursor:not-allowed;" : "cursor:pointer;";
                const occSuffix = occ ? ` <span style=\"color:#a06060; font-size:10px;\">[${eta}m]</span>` : "";
                return `<div style="padding:4px 8px; display:flex; gap:6px; align-items:center; border-bottom:1px solid #1a2030;">
                  <span style="width:60px; color:#7080a0; font-size:11px;">[${escapeHtml(k)}]</span>
                  <label style="flex:1; display:flex; align-items:center; gap:4px; color:#d0d8e0; font-size:11px; ${dim}" ${tip}>
                    <input data-lf-planet type="radio" name="lf-planet-radio" value="${escapeHtml(p.id)}" ${occ ? "disabled" : ""} style="vertical-align:middle;"/>
                    <span>🌍 ${escapeHtml(p.name ?? t("auto.119"))}${occSuffix}</span>
                  </label>
                </div>`;
              }).join("")}
            </div>
          </div>
        </div>
        <div style="padding:6px 0;">
          <div style="color:#d0d8e0; font-size:11px; padding-bottom:4px;">${escapeHtml(t('auto.200'))}</div>
          <div data-lf-building-list style="border:1px solid #2a3a52; border-radius:3px; padding:6px 8px; background:#06090f; display:grid; grid-template-columns:repeat(3, 1fr); gap:4px 8px;">
            <span style="color:#5a7090; font-size:11px;">loading…</span>
          </div>
        </div>
        <div style="display:flex; gap:8px; align-items:center; padding:6px 0;">
          <span style="color:#d0d8e0; font-size:11px; width:80px;">${escapeHtml(t('auto.189'))}</span>
          <input data-lf-level type="number" min="1" max="80" value="" placeholder="${escapeHtml(t('auto.133'))}" onclick="this.select()" style="${inputStyle} width:100px;"/>
          <span style="color:#7080a0; font-size:10px;">${escapeHtml(t('auto.191'))}</span>
        </div>
        <div style="padding:6px 0; min-height:22px;">
          <span data-lf-desc style="color:#7cfc00; font-size:11px;"></span>
        </div>
        <div style="display:flex; gap:8px; align-items:center; padding:6px 0;">
          <span style="color:#d0d8e0; font-size:11px; width:80px;">${escapeHtml(t('auto.190'))}</span>
          <input data-lf-priority type="number" min="1" max="20" value="5" onclick="this.select()" style="${inputStyle} width:80px;"/>
          <span style="color:#7080a0; font-size:10px;">${escapeHtml(t('auto.193'))}</span>
        </div>
        <div style="display:flex; justify-content:flex-end; gap:8px; padding-top:8px;">
          <span data-lf-status style="color:#7080a0; font-size:10px; align-self:center;"></span>
          <button data-lf-create style="background:#205a20; color:#fff; border:1px solid #408a40; padding:4px 14px; border-radius:3px; cursor:pointer; font-size:11px;">${escapeHtml(t('auto.237'))}</button>
        </div>
      </div>
      <!-- v0.0.686 — 普通研究 pane + planet selector (operator 2026-06-03).
           Research is GLOBAL (single queue per account), but ogame requires
           the upgrade POST to originate from a SPECIFIC planet's research
           lab. Operator picks which planet — sidecar honors goal.planet
           in planner.ts:597-602 (matches state.planets[id] → use, else
           falls back to first planet). -->
      <div data-pane="research" style="display:none; padding:8px 10px; background:#0a1018; border:1px solid #2a3a52; border-top:none; border-radius:0 4px 4px 4px;">
        <div data-rs-queue style="padding:6px 0; color:#7080a0; font-size:11px;">global queue: <span style="color:#a06060;">loading…</span></div>
        <div style="padding:6px 0;">
          <div style="color:#d0d8e0; font-size:11px; padding-bottom:4px;">${escapeHtml(t('auto.225'))}</div>
          <div style="border:1px solid #2a3a52; border-radius:3px; max-height:160px; overflow-y:auto; background:#06090f; display:grid; grid-template-columns:1fr 1fr; gap:0;">
            ${sortedCoordKeys
              .filter((k) => groupedByCoord.get(k)!.planet)
              .map((k) => {
                const { planet } = groupedByCoord.get(k)!;
                const p = planet!;
                return `<div style="padding:4px 8px; display:flex; gap:6px; align-items:center; border-bottom:1px solid #1a2030;">
                  <span style="width:60px; color:#7080a0; font-size:11px;">[${escapeHtml(k)}]</span>
                  <label style="flex:1; display:flex; align-items:center; gap:4px; color:#d0d8e0; font-size:11px; cursor:pointer;">
                    <input data-rs-planet type="radio" name="rs-planet-radio" value="${escapeHtml(p.id)}" style="vertical-align:middle;"/>
                    <span>🌍 ${escapeHtml(p.name ?? t("auto.119"))}</span>
                  </label>
                </div>`;
              }).join("")}
          </div>
        </div>
        <div style="padding:6px 0;">
          <div style="color:#d0d8e0; font-size:11px; padding-bottom:4px;">${escapeHtml(t('auto.201'))}</div>
          <div style="border:1px solid #2a3a52; border-radius:3px; padding:6px 8px; background:#06090f; display:grid; grid-template-columns:repeat(4, 1fr); gap:4px 8px;">
            <label style="display:flex; align-items:center; gap:6px; cursor:pointer; color:#d0d8e0; font-size:11px;"><input data-rs-tech type="radio" name="rs-tech-radio" value="energyTech" style="vertical-align:middle;"/><span>${techName('energyTech')}</span></label>
            <label style="display:flex; align-items:center; gap:6px; cursor:pointer; color:#d0d8e0; font-size:11px;"><input data-rs-tech type="radio" name="rs-tech-radio" value="laserTech" style="vertical-align:middle;"/><span>${techName('laserTech')}</span></label>
            <label style="display:flex; align-items:center; gap:6px; cursor:pointer; color:#d0d8e0; font-size:11px;"><input data-rs-tech type="radio" name="rs-tech-radio" value="ionTech" style="vertical-align:middle;"/><span>${techName('ionTech')}</span></label>
            <label style="display:flex; align-items:center; gap:6px; cursor:pointer; color:#d0d8e0; font-size:11px;"><input data-rs-tech type="radio" name="rs-tech-radio" value="hyperspaceTech" style="vertical-align:middle;"/><span>${techName('hyperspaceTech')}</span></label>
            <label style="display:flex; align-items:center; gap:6px; cursor:pointer; color:#d0d8e0; font-size:11px;"><input data-rs-tech type="radio" name="rs-tech-radio" value="plasmaTech" style="vertical-align:middle;"/><span>${techName('plasmaTech')}</span></label>
            <label style="display:flex; align-items:center; gap:6px; cursor:pointer; color:#d0d8e0; font-size:11px;"><input data-rs-tech type="radio" name="rs-tech-radio" value="combustion" style="vertical-align:middle;"/><span>${techName('combustion')}</span></label>
            <label style="display:flex; align-items:center; gap:6px; cursor:pointer; color:#d0d8e0; font-size:11px;"><input data-rs-tech type="radio" name="rs-tech-radio" value="impulseDrive" style="vertical-align:middle;"/><span>${techName('impulseDrive')}</span></label>
            <label style="display:flex; align-items:center; gap:6px; cursor:pointer; color:#d0d8e0; font-size:11px;"><input data-rs-tech type="radio" name="rs-tech-radio" value="hyperspaceDrive" style="vertical-align:middle;"/><span>${techName('hyperspaceDrive')}</span></label>
            <label style="display:flex; align-items:center; gap:6px; cursor:pointer; color:#d0d8e0; font-size:11px;"><input data-rs-tech type="radio" name="rs-tech-radio" value="espionageTech" style="vertical-align:middle;"/><span>${techName('espionageTech')}</span></label>
            <label style="display:flex; align-items:center; gap:6px; cursor:pointer; color:#d0d8e0; font-size:11px;"><input data-rs-tech type="radio" name="rs-tech-radio" value="computerTech" style="vertical-align:middle;"/><span>${techName('computerTech')}</span></label>
            <label style="display:flex; align-items:center; gap:6px; cursor:pointer; color:#d0d8e0; font-size:11px;"><input data-rs-tech type="radio" name="rs-tech-radio" value="astrophysics" style="vertical-align:middle;"/><span>${techName('astrophysics')}</span></label>
            <label style="display:flex; align-items:center; gap:6px; cursor:pointer; color:#d0d8e0; font-size:11px;"><input data-rs-tech type="radio" name="rs-tech-radio" value="intergalactic" style="vertical-align:middle;"/><span>${techName('intergalactic')}</span></label>
            <label style="display:flex; align-items:center; gap:6px; cursor:pointer; color:#d0d8e0; font-size:11px;"><input data-rs-tech type="radio" name="rs-tech-radio" value="gravitonTech" style="vertical-align:middle;"/><span>${techName('gravitonTech')}</span></label>
            <label style="display:flex; align-items:center; gap:6px; cursor:pointer; color:#d0d8e0; font-size:11px;"><input data-rs-tech type="radio" name="rs-tech-radio" value="weapons" style="vertical-align:middle;"/><span>${techName('weapons')}</span></label>
            <label style="display:flex; align-items:center; gap:6px; cursor:pointer; color:#d0d8e0; font-size:11px;"><input data-rs-tech type="radio" name="rs-tech-radio" value="shielding" style="vertical-align:middle;"/><span>${techName('shielding')}</span></label>
            <label style="display:flex; align-items:center; gap:6px; cursor:pointer; color:#d0d8e0; font-size:11px;"><input data-rs-tech type="radio" name="rs-tech-radio" value="armor" style="vertical-align:middle;"/><span>${techName('armor')}</span></label>
          </div>
        </div>
        <div style="display:flex; gap:8px; align-items:center; padding:6px 0;">
          <span style="color:#d0d8e0; font-size:11px; width:80px;">${escapeHtml(t('auto.189'))}</span>
          <input data-rs-level type="number" min="1" max="30" value="" placeholder="${escapeHtml(t('auto.134'))}" onclick="this.select()" style="${inputStyle} width:100px;"/>
          <span style="color:#7080a0; font-size:10px;">${escapeHtml(t('auto.192'))}</span>
        </div>
        <div style="padding:6px 0; min-height:22px;">
          <span data-rs-desc style="color:#7cfc00; font-size:11px;"></span>
        </div>
        <div style="display:flex; gap:8px; align-items:center; padding:6px 0;">
          <span style="color:#d0d8e0; font-size:11px; width:80px;">${escapeHtml(t('auto.190'))}</span>
          <input data-rs-priority type="number" min="1" max="20" value="5" onclick="this.select()" style="${inputStyle} width:80px;"/>
          <span style="color:#7080a0; font-size:10px;">${escapeHtml(t('auto.193'))}</span>
        </div>
        <div style="display:flex; justify-content:flex-end; gap:8px; padding-top:8px;">
          <span data-rs-status style="color:#7080a0; font-size:10px; align-self:center;"></span>
          <button data-rs-create style="background:#205a20; color:#fff; border:1px solid #408a40; padding:4px 14px; border-radius:3px; cursor:pointer; font-size:11px;">${escapeHtml(t('auto.237'))}</button>
        </div>
      </div>
      <!-- v0.0.602 — 生命研究獨立 pane (per-species catalog.research) -->
      <div data-pane="lf-research" style="display:none; padding:8px 10px; background:#0a1018; border:1px solid #2a3a52; border-top:none; border-radius:0 4px 4px 4px;">
        <div style="padding:6px 0;">
          <div style="color:#d0d8e0; font-size:11px; padding-bottom:4px;">${escapeHtml(t('auto.224'))}</div>
          <div style="border:1px solid #2a3a52; border-radius:3px; padding:6px 8px; background:#06090f; display:grid; grid-template-columns:repeat(4, 1fr); gap:4px 8px;">
            <label style="display:flex; align-items:center; gap:6px; cursor:pointer; color:#d0d8e0; font-size:11px;"><input data-lr-species type="radio" name="lr-species-radio" value="humans" style="vertical-align:middle;"/><span>${escapeHtml(t('auto.056'))}</span></label>
            <label style="display:flex; align-items:center; gap:6px; cursor:pointer; color:#d0d8e0; font-size:11px;"><input data-lr-species type="radio" name="lr-species-radio" value="rocktal" style="vertical-align:middle;"/><span>${escapeHtml(t('auto.057'))}</span></label>
            <label style="display:flex; align-items:center; gap:6px; cursor:pointer; color:#d0d8e0; font-size:11px;"><input data-lr-species type="radio" name="lr-species-radio" value="mechas" style="vertical-align:middle;"/><span>${escapeHtml(t('auto.058'))}</span></label>
            <label style="display:flex; align-items:center; gap:6px; cursor:pointer; color:#d0d8e0; font-size:11px;"><input data-lr-species type="radio" name="lr-species-radio" value="kaelesh" checked style="vertical-align:middle;"/><span>${escapeHtml(t('auto.059'))}</span></label>
          </div>
        </div>
        <div style="padding:6px 0;">
          <div style="color:#d0d8e0; font-size:11px; padding-bottom:4px;">${escapeHtml(t('auto.225'))}</div>
          <div style="border:1px solid #2a3a52; border-radius:3px; max-height:240px; overflow-y:auto; background:#06090f; display:grid; grid-template-columns:1fr 1fr; gap:0;">
            ${sortedCoordKeys
              .filter((k) => groupedByCoord.get(k)!.planet)
              .map((k) => {
                const { planet } = groupedByCoord.get(k)!;
                const p = planet!;
                return `<div style="padding:4px 8px; display:flex; gap:6px; align-items:center; border-bottom:1px solid #1a2030;">
                  <span style="width:60px; color:#7080a0; font-size:11px;">[${escapeHtml(k)}]</span>
                  <label style="flex:1; display:flex; align-items:center; gap:4px; color:#d0d8e0; font-size:11px; cursor:pointer;">
                    <input data-lr-planet type="radio" name="lr-planet-radio" value="${escapeHtml(p.id)}" style="vertical-align:middle;"/>
                    <span>🌍 ${escapeHtml(p.name ?? t("auto.119"))}</span>
                  </label>
                </div>`;
              }).join("")}
          </div>
        </div>
        <div style="padding:6px 0;">
          <div style="display:flex; justify-content:space-between; align-items:center; padding-bottom:4px;">
            <span style="color:#d0d8e0; font-size:11px;">${escapeHtml(t('auto.226'))}</span>
            <button data-lr-force-sync type="button" style="background:#1a2438; color:#7cfc00; border:1px solid #2a3a52; border-radius:3px; cursor:pointer; font-size:10px; padding:2px 8px;" title=t("auto.135")>${escapeHtml(t('auto.227'))}</button>
          </div>
          <div data-lr-research-list style="border:1px solid #2a3a52; border-radius:3px; padding:6px 8px; background:#06090f; display:grid; grid-template-columns:repeat(3, 1fr); gap:4px 8px;">
            <span style="color:#5a7090; font-size:11px;">loading…</span>
          </div>
        </div>
        <div style="display:flex; gap:8px; align-items:center; padding:6px 0;">
          <span style="color:#d0d8e0; font-size:11px; width:80px;">${escapeHtml(t('auto.189'))}</span>
          <input data-lr-level type="number" min="1" max="50" value="" placeholder="${escapeHtml(t('auto.133'))}" onclick="this.select()" style="${inputStyle} width:100px;"/>
          <span style="color:#7080a0; font-size:10px;">${escapeHtml(t('auto.191'))}</span>
        </div>
        <div style="padding:6px 0; min-height:22px;">
          <span data-lr-desc style="color:#7cfc00; font-size:11px;"></span>
        </div>
        <div style="display:flex; gap:8px; align-items:center; padding:6px 0;">
          <span style="color:#d0d8e0; font-size:11px; width:80px;">${escapeHtml(t('auto.190'))}</span>
          <input data-lr-priority type="number" min="1" max="20" value="5" onclick="this.select()" style="${inputStyle} width:80px;"/>
          <span style="color:#7080a0; font-size:10px;">${escapeHtml(t('auto.193'))}</span>
        </div>
        <div style="display:flex; justify-content:flex-end; gap:8px; padding-top:8px;">
          <span data-lr-status style="color:#7080a0; font-size:10px; align-self:center;"></span>
          <button data-lr-create style="background:#205a20; color:#fff; border:1px solid #408a40; padding:4px 14px; border-radius:3px; cursor:pointer; font-size:11px;">${escapeHtml(t('auto.237'))}</button>
        </div>
      </div>
      <!-- v0.0.687 — 殖民獨立 pane (operator 2026-06-03 "舰船任务改成殖民任务").
           Flow: build colonyShip on source planet → galaxy-scan in range
           for nearest empty coord → dispatch mission=7. Sidecar wires the
           state machine; UI just collects ranges + shows last result. -->
      <div data-pane="colonize" style="display:none; padding:8px 10px; background:#0a1018; border:1px solid #2a3a52; border-top:none; border-radius:0 4px 4px 4px;">
        <div data-cl-last style="padding:6px 0; color:#7080a0; font-size:11px;">${escapeHtml(t('auto.284'))}: <span style="color:#7080a0;">${escapeHtml(t('auto.285'))}</span></div>
        <div style="padding:6px 0;">
          <div style="color:#d0d8e0; font-size:11px; padding-bottom:4px;">${escapeHtml(t('auto.277'))}</div>
          <div style="border:1px solid #2a3a52; border-radius:3px; max-height:160px; overflow-y:auto; background:#06090f; display:grid; grid-template-columns:1fr 1fr; gap:0;">
            ${sortedCoordKeys
              .filter((k) => groupedByCoord.get(k)!.planet)
              .map((k) => {
                const { planet } = groupedByCoord.get(k)!;
                const p = planet!;
                return `<div style="padding:4px 8px; display:flex; gap:6px; align-items:center; border-bottom:1px solid #1a2030;">
                  <span style="width:60px; color:#7080a0; font-size:11px;">[${escapeHtml(k)}]</span>
                  <label style="flex:1; display:flex; align-items:center; gap:4px; color:#d0d8e0; font-size:11px; cursor:pointer;">
                    <input data-cl-planet type="radio" name="cl-planet-radio" value="${escapeHtml(p.id)}" style="vertical-align:middle;"/>
                    <span>🌍 ${escapeHtml(p.name ?? t("auto.119"))}</span>
                  </label>
                </div>`;
              }).join("")}
          </div>
        </div>
        <div style="padding:6px 0;">
          <div style="color:#d0d8e0; font-size:11px; padding-bottom:4px;">${escapeHtml(t('auto.278'))}</div>
          <div style="display:flex; gap:6px; align-items:center; padding:4px 0; flex-wrap:wrap;">
            <span style="color:#7080a0; font-size:11px;">${escapeHtml(t('auto.279'))}</span>
            <select data-cl-galaxy style="${inputStyle} width:54px;">${[1,2,3,4,5,6,7,8,9].map(n => `<option value="${n}"${n===3?' selected':''}>${n}</option>`).join("")}</select>
            <span style="color:#7080a0; font-size:11px; padding-left:8px;">${escapeHtml(t('auto.280'))}</span>
            <input data-cl-s-min type="number" min="1" max="499" placeholder="${escapeHtml(t('auto.282'))}" onclick="this.select()" style="${inputStyle} width:60px;"/>
            <span style="color:#7080a0;">~</span>
            <input data-cl-s-max type="number" min="1" max="499" placeholder="${escapeHtml(t('auto.283'))}" onclick="this.select()" style="${inputStyle} width:60px;"/>
            <span style="color:#7080a0; font-size:11px; padding-left:8px;">${escapeHtml(t('auto.281'))}</span>
            <select data-cl-p-min style="${inputStyle} width:54px;">${Array.from({length:15},(_,i)=>i+1).map(n => `<option value="${n}"${n===8?' selected':''}>${n}</option>`).join("")}</select>
            <span style="color:#7080a0;">~</span>
            <select data-cl-p-max style="${inputStyle} width:54px;">${Array.from({length:15},(_,i)=>i+1).map(n => `<option value="${n}"${n===8?' selected':''}>${n}</option>`).join("")}</select>
          </div>
        </div>
        <div style="display:flex; gap:8px; align-items:center; padding:6px 0;">
          <span style="color:#d0d8e0; font-size:11px; width:80px;">${escapeHtml(t('auto.190'))}</span>
          <input data-cl-priority type="number" min="1" max="20" value="5" onclick="this.select()" style="${inputStyle} width:80px;"/>
          <span style="color:#7080a0; font-size:10px;">${escapeHtml(t('auto.193'))}</span>
        </div>
        <div style="display:flex; justify-content:flex-end; gap:8px; padding-top:8px;">
          <span data-cl-status style="color:#7080a0; font-size:10px; align-self:center;"></span>
          <button data-cl-create style="background:#205a20; color:#fff; border:1px solid #408a40; padding:4px 14px; border-radius:3px; cursor:pointer; font-size:11px;">${escapeHtml(t('auto.286'))}</button>
        </div>
      </div>
      <!-- Shared pane (used by 1 non-dedicated tab) -->
      <div data-pane="shared" style="display:none;">
      <!-- Operator 2026-05-29: 自然語言入口 — Gemini 解析 → 填表單 -->
      <div style="padding:8px 10px; background:#0a1018; border:1px solid #2a3a52; border-radius:4px; margin-bottom:8px;">
        <div style="color:#d0d8e0; font-size:11px; padding-bottom:4px;">${escapeHtml(t('auto.259'))} <span style="color:#7080a0; font-size:10px;">${escapeHtml(t('auto.260'))}</span></div>
        <textarea data-goal-nl rows="2" placeholder="${escapeHtml(t('auto.136'))}" style="${inputStyle} width:100%; box-sizing:border-box; resize:vertical;"></textarea>
        <div style="display:flex; justify-content:flex-end; gap:8px; padding-top:6px;">
          <span data-goal-nl-status style="color:#7080a0; font-size:10px; align-self:center;"></span>
          <button data-goal-nl-parse="1" style="background:#3a3a5a; color:#fff; border:1px solid #6a6a8a; padding:3px 12px; border-radius:3px; cursor:pointer; font-size:11px;">🤖 解析填表單</button>
        </div>
      </div>
      <div style="padding:8px 10px; background:#0a1018; border:1px solid #2a3a52; border-top:none; border-radius:0 4px 4px 4px;">
        <div style="display:flex; gap:8px; align-items:center; padding:6px 0;">
          <span style="color:#d0d8e0; font-size:11px; width:80px;">${escapeHtml(t('auto.240'))}</span>
          <select data-goal-type style="${inputStyle} flex:1;"></select>
        </div>
        <div style="padding:6px 0;">
          <div style="color:#d0d8e0; font-size:11px; padding-bottom:4px;">${escapeHtml(t('auto.241'))}</div>
          <div style="border:1px solid #2a3a52; border-radius:3px; max-height:180px; overflow-y:auto; background:#06090f;">
            <div style="padding:4px 8px; display:flex; gap:8px; font-size:10px; color:#7080a0; border-bottom:1px solid #2a3a52; background:#0a1018; position:sticky; top:0;">
              <span style="width:72px;">${escapeHtml(t('auto.242'))}</span>
              <span style="flex:1;">🌍 ${escapeHtml(t('auto.266'))}</span>
              <span style="flex:1;">🌙 ${escapeHtml(t('auto.118'))}</span>
            </div>
            <div style="padding:4px 8px; display:flex; gap:8px; align-items:center; border-bottom:1px solid #1a2030;">
              <span style="width:72px; color:#7080a0; font-size:11px;">—</span>
              <label style="flex:1; display:flex; align-items:center; gap:6px; cursor:pointer; color:#d0d8e0; font-size:11px;">
                <input data-goal-planet type="radio" name="goal-planet-radio" value="all-planets" checked style="vertical-align:middle;"/>
                <span>🌍 ${escapeHtml(t('auto.263'))}</span>
              </label>
              <label style="flex:1; display:flex; align-items:center; gap:6px; cursor:pointer; color:#d0d8e0; font-size:11px;">
                <input data-goal-planet type="radio" name="goal-planet-radio" value="all-moons" style="vertical-align:middle;"/>
                <span>🌙 ${escapeHtml(t('auto.264'))}</span>
              </label>
            </div>
            ${sortedCoordKeys.map((k) => {
              const { planet, moon } = groupedByCoord.get(k)!;
              const cellPlanet = planet
                ? `<label class="tab-cell-planet" style="flex:1; display:flex; align-items:center; gap:6px; cursor:pointer; color:#d0d8e0; font-size:11px;">
                    <input data-goal-planet type="radio" name="goal-planet-radio" value="${escapeHtml(planet.id)}" style="vertical-align:middle;"/>
                    <span>🌍 ${escapeHtml(planet.name ?? t("auto.119"))}</span>
                  </label>`
                : `<span class="tab-cell-planet" style="flex:1; color:#3a4658; font-size:11px; font-style:italic;">—</span>`;
              const cellMoon = moon
                ? `<label class="tab-cell-moon" style="flex:1; display:flex; align-items:center; gap:6px; cursor:pointer; color:#d0d8e0; font-size:11px;">
                    <input data-goal-planet type="radio" name="goal-planet-radio" value="${escapeHtml(moon.id)}" style="vertical-align:middle;"/>
                    <span>🌙 ${escapeHtml(localizeMoonName(moon.name))}</span>
                  </label>`
                : `<span class="tab-cell-moon" style="flex:1; color:#3a4658; font-size:11px; font-style:italic;">—</span>`;
              return `<div style="padding:4px 8px; display:flex; gap:8px; align-items:center; border-bottom:1px solid #1a2030;">
                <span style="width:72px; color:#7080a0; font-size:11px;">[${escapeHtml(k)}]</span>
                ${cellPlanet}
                ${cellMoon}
              </div>`;
            }).join("")}
          </div>
        </div>
        <div style="padding:6px 0;">
          <div style="color:#d0d8e0; font-size:11px; padding-bottom:4px;">Target (JSON)</div>
          <textarea data-goal-target rows="3" onclick="this.select()" style="${inputStyle} width:100%; box-sizing:border-box; font-family:monospace; font-size:11px;"></textarea>
          <div data-goal-target-hint style="color:#5a7090; font-size:10px; padding-top:2px;"></div>
        </div>
        <div style="display:flex; gap:8px; align-items:center; padding:6px 0;">
          <span style="color:#d0d8e0; font-size:11px; width:80px;">${escapeHtml(t('auto.190'))}</span>
          <input data-goal-priority type="number" min="1" max="20" value="5" onclick="this.select()" style="${inputStyle} width:80px;"/>
          <span style="color:#7080a0; font-size:10px;">${escapeHtml(t('auto.193'))}</span>
        </div>
        <div style="display:flex; justify-content:flex-end; gap:8px; padding-top:8px;">
          <span data-goal-status style="color:#7080a0; font-size:10px; align-self:center;"></span>
          <button data-goal-create="1" style="background:#205a20; color:#fff; border:1px solid #408a40; padding:4px 14px; border-radius:3px; cursor:pointer; font-size:11px;">${escapeHtml(t('auto.237'))}</button>
        </div>
      </div>
      </div><!-- /data-pane="shared" -->
    `;
    // Sync textarea placeholder with selected type.
    const typeSel = m.querySelector<HTMLSelectElement>("[data-goal-type]");
    const targetTa = m.querySelector<HTMLTextAreaElement>("[data-goal-target]");
    const targetHint = m.querySelector<HTMLElement>("[data-goal-target-hint]");
    const refreshPreset = (): void => {
      const tVal = typeSel?.value ?? "";
      const preset = presetByValue.get(tVal);
      if (!preset || !targetTa || !targetHint) return;
      targetTa.value = preset.targetPlaceholder;
      targetHint.textContent = preset.planetReq ? t("auto.040") : t("auto.041");
    };
    typeSel?.addEventListener("change", refreshPreset);

    // v0.0.582 — tab switching. Activate "planet-build" by default.
    const planetBuildPane = m.querySelector<HTMLElement>('[data-pane="planet-build"]');
    const moonBuildPane = m.querySelector<HTMLElement>('[data-pane="moon-build"]');
    const lfBuildPane = m.querySelector<HTMLElement>('[data-pane="lf-build"]');
    const researchPane = m.querySelector<HTMLElement>('[data-pane="research"]');
    const lfResearchPane = m.querySelector<HTMLElement>('[data-pane="lf-research"]');
    const colonizePane = m.querySelector<HTMLElement>('[data-pane="colonize"]');
    const sharedPane = m.querySelector<HTMLElement>('[data-pane="shared"]');
    const isDedicatedPane = (id: TabId): boolean => id === "planet-build" || id === "moon-build" || id === "lf-build" || id === "research" || id === "lf-research" || id === "colonize";
    const applyTab = (tabId: TabId): void => {
      const tab = TAB_DEFS.find((t) => t.id === tabId);
      if (!tab) return;
      // Restyle tab buttons
      for (const btn of m.querySelectorAll<HTMLButtonElement>("[data-tab-btn]")) {
        const active = btn.dataset["tabBtn"] === tabId;
        btn.style.background = active ? "#1a2438" : "#0a1018";
        btn.style.color = active ? "#e0e8f0" : "#7080a0";
        btn.style.borderColor = active ? "#3a5a82" : "#2a3a52";
        btn.style.fontWeight = active ? "600" : "normal";
      }
      // v0.0.583/589/593 — pane switch: 3 dedicated panes + 1 shared (3 tabs left).
      if (planetBuildPane) planetBuildPane.style.display = tabId === "planet-build" ? "" : "none";
      if (moonBuildPane) moonBuildPane.style.display = tabId === "moon-build" ? "" : "none";
      if (lfBuildPane) lfBuildPane.style.display = tabId === "lf-build" ? "" : "none";
      if (researchPane) researchPane.style.display = tabId === "research" ? "" : "none";
      if (lfResearchPane) lfResearchPane.style.display = tabId === "lf-research" ? "" : "none";
      if (colonizePane) colonizePane.style.display = tabId === "colonize" ? "" : "none";
      if (sharedPane) sharedPane.style.display = isDedicatedPane(tabId) ? "none" : "";
      if (isDedicatedPane(tabId)) return; // skip shared-form filtering below
      if (!typeSel) return;
      // Refilter goal type options
      typeSel.innerHTML = tab.goalTypes
        .map((v) => presetByValue.get(v))
        .filter((p): p is typeof GOAL_PRESETS[number] => !!p)
        .map((p) => `<option value="${escapeHtml(p.value)}">${escapeHtml(p.label)}</option>`)
        .join("");
      refreshPreset();
      // Filter planet rows: dim moon col on "planet-*"/"research"/"lf-*",
      // dim planet col on "moon-build". "fleet" tab keeps both visible.
      const showPlanet = tab.bodyFilter === "planet" || tab.bodyFilter === "any";
      const showMoon = tab.bodyFilter === "moon" || tab.bodyFilter === "any";
      for (const lbl of m.querySelectorAll<HTMLElement>(".tab-cell-planet")) {
        lbl.style.opacity = showPlanet ? "1" : "0.25";
        const inp = lbl.querySelector<HTMLInputElement>('input[type="radio"]');
        if (inp) inp.disabled = !showPlanet;
      }
      for (const lbl of m.querySelectorAll<HTMLElement>(".tab-cell-moon")) {
        lbl.style.opacity = showMoon ? "1" : "0.25";
        const inp = lbl.querySelector<HTMLInputElement>('input[type="radio"]');
        if (inp) inp.disabled = !showMoon;
      }
      // "All planets"/"All moons" header row: similarly filter.
      const allPlanetsRow = m.querySelector<HTMLInputElement>('input[value="all-planets"]');
      const allMoonsRow = m.querySelector<HTMLInputElement>('input[value="all-moons"]');
      if (allPlanetsRow) {
        allPlanetsRow.disabled = !showPlanet;
        (allPlanetsRow.parentElement as HTMLElement).style.opacity = showPlanet ? "1" : "0.25";
      }
      if (allMoonsRow) {
        allMoonsRow.disabled = !showMoon;
        (allMoonsRow.parentElement as HTMLElement).style.opacity = showMoon ? "1" : "0.25";
      }
      // If active radio is now disabled, pick first enabled.
      const checkedRadio = m.querySelector<HTMLInputElement>('input[name="goal-planet-radio"]:checked');
      if (checkedRadio?.disabled) {
        const firstEnabled = Array.from(m.querySelectorAll<HTMLInputElement>('input[name="goal-planet-radio"]'))
          .find((r) => !r.disabled);
        if (firstEnabled) firstEnabled.checked = true;
      }
    };
    for (const btn of m.querySelectorAll<HTMLButtonElement>("[data-tab-btn]")) {
      btn.addEventListener("click", () => {
        const tabId = btn.dataset["tabBtn"] as TabId | undefined;
        if (tabId) applyTab(tabId);
      });
    }
    applyTab("planet-build");

    // v0.0.583 — planet-build pane wiring: live description + submit.
    const pbPlanetRadios = (): HTMLInputElement[] => Array.from(
      m.querySelectorAll<HTMLInputElement>('input[name="pb-planet-radio"]'),
    );
    const pbBuildingRadios = (): HTMLInputElement[] => Array.from(
      m.querySelectorAll<HTMLInputElement>('input[name="pb-building-radio"]'),
    );
    const pbLevelInput = m.querySelector<HTMLInputElement>("[data-pb-level]");
    const pbDescEl = m.querySelector<HTMLElement>("[data-pb-desc]");
    const pbPriorityInput = m.querySelector<HTMLInputElement>("[data-pb-priority]");
    const pbStatusEl = m.querySelector<HTMLElement>("[data-pb-status]");
    const pbCreateBtn = m.querySelector<HTMLButtonElement>("[data-pb-create]");
    // v1.0.2 — owner 2026-06-10 "uncheck 以后再打开没有读回当前状态 — 通过永久化
    // 接口传?" 修真因: v1.0.0 用 lsGet/lsSet 引用不到 (在 openEmergencySettings
    // 内部 scope), rollup TS plugin 不 fail-fast → dist ReferenceError → init
    // throw → checkbox 状态读不回. 这次纯 PG roundtrip 走 /ogamex/v1/section-
    // settings, 不用 LS. authHeadersGlobal 提供 Bearer (modal scope 可见).
    {
      const pbAutoMine = m.querySelector<HTMLInputElement>("[data-pb-auto-mine]");
      const pbAutoStorage = m.querySelector<HTMLInputElement>("[data-pb-auto-storage]");
      // 初始 default checked (HTML 里写死), fetch GET 后覆盖真态.
      void fetchFn(`${baseUrl}/ogamex/v1/section-settings`, {
        method: "GET",
        headers: authHeadersGlobal(),
      })
        .then((r) => r.ok ? r.json() : null)
        .then((j) => {
          if (!j) return;
          const settings = (j as { settings?: Record<string, unknown> }).settings ?? {};
          const mineRaw = settings["ogamex.auto_build_mine"];
          const storageRaw = settings["ogamex.auto_build_storage"];
          if (pbAutoMine && mineRaw !== undefined) pbAutoMine.checked = !(mineRaw === false || mineRaw === "false");
          if (pbAutoStorage && storageRaw !== undefined) pbAutoStorage.checked = !(storageRaw === false || storageRaw === "false");
        })
        .catch(() => { /* PG fetch best-effort, 失败仍维持 default checked */ });
      // change → POST 直接到 PG (sidecar 立刻 mutate worldState section_settings,
      // 下次 daemon tick 立刻生效, 不需要 LS 中转).
      const syncAutoFlag = (key: string, checked: boolean): void => {
        const v = checked ? "true" : "false";
        void fetchFn(`${baseUrl}/ogamex/v1/section-settings`, {
          method: "POST",
          headers: authHeadersGlobal({ "Content-Type": "application/json" }),
          body: JSON.stringify({ [key]: v }),
        }).catch(() => { /* sync best-effort */ });
      };
      pbAutoMine?.addEventListener("change", () => syncAutoFlag("ogamex.auto_build_mine", pbAutoMine.checked));
      pbAutoStorage?.addEventListener("change", () => syncAutoFlag("ogamex.auto_build_storage", pbAutoStorage.checked));
    }
    // v0.0.590 — operator 2026-06-01 "有月球不能選, 所有月球就不能選, 星球
    // 頁面也是": if ANY body is occupied, the "所有" radio doesn't make sense
    // (literally cannot include them). Disable + gray it out, force operator
    // to pick "空閒" or a single body. "空閒" remains available always.
    // v0.0.590-591 — "有佔用 ⇒ disable 所有", "無空閒 ⇒ disable 空閒".
    let anyPlanetOccupied = false, anyPlanetIdle = false;
    for (const k of sortedCoordKeys) {
      const planet = groupedByCoord.get(k)?.planet;
      if (!planet) continue;
      if (planetOccupied(planet.id)) anyPlanetOccupied = true;
      else anyPlanetIdle = true;
    }
    const dimRadio = (radio: HTMLInputElement | null, tip: string): void => {
      if (!radio) return;
      radio.disabled = true;
      const lbl = radio.closest("label") as HTMLElement | null;
      if (lbl) { lbl.style.opacity = "0.4"; lbl.style.cursor = "not-allowed"; lbl.title = tip; }
    };
    const pbAllPlanetsRadio = m.querySelector<HTMLInputElement>('input[name="pb-planet-radio"][value="all-planets"]');
    const pbIdlePlanetsRadio = m.querySelector<HTMLInputElement>('input[name="pb-planet-radio"][value="idle-planets"]');
    if (anyPlanetOccupied) dimRadio(pbAllPlanetsRadio, t("auto.042"));
    if (!anyPlanetIdle) dimRadio(pbIdlePlanetsRadio, t("auto.043"));
    const refreshPbDesc = (): void => {
      if (!pbDescEl) return;
      const planetRadio = pbPlanetRadios().find((r) => r.checked);
      const buildingRadio = pbBuildingRadios().find((r) => r.checked);
      const lvl = parseInt(pbLevelInput?.value ?? "", 10);
      if (!planetRadio || !buildingRadio || !lvl) {
        pbDescEl.textContent = t("auto.044");
        pbDescEl.style.color = "#5a7090";
        return;
      }
      const bLabel = PLANET_BUILDING_LABEL[buildingRadio.value] ?? buildingRadio.value;
      if (planetRadio.value === "all-planets") {
        pbDescEl.textContent = t("auto.158", { b: bLabel, lvl });
      } else if (planetRadio.value === "idle-planets") {
        pbDescEl.textContent = t("auto.159", { b: bLabel, lvl });
      } else {
        const coord = planetCoordById.get(planetRadio.value) ?? "?";
        pbDescEl.textContent = t("auto.160", { coord, b: bLabel, lvl });
      }
      pbDescEl.style.color = "#7cfc00";
    };
    // v0.0.767 — operator 2026-06-04: 选好 planet+building 自动填 current+1.
    // v1.0.0 — owner 2026-06-10 "在输入框后面显示当前级别": curDisplay span 同步
    // 显示当前 L{cur}, 让 owner 一眼看见目标级别相对当前差多少.
    // 仅 specific planet 触发 (all/idle 多选无单一 currentLevel).
    const pbCurDisplay = m.querySelector<HTMLElement>("[data-pb-cur-display]");
    const prefillPbLevel = (): void => {
      if (!pbLevelInput) return;
      const planetRadio = pbPlanetRadios().find((r) => r.checked);
      const buildingRadio = pbBuildingRadios().find((r) => r.checked);
      if (!planetRadio || !buildingRadio) {
        if (pbCurDisplay) pbCurDisplay.textContent = "";
        return;
      }
      if (planetRadio.value === "all-planets" || planetRadio.value === "idle-planets") {
        if (pbCurDisplay) pbCurDisplay.textContent = "";
        return;
      }
      const planetState = (storeRef?.state?.planets?.[planetRadio.value] ?? {}) as { buildings?: Record<string, number> };
      const cur = planetState.buildings?.[buildingRadio.value] ?? 0;
      pbLevelInput.value = String(cur + 1);
      if (pbCurDisplay) pbCurDisplay.textContent = t("auto.297", { cur: String(cur) });
    };
    for (const r of pbPlanetRadios()) r.addEventListener("change", () => { prefillPbLevel(); refreshPbDesc(); });
    for (const r of pbBuildingRadios()) r.addEventListener("change", () => { prefillPbLevel(); refreshPbDesc(); });
    pbLevelInput?.addEventListener("input", refreshPbDesc);
    refreshPbDesc();
    pbCreateBtn?.addEventListener("click", async () => {
      if (!pbStatusEl) return;
      const planetRadio = pbPlanetRadios().find((r) => r.checked);
      const buildingRadio = pbBuildingRadios().find((r) => r.checked);
      const lvl = parseInt(pbLevelInput?.value ?? "", 10);
      const pri = parseInt(pbPriorityInput?.value ?? "5", 10) || 5;
      if (!planetRadio) { pbStatusEl.textContent = t("auto.045"); pbStatusEl.style.color = "#a06060"; return; }
      if (!buildingRadio) { pbStatusEl.textContent = t("auto.046"); pbStatusEl.style.color = "#a06060"; return; }
      if (!lvl || lvl < 1 || lvl > 50) { pbStatusEl.textContent = t("auto.047"); pbStatusEl.style.color = "#a06060"; return; }
      pbStatusEl.textContent = t("auto.048"); pbStatusEl.style.color = "#7080a0";
      let planetsToCreate: string[];
      if (planetRadio.value === "all-planets") {
        // Literal all — include occupied (ogame may reject those, but
        // operator explicitly asked for "all").
        planetsToCreate = sortedCoordKeys
          .map((k) => groupedByCoord.get(k)?.planet)
          .filter((p): p is StorePlanet => !!p)
          .map((p) => p.id);
      } else if (planetRadio.value === "idle-planets") {
        // Only idle (occupied filtered out).
        planetsToCreate = sortedCoordKeys
          .map((k) => groupedByCoord.get(k)?.planet)
          .filter((p): p is StorePlanet => !!p && !planetOccupied(p.id))
          .map((p) => p.id);
      } else {
        planetsToCreate = [planetRadio.value];
      }
      let okCount = 0; const errs: string[] = [];
      for (const pid of planetsToCreate) {
        try {
          const r = await fetchFn(`${baseUrl.replace(/\/$/, "")}/ogamex/v1/goals/create`, {
            method: "POST",
            headers: authHeadersGlobal({ "Content-Type": "application/json" }),
            body: JSON.stringify({
              type: "build",
              target: { building: buildingRadio.value, level: lvl },
              planet: pid,
              priority: pri,
            }),
          });
          if (r.ok) okCount++; else errs.push(`${pid}: HTTP ${r.status}`);
        } catch (e) { errs.push(`${pid}: ${(e as Error).message ?? e}`); }
      }
      if (errs.length === 0) {
        pbStatusEl.textContent = t("auto.161", { n: okCount });
        pbStatusEl.style.color = "#7cfc00";
      } else {
        pbStatusEl.textContent = t("auto.162", { ok: okCount, err: errs.length, first: errs[0] ?? "" });
        pbStatusEl.style.color = "#a06060";
      }
    });

    // v0.0.589 — moon-build pane wiring (mirrors planet-build).
    const MOON_BUILDING_LABEL: Record<string, string> = {
      lunarBase: t("auto.137"), sensorPhalanx: t("auto.049"), jumpgate: t("auto.050"),
      roboticsFactory: t("auto.035"), shipyard: t("auto.036"),
    };
    const moonCoordById = new Map<string, string>();
    for (const k of sortedCoordKeys) {
      const { moon } = groupedByCoord.get(k)!;
      if (moon) moonCoordById.set(moon.id, k);
    }
    const mbMoonRadios = (): HTMLInputElement[] => Array.from(
      m.querySelectorAll<HTMLInputElement>('input[name="mb-moon-radio"]'),
    );
    const mbBuildingRadios = (): HTMLInputElement[] => Array.from(
      m.querySelectorAll<HTMLInputElement>('input[name="mb-building-radio"]'),
    );
    const mbLevelInput = m.querySelector<HTMLInputElement>("[data-mb-level]");
    const mbDescEl = m.querySelector<HTMLElement>("[data-mb-desc]");
    const mbPriorityInput = m.querySelector<HTMLInputElement>("[data-mb-priority]");
    const mbStatusEl = m.querySelector<HTMLElement>("[data-mb-status]");
    const mbCreateBtn = m.querySelector<HTMLButtonElement>("[data-mb-create]");
    // v0.0.590-591 — same rule as planet pane.
    let anyMoonOccupied = false, anyMoonIdle = false;
    for (const k of sortedCoordKeys) {
      const moon = groupedByCoord.get(k)?.moon;
      if (!moon) continue;
      if (planetOccupied(moon.id)) anyMoonOccupied = true;
      else anyMoonIdle = true;
    }
    const mbAllMoonsRadio = m.querySelector<HTMLInputElement>('input[name="mb-moon-radio"][value="all-moons"]');
    const mbIdleMoonsRadio = m.querySelector<HTMLInputElement>('input[name="mb-moon-radio"][value="idle-moons"]');
    if (anyMoonOccupied) dimRadio(mbAllMoonsRadio, t("auto.051"));
    if (!anyMoonIdle) dimRadio(mbIdleMoonsRadio, t("auto.052"));
    const refreshMbDesc = (): void => {
      if (!mbDescEl) return;
      const moonRadio = mbMoonRadios().find((r) => r.checked);
      const buildingRadio = mbBuildingRadios().find((r) => r.checked);
      const lvl = parseInt(mbLevelInput?.value ?? "", 10);
      if (!moonRadio || !buildingRadio || !lvl) {
        mbDescEl.textContent = t("auto.053");
        mbDescEl.style.color = "#5a7090";
        return;
      }
      const bLabel = MOON_BUILDING_LABEL[buildingRadio.value] ?? buildingRadio.value;
      if (moonRadio.value === "all-moons") {
        mbDescEl.textContent = t("auto.163", { b: bLabel, lvl });
      } else if (moonRadio.value === "idle-moons") {
        mbDescEl.textContent = t("auto.164", { b: bLabel, lvl });
      } else {
        const coord = moonCoordById.get(moonRadio.value) ?? "?";
        mbDescEl.textContent = t("auto.165", { coord, b: bLabel, lvl });
      }
      mbDescEl.style.color = "#7cfc00";
    };
    // v0.0.767 — operator 2026-06-04: 选好 moon+building 自动填 current+1.
    const prefillMbLevel = (): void => {
      if (!mbLevelInput) return;
      const moonRadio = mbMoonRadios().find((r) => r.checked);
      const buildingRadio = mbBuildingRadios().find((r) => r.checked);
      if (!moonRadio || !buildingRadio) return;
      if (moonRadio.value === "all-moons" || moonRadio.value === "idle-moons") return;
      const moonState = (storeRef?.state?.planets?.[moonRadio.value] ?? {}) as { buildings?: Record<string, number> };
      const cur = moonState.buildings?.[buildingRadio.value] ?? 0;
      mbLevelInput.value = String(cur + 1);
    };
    for (const r of mbMoonRadios()) r.addEventListener("change", () => { prefillMbLevel(); refreshMbDesc(); });
    for (const r of mbBuildingRadios()) r.addEventListener("change", () => { prefillMbLevel(); refreshMbDesc(); });
    mbLevelInput?.addEventListener("input", refreshMbDesc);
    refreshMbDesc();
    mbCreateBtn?.addEventListener("click", async () => {
      if (!mbStatusEl) return;
      const moonRadio = mbMoonRadios().find((r) => r.checked);
      const buildingRadio = mbBuildingRadios().find((r) => r.checked);
      const lvl = parseInt(mbLevelInput?.value ?? "", 10);
      const pri = parseInt(mbPriorityInput?.value ?? "5", 10) || 5;
      if (!moonRadio) { mbStatusEl.textContent = t("auto.054"); mbStatusEl.style.color = "#a06060"; return; }
      if (!buildingRadio) { mbStatusEl.textContent = t("auto.046"); mbStatusEl.style.color = "#a06060"; return; }
      if (!lvl || lvl < 1 || lvl > 50) { mbStatusEl.textContent = t("auto.047"); mbStatusEl.style.color = "#a06060"; return; }
      mbStatusEl.textContent = t("auto.048"); mbStatusEl.style.color = "#7080a0";
      let moonsToCreate: string[];
      if (moonRadio.value === "all-moons") {
        moonsToCreate = sortedCoordKeys
          .map((k) => groupedByCoord.get(k)?.moon)
          .filter((p): p is StorePlanet => !!p)
          .map((p) => p.id);
      } else if (moonRadio.value === "idle-moons") {
        moonsToCreate = sortedCoordKeys
          .map((k) => groupedByCoord.get(k)?.moon)
          .filter((p): p is StorePlanet => !!p && !planetOccupied(p.id))
          .map((p) => p.id);
      } else {
        moonsToCreate = [moonRadio.value];
      }
      let okCount = 0; const errs: string[] = [];
      for (const mid of moonsToCreate) {
        try {
          const r = await fetchFn(`${baseUrl.replace(/\/$/, "")}/ogamex/v1/goals/create`, {
            method: "POST",
            headers: authHeadersGlobal({ "Content-Type": "application/json" }),
            body: JSON.stringify({
              type: "build",
              target: { building: buildingRadio.value, level: lvl },
              planet: mid,
              priority: pri,
            }),
          });
          if (r.ok) okCount++; else errs.push(`${mid}: HTTP ${r.status}`);
        } catch (e) { errs.push(`${mid}: ${(e as Error).message ?? e}`); }
      }
      if (errs.length === 0) {
        mbStatusEl.textContent = t("auto.161", { n: okCount });
        mbStatusEl.style.color = "#7cfc00";
      } else {
        mbStatusEl.textContent = t("auto.162", { ok: okCount, err: errs.length, first: errs[0] ?? "" });
        mbStatusEl.style.color = "#a06060";
      }
    });

    // v0.0.593 — lf-build pane wiring (lifeform buildings per species).
    // Static import below (top-level dynamic import breaks IIFE/code-splitting).
    {
      const lfSpeciesRadios = (): HTMLInputElement[] => Array.from(
        m.querySelectorAll<HTMLInputElement>('input[name="lf-species-radio"]'),
      );
      const lfPlanetRadios = (): HTMLInputElement[] => Array.from(
        m.querySelectorAll<HTMLInputElement>('input[name="lf-planet-radio"]'),
      );
      const lfBuildingRadios = (): HTMLInputElement[] => Array.from(
        m.querySelectorAll<HTMLInputElement>('input[name="lf-building-radio"]'),
      );
      const lfBuildingList = m.querySelector<HTMLElement>("[data-lf-building-list]");
      const lfLevelInput = m.querySelector<HTMLInputElement>("[data-lf-level]");
      const lfDescEl = m.querySelector<HTMLElement>("[data-lf-desc]");
      const lfPriorityInput = m.querySelector<HTMLInputElement>("[data-lf-priority]");
      const lfStatusEl = m.querySelector<HTMLElement>("[data-lf-status]");
      const lfCreateBtn = m.querySelector<HTMLButtonElement>("[data-lf-create]");
      type LfBuilding = { id: string; display_name_zh?: string; display_name_en?: string };
      const currentBuildings = new Map<string, string>(); // id → display name
      const renderLfBuildings = (species: string): void => {
        if (!lfBuildingList) return;
        const cat = (LIFEFORM_TECH as Record<string, { buildings?: Record<string, LfBuilding> }>)[species];
        const buildings = cat?.buildings ?? {};
        const entries = Object.entries(buildings);
        // v0.0.665 — operator "LF 建筑中文名不对": thread DOM-scraped
        // tech_labels into pickLfName so TC labels come from ogame ground
        // truth (catalog handcrafted display_name_zh has drift vs ogame).
        const techLabels = (storeRef?.state as { tech_labels?: Record<string, string> } | undefined)?.tech_labels ?? {};
        currentBuildings.clear();
        for (const [k, v] of entries) currentBuildings.set(k, pickLfName(v, k, techLabels));
        lfBuildingList.innerHTML = entries.map(([k, v]) => {
          const name = pickLfName(v, k, techLabels);
          return `<label style="display:flex; align-items:center; gap:6px; cursor:pointer; color:#d0d8e0; font-size:11px;"><input type="radio" name="lf-building-radio" value="${escapeHtml(k)}" style="vertical-align:middle;"/><span>${escapeHtml(name)}</span></label>`;
        }).join("");
        for (const r of lfBuildingRadios()) r.addEventListener("change", () => { prefillLfLevel(); refreshLfDesc(); });
      };
      // v0.0.767 — operator 2026-06-04: 选好 planet+building 自动填 current+1.
      const prefillLfLevel = (): void => {
        if (!lfLevelInput) return;
        const planetRadio = lfPlanetRadios().find((r) => r.checked);
        const buildingRadio = lfBuildingRadios().find((r) => r.checked);
        if (!planetRadio || !buildingRadio) return;
        if (planetRadio.value === "all-planets" || planetRadio.value === "idle-planets") return;
        const planetState = (storeRef?.state?.planets?.[planetRadio.value] ?? {}) as { lifeform_buildings?: Record<string, number> };
        const cur = planetState.lifeform_buildings?.[buildingRadio.value] ?? 0;
        lfLevelInput.value = String(cur + 1);
      };
      const refreshLfDesc = (): void => {
        if (!lfDescEl) return;
        const speciesRadio = lfSpeciesRadios().find((r) => r.checked);
        const planetRadio = lfPlanetRadios().find((r) => r.checked);
        const buildingRadio = lfBuildingRadios().find((r) => r.checked);
        const lvl = parseInt(lfLevelInput?.value ?? "", 10);
        if (!speciesRadio || !planetRadio || !buildingRadio || !lvl) {
          lfDescEl.textContent = t("auto.055");
          lfDescEl.style.color = "#5a7090";
          return;
        }
        const bLabel = currentBuildings.get(buildingRadio.value) ?? buildingRadio.value;
        const speciesLabel: Record<string, string> = { humans: t("auto.056"), rocktal: t("auto.057"), mechas: t("auto.058"), kaelesh: t("auto.059") };
        const sn = speciesLabel[speciesRadio.value] ?? speciesRadio.value;
        if (planetRadio.value === "all-planets") {
          lfDescEl.textContent = t("auto.166", { b: bLabel, lvl, sn });
        } else if (planetRadio.value === "idle-planets") {
          lfDescEl.textContent = t("auto.167", { b: bLabel, lvl, sn });
        } else {
          const coord = planetCoordById.get(planetRadio.value) ?? "?";
          lfDescEl.textContent = t("auto.168", { coord, b: bLabel, lvl, sn });
        }
        lfDescEl.style.color = "#7cfc00";
      };
      // v0.0.594 — operator 2026-06-01 "每顆星球的種族不同, 選 species 後
      // 只有對應的星球可選, 其他灰色". Read each planet's lifeform.species
      // from store; planets with mismatched (or null) species get dimmed
      // and disabled when a species is selected.
      const speciesLabelMap: Record<string, string> = {
        humans: t("auto.056"), rocktal: t("auto.057"), mechas: t("auto.058"), kaelesh: t("auto.059"),
      };
      // v0.0.595/596 — operator 2026-06-01 "沒有拿種族的 api 嗎 / 怎麼都
      // 是未設定, 全部設定過了". Two-tier species lookup:
      //   1. store.planets[pid].lifeform.species (if boot.ts refreshOnePage
      //      visited lfbuildings page) — direct answer
      //   2. Fallback: infer from lifeform_buildings prefix. Building IDs
      //      111xx = humans, 121xx = rocktal, 131xx = mechas, 141xx = kaelesh.
      //      Take any building with lvl > 0, look up its tech ID, prefix → species.
      // v0.0.611 — livePlanetSpecies moved to modal-outer scope above (just
      // before tab bar). lf-build's prior local definition removed; closure
      // resolves to the outer version. Same applies to lf-research and any
      // future pane that needs species detection.
      const refreshSpeciesTags = (): void => {
        for (const radio of lfPlanetRadios()) {
          const pid = radio.value;
          if (pid === "all-planets" || pid === "idle-planets") continue;
          const sp = livePlanetSpecies(pid);
          const tag = sp ? speciesLabelMap[sp] ?? sp : t("auto.060");
          const span = radio.parentElement?.querySelector("span");
          if (!span) continue;
          // Strip existing tag (if any) then re-append fresh.
          const base = (span.textContent ?? "").replace(/\s*\[(人類|巖族|機械族|凱萊什|未設定)\]\s*$/, "");
          span.textContent = `${base} [${tag}]`;
        }
      };
      refreshSpeciesTags();
      const applyLfSpeciesFilter = (species: string): void => {
        // Always re-read tags first (in case store updated since last call).
        refreshSpeciesTags();
        let matchCount = 0;
        for (const radio of lfPlanetRadios()) {
          const pid = radio.value;
          if (pid === "all-planets" || pid === "idle-planets") continue;
          const sp = livePlanetSpecies(pid);
          const matches = sp === species;
          if (matches) matchCount++;
          const label = radio.closest("label") as HTMLElement | null;
          if (!label) continue;
          // Don't override the lf_build_q occupancy disable (that has its own dim).
          const wasLfqDim = label.title.includes(t("auto.061"));
          if (!matches) {
            radio.disabled = true;
            label.style.opacity = "0.3";
            label.style.cursor = "not-allowed";
            label.title = sp
              ? t("auto.169", { sp1: speciesLabelMap[sp] ?? sp, sp2: speciesLabelMap[species] ?? species })
              : t("auto.062");
          } else if (!wasLfqDim) {
            radio.disabled = false;
            label.style.opacity = "1";
            label.style.cursor = "pointer";
            label.title = "";
          }
        }
        // If currently checked radio was just disabled, clear selection.
        const checked = lfPlanetRadios().find((r) => r.checked);
        if (checked?.disabled) checked.checked = false;
        // If 0 matching planets, also dim "所有星球" / "空閒星球" since neither
        // dispatch makes sense.
        const lfAllRadio2 = m.querySelector<HTMLInputElement>('input[name="lf-planet-radio"][value="all-planets"]');
        const lfIdleRadio2 = m.querySelector<HTMLInputElement>('input[name="lf-planet-radio"][value="idle-planets"]');
        if (lfAllRadio2 && lfIdleRadio2) {
          if (matchCount === 0) {
            dimRadio(lfAllRadio2, t("auto.170", { sp: speciesLabelMap[species] ?? species }));
            dimRadio(lfIdleRadio2, t("auto.170", { sp: speciesLabelMap[species] ?? species }));
          } else {
            // Restore (subject to original anyOccupied / anyIdle rules below).
            lfAllRadio2.disabled = false;
            lfIdleRadio2.disabled = false;
            for (const r of [lfAllRadio2, lfIdleRadio2]) {
              const lbl = r.closest("label") as HTMLElement | null;
              if (lbl) { lbl.style.opacity = "1"; lbl.style.cursor = "pointer"; lbl.title = ""; }
            }
          }
        }
      };
      // Initial render (kaelesh default per operator memory).
      const initSpecies = lfSpeciesRadios().find((r) => r.checked)?.value ?? "kaelesh";
      renderLfBuildings(initSpecies);
      applyLfSpeciesFilter(initSpecies);
      for (const r of lfSpeciesRadios()) r.addEventListener("change", () => {
        renderLfBuildings(r.value);
        applyLfSpeciesFilter(r.value);
        refreshLfDesc();
      });
      for (const r of lfPlanetRadios()) r.addEventListener("change", () => { prefillLfLevel(); refreshLfDesc(); });
      lfLevelInput?.addEventListener("input", refreshLfDesc);
      // anyOccupied / anyIdle for lf-build (use lf_build_q for occupancy).
      let anyLfOccupied = false, anyLfIdle = false;
      for (const k of sortedCoordKeys) {
        const planet = groupedByCoord.get(k)?.planet;
        if (!planet) continue;
        const lfBq = (storeRef?.state?.planets?.[planet.id] as { lf_build_q?: { ends_at?: number } } | undefined)?.lf_build_q;
        const occ = !!lfBq && (lfBq.ends_at ?? 0) > nowMs;
        if (occ) anyLfOccupied = true; else anyLfIdle = true;
      }
      const lfAllRadio = m.querySelector<HTMLInputElement>('input[name="lf-planet-radio"][value="all-planets"]');
      const lfIdleRadio = m.querySelector<HTMLInputElement>('input[name="lf-planet-radio"][value="idle-planets"]');
      if (anyLfOccupied) dimRadio(lfAllRadio, t("auto.063"));
      if (!anyLfIdle) dimRadio(lfIdleRadio, t("auto.043"));
      refreshLfDesc();
      lfCreateBtn?.addEventListener("click", async () => {
        if (!lfStatusEl) return;
        const planetRadio = lfPlanetRadios().find((r) => r.checked);
        const buildingRadio = lfBuildingRadios().find((r) => r.checked);
        const lvl = parseInt(lfLevelInput?.value ?? "", 10);
        const pri = parseInt(lfPriorityInput?.value ?? "5", 10) || 5;
        if (!planetRadio) { lfStatusEl.textContent = t("auto.045"); lfStatusEl.style.color = "#a06060"; return; }
        if (!buildingRadio) { lfStatusEl.textContent = t("auto.046"); lfStatusEl.style.color = "#a06060"; return; }
        if (!lvl || lvl < 1 || lvl > 50) { lfStatusEl.textContent = t("auto.047"); lfStatusEl.style.color = "#a06060"; return; }
        lfStatusEl.textContent = t("auto.048"); lfStatusEl.style.color = "#7080a0";
        const lfOccCheck = (pid: string): boolean => {
          const lfBq = (storeRef?.state?.planets?.[pid] as { lf_build_q?: { ends_at?: number } } | undefined)?.lf_build_q;
          return !!lfBq && (lfBq.ends_at ?? 0) > nowMs;
        };
        let planetsToCreate: string[];
        if (planetRadio.value === "all-planets") {
          planetsToCreate = sortedCoordKeys.map((k) => groupedByCoord.get(k)?.planet).filter((p): p is StorePlanet => !!p).map((p) => p.id);
        } else if (planetRadio.value === "idle-planets") {
          planetsToCreate = sortedCoordKeys.map((k) => groupedByCoord.get(k)?.planet).filter((p): p is StorePlanet => !!p && !lfOccCheck(p.id)).map((p) => p.id);
        } else {
          planetsToCreate = [planetRadio.value];
        }
        let okCount = 0; const errs: string[] = [];
        for (const pid of planetsToCreate) {
          try {
            const r = await fetchFn(`${baseUrl.replace(/\/$/, "")}/ogamex/v1/goals/create`, {
              method: "POST",
              headers: authHeadersGlobal({ "Content-Type": "application/json" }),
              body: JSON.stringify({
                type: "lifeform_building",
                target: { building: buildingRadio.value, level: lvl },
                planet: pid,
                priority: pri,
              }),
            });
            if (r.ok) okCount++; else errs.push(`${pid}: HTTP ${r.status}`);
          } catch (e) { errs.push(`${pid}: ${(e as Error).message ?? e}`); }
        }
        if (errs.length === 0) {
          lfStatusEl.textContent = t("auto.161", { n: okCount });
          lfStatusEl.style.color = "#7cfc00";
        } else {
          lfStatusEl.textContent = t("auto.162", { ok: okCount, err: errs.length, first: errs[0] ?? "" });
          lfStatusEl.style.color = "#a06060";
        }
      });
    }

    // v0.0.599 — research pane wiring (global queue, no planet selector).
    {
      const RESEARCH_LABEL: Record<string, string> = {
        energyTech: t("auto.064"), laserTech: t("auto.065"), ionTech: t("auto.138"),
        hyperspaceTech: t("auto.066"), plasmaTech: t("auto.067"),
        combustion: t("auto.068"), impulseDrive: t("auto.139"), hyperspaceDrive: t("auto.140"),
        espionageTech: t("auto.069"), computerTech: t("auto.141"),
        astrophysics: t("auto.070"), intergalactic: t("auto.071"), gravitonTech: t("auto.072"),
        weapons: t("auto.142"), shielding: t("auto.073"), armor: t("auto.143"),
      };
      const rsTechRadios = (): HTMLInputElement[] => Array.from(
        m.querySelectorAll<HTMLInputElement>('input[name="rs-tech-radio"]'),
      );
      const rsLevelInput = m.querySelector<HTMLInputElement>("[data-rs-level]");
      const rsDescEl = m.querySelector<HTMLElement>("[data-rs-desc]");
      const rsPriorityInput = m.querySelector<HTMLInputElement>("[data-rs-priority]");
      const rsStatusEl = m.querySelector<HTMLElement>("[data-rs-status]");
      const rsCreateBtn = m.querySelector<HTMLButtonElement>("[data-rs-create]");
      const rsQueueEl = m.querySelector<HTMLElement>("[data-rs-queue]");
      // v0.0.601 — operator 2026-06-01 "引力技術如果已經研究了, 就變成灰色".
      // gravitonTech is a one-shot research (L1 unlocks deathstar — ogame
      // doesn't let it go higher without re-researching for cost cycles).
      // Disable the radio when already at L1+.
      {
        const rsLevelsInit = (storeRef?.state as { research?: { levels?: Record<string, number> } } | undefined)?.research?.levels ?? {};
        const gravRadio = m.querySelector<HTMLInputElement>('input[name="rs-tech-radio"][value="gravitonTech"]');
        if (gravRadio && (rsLevelsInit["gravitonTech"] ?? 0) >= 1) {
          gravRadio.disabled = true;
          const lbl = gravRadio.closest("label") as HTMLElement | null;
          if (lbl) {
            lbl.style.opacity = "0.4";
            lbl.style.cursor = "not-allowed";
            lbl.title = t("auto.171", { n: rsLevelsInit["gravitonTech"] ?? 0 });
          }
        }
      }
      const rq = (storeRef?.state as { research?: { queue?: { tech?: string; level?: number; ends_at?: number } | null } } | undefined)?.research?.queue;
      if (rsQueueEl) {
        if (rq && rq.ends_at && rq.ends_at > nowMs) {
          const etaMin = Math.round((rq.ends_at - nowMs) / 60000);
          const techLabel = RESEARCH_LABEL[rq.tech ?? ""] ?? rq.tech ?? "?";
          rsQueueEl.innerHTML = `global queue: <span style="color:#ffaa66;">${escapeHtml(techLabel)} L${rq.level} eta=${etaMin}min</span>`;
        } else {
          rsQueueEl.innerHTML = t("auto.074");
        }
      }
      // v0.0.600 — operator 2026-06-01 "點對應的科技, 下面顯示這個科技的當前
      // 等級". When operator selects a tech radio, show current level from
      // store.research.levels so they know what target level to type.
      const refreshRsDesc = (): void => {
        if (!rsDescEl) return;
        const techRadio = rsTechRadios().find((r) => r.checked);
        const lvl = parseInt(rsLevelInput?.value ?? "", 10);
        if (!techRadio) {
          rsDescEl.textContent = t("auto.075");
          rsDescEl.style.color = "#5a7090";
          return;
        }
        const tLabel = RESEARCH_LABEL[techRadio.value] ?? techRadio.value;
        const levels = (storeRef?.state as { research?: { levels?: Record<string, number> } } | undefined)?.research?.levels ?? {};
        const curLvl = levels[techRadio.value] ?? 0;
        const curPart = t("auto.172", { t: tLabel, lvl: curLvl });
        if (!lvl) {
          rsDescEl.textContent = t("auto.173", { cur: curPart });
          rsDescEl.style.color = "#7cfc00";
          return;
        }
        rsDescEl.textContent = t("auto.174", { cur: curPart, lvl });
        rsDescEl.style.color = "#7cfc00";
      };
      // v0.0.767 — operator 2026-06-04: 选 tech 后自动填 current+1.
      const prefillRsLevel = (): void => {
        if (!rsLevelInput) return;
        const techRadio = rsTechRadios().find((r) => r.checked);
        if (!techRadio) return;
        const levels = (storeRef?.state as { research?: { levels?: Record<string, number> } } | undefined)?.research?.levels ?? {};
        const cur = levels[techRadio.value] ?? 0;
        rsLevelInput.value = String(cur + 1);
      };
      for (const r of rsTechRadios()) r.addEventListener("change", () => { prefillRsLevel(); refreshRsDesc(); });
      rsLevelInput?.addEventListener("input", refreshRsDesc);
      refreshRsDesc();
      const rsPlanetRadios = (): HTMLInputElement[] => Array.from(
        m.querySelectorAll<HTMLInputElement>('input[name="rs-planet-radio"]'),
      );
      // v0.0.686 — operator 2026-06-03 "默认星球是当前星球". Pre-check the
      // radio for operator's currently-viewed planet (ogame-planet-id meta).
      {
        const ogameCurrentPid = doc.querySelector<HTMLMetaElement>('meta[name="ogame-planet-id"]')?.content ?? "";
        if (ogameCurrentPid) {
          const cur = m.querySelector<HTMLInputElement>(`input[name="rs-planet-radio"][value="${ogameCurrentPid}"]`);
          if (cur) cur.checked = true;
        }
      }
      rsCreateBtn?.addEventListener("click", async () => {
        if (!rsStatusEl) return;
        const techRadio = rsTechRadios().find((r) => r.checked);
        const planetRadio = rsPlanetRadios().find((r) => r.checked);
        const lvl = parseInt(rsLevelInput?.value ?? "", 10);
        const pri = parseInt(rsPriorityInput?.value ?? "5", 10) || 5;
        if (!techRadio) { rsStatusEl.textContent = t("auto.076"); rsStatusEl.style.color = "#a06060"; return; }
        if (!planetRadio) { rsStatusEl.textContent = t("auto.045"); rsStatusEl.style.color = "#a06060"; return; }
        if (!lvl || lvl < 1 || lvl > 30) { rsStatusEl.textContent = t("auto.077"); rsStatusEl.style.color = "#a06060"; return; }
        rsStatusEl.textContent = t("auto.048"); rsStatusEl.style.color = "#7080a0";
        try {
          const r = await fetchFn(`${baseUrl.replace(/\/$/, "")}/ogamex/v1/goals/create`, {
            method: "POST",
            headers: authHeadersGlobal({ "Content-Type": "application/json" }),
            body: JSON.stringify({
              type: "research",
              target: { tech: techRadio.value, level: lvl },
              planet: planetRadio.value,
              priority: pri,
            }),
          });
          if (r.ok) {
            rsStatusEl.textContent = t("auto.078");
            rsStatusEl.style.color = "#7cfc00";
          } else {
            rsStatusEl.textContent = `HTTP ${r.status}`;
            rsStatusEl.style.color = "#a06060";
          }
        } catch (e) {
          rsStatusEl.textContent = `error: ${(e as Error).message ?? e}`;
          rsStatusEl.style.color = "#a06060";
        }
      });
    }

    // v0.0.602 — lf-research pane wiring (per-species research catalog).
    {
      type LfResearch = { id: string; display_name_zh?: string; display_name_en?: string };
      const lrSpeciesRadios = (): HTMLInputElement[] => Array.from(
        m.querySelectorAll<HTMLInputElement>('input[name="lr-species-radio"]'),
      );
      const lrPlanetRadios = (): HTMLInputElement[] => Array.from(
        m.querySelectorAll<HTMLInputElement>('input[name="lr-planet-radio"]'),
      );
      const lrTechRadios = (): HTMLInputElement[] => Array.from(
        m.querySelectorAll<HTMLInputElement>('input[name="lr-tech-radio"]'),
      );
      const lrResearchList = m.querySelector<HTMLElement>("[data-lr-research-list]");
      const lrLevelInput = m.querySelector<HTMLInputElement>("[data-lr-level]");
      const lrDescEl = m.querySelector<HTMLElement>("[data-lr-desc]");
      const lrPriorityInput = m.querySelector<HTMLInputElement>("[data-lr-priority]");
      const lrStatusEl = m.querySelector<HTMLElement>("[data-lr-status]");
      const lrCreateBtn = m.querySelector<HTMLButtonElement>("[data-lr-create]");
      const currentLrLabels = new Map<string, string>();
      // v0.0.605 — operator 2026-06-01 真相: lifeform_research is per-planet,
      // not per-species globally. ogame may carry research entries from
      // multiple species on the same planet (historical species switches).
      // v0.0.615 — operator 2026-06-01 "不要兜底，網頁上有名字". Labels
      // come from store.tech_labels (harvested from ogame DOM at
      // lfresearch page visit). No catalog fallback. If a tech has no
      // harvested label (planet/page not yet visited), show the canonical
      // key + a hint to visit the page.
      // v0.0.620 — operator "已經切換了種族的星球老科技是無效的". Defense
      // in depth: even if boot-sync hasn't replaced stale entries yet,
      // filter at render time by planet's CURRENT species. lf research IDs
      // are species-tagged by prefix (11xxx human, 12xxx rocktal,
      // 13xxx mecha, 14xxx kaelesh).
      const techSpeciesOf = (canonical: string): string | null => {
        const tid = TECH_ID_BY_NAME[canonical];
        if (typeof tid !== "number") return null;
        const prefix = Math.floor(tid / 1000);
        if (prefix === 11) return "humans";
        if (prefix === 12) return "rocktal";
        if (prefix === 13) return "mechas";
        if (prefix === 14) return "kaelesh";
        return null;
      };
      const renderLrResearch = (_species: string): void => {
        if (!lrResearchList) return;
        const planetRadio = lrPlanetRadios().find((r) => r.checked);
        const planetState = planetRadio
          ? (storeRef?.state?.planets?.[planetRadio.value] as { lifeform_research?: Record<string, number>; lifeform?: { species?: string } | null } | undefined)
          : undefined;
        const lfr = planetState?.lifeform_research ?? {};
        const planetSpecies = planetState?.lifeform?.species ?? null;
        const techLabels = (storeRef?.state as { tech_labels?: Record<string, string> } | undefined)?.tech_labels ?? {};
        // v0.0.626 — operator 2026-06-01 "1:486:7 就不同". Dump per-planet
        // state at render time so we can see in console whether store has
        // distinct per-planet lifeform_research or all leak to current cp.
        if (planetRadio) {
          const coord = planetCoordById.get(planetRadio.value) ?? "?";
          const lfrSummary = Object.entries(lfr).map(([k, v]) => `${k}=${v}`).join(",");
          console.info(`[panel/lf-research/render] planet=${planetRadio.value} coord=${coord} species=${planetSpecies} entries=${Object.keys(lfr).length} lfr={${lfrSummary}}`);
        }
        currentLrLabels.clear();
        // v0.0.628 — operator 2026-06-01 "3:260:9 用了一個人類科技".
        // ogame allows cross-species lf research via artifacts (3,600
        // artifacts = swap one tech to a non-native species). 3:260:9
        // has humans 11201 (星際使者 L5) alongside kaelesh 14202-14212.
        // The lfresearch page IS ground truth, and boot-sync REPLACE
        // already writes exactly what the page renders. So drop the
        // render-time species filter — show everything in store.
        // Old species entries from before a species switch were already
        // evicted by REPLACE; this filter was only blocking legit
        // artifact-swapped foreign techs.
        const entries = Object.entries(lfr);
        // Suppress unused-var warning while keeping the helper for future
        // diagnostics (planetSpecies could feed a "filter foreign" toggle).
        void planetSpecies;
        if (entries.length === 0) {
          lrResearchList.innerHTML = planetRadio
            ? t("auto.079")
            : t("auto.080");
          return;
        }
        // v0.0.627 — operator 2026-06-01 "研究按照 id 排序". Match the
        // order ogame's lfresearch page renders: ascending numeric ID
        // (T1 first, then T2, then T3 — natural sequence operator sees).
        // v0.0.665 — operator "LF 科技都是中文" + "中文名称不是 ogame 专有
        // 名词": catalog lookup for EN (techLabels is server-locale TC
        // which leaks into EN mode). Search all 4 species catalogs
        // because artifact swap can put any tech on any planet.
        type LfResearchEntry = { display_name_zh?: string; display_name_en?: string };
        const lookupLfResearch = (key: string): LfResearchEntry | undefined => {
          const cats = LIFEFORM_TECH as Record<string, { research?: Record<string, LfResearchEntry> }>;
          for (const species of Object.keys(cats)) {
            const entry = cats[species]?.research?.[key];
            if (entry) return entry;
          }
          return undefined;
        };
        const html = entries
          .sort(([a], [b]) => {
            const ia = TECH_ID_BY_NAME[a] ?? Number.POSITIVE_INFINITY;
            const ib = TECH_ID_BY_NAME[b] ?? Number.POSITIVE_INFINITY;
            return ia - ib;
          })
          .map(([k, lvl]) => {
            const entry = lookupLfResearch(k) ?? {};
            const name = pickLfName(entry, k, techLabels);
            currentLrLabels.set(k, name);
            return `<label style="display:flex; align-items:center; gap:6px; cursor:pointer; color:#d0d8e0; font-size:11px;" title="${escapeHtml(t('auto.288'))} L${lvl}"><input type="radio" name="lr-tech-radio" value="${escapeHtml(k)}" style="vertical-align:middle;"/><span>${escapeHtml(name)} <span style="color:#7080a0;">L${lvl}</span></span></label>`;
          }).join("");
        lrResearchList.innerHTML = html;
        for (const r of lrTechRadios()) r.addEventListener("change", () => { prefillLrLevel(); refreshLrDesc(); });
      };
      // v0.0.767 — operator 2026-06-04: 选 planet+tech 后自动填 current+1.
      const prefillLrLevel = (): void => {
        if (!lrLevelInput) return;
        const planetRadio = lrPlanetRadios().find((r) => r.checked);
        const techRadio = lrTechRadios().find((r) => r.checked);
        if (!planetRadio || !techRadio) return;
        const planetState = (storeRef?.state?.planets?.[planetRadio.value] ?? {}) as { lifeform_research?: Record<string, number> };
        const cur = planetState.lifeform_research?.[techRadio.value] ?? 0;
        lrLevelInput.value = String(cur + 1);
      };
      const speciesLabelMapLr: Record<string, string> = { humans: t("auto.056"), rocktal: t("auto.057"), mechas: t("auto.058"), kaelesh: t("auto.059") };
      // v0.0.603 — per-planet current level display. lifeform_research is
      // per-planet (operator 2026-06-01 "生命研究每個星球是不同的"), read
      // from store.planets[pid].lifeform_research[tech].
      const refreshLrDesc = (): void => {
        if (!lrDescEl) return;
        const speciesRadio = lrSpeciesRadios().find((r) => r.checked);
        const planetRadio = lrPlanetRadios().find((r) => r.checked);
        const techRadio = lrTechRadios().find((r) => r.checked);
        const lvl = parseInt(lrLevelInput?.value ?? "", 10);
        if (!speciesRadio || !planetRadio || !techRadio) {
          lrDescEl.textContent = t("auto.081");
          lrDescEl.style.color = "#5a7090";
          return;
        }
        const tLabel = currentLrLabels.get(techRadio.value) ?? techRadio.value;
        const sn = speciesLabelMapLr[speciesRadio.value] ?? speciesRadio.value;
        const coord = planetCoordById.get(planetRadio.value) ?? "?";
        const lfResearch = (storeRef?.state?.planets?.[planetRadio.value] as { lifeform_research?: Record<string, number> } | undefined)?.lifeform_research ?? {};
        const curLvl = lfResearch[techRadio.value] ?? 0;
        const curPart = t("auto.175", { coord, t: tLabel, lvl: curLvl });
        if (!lvl) {
          lrDescEl.textContent = t("auto.176", { cur: curPart, sn });
        } else {
          lrDescEl.textContent = t("auto.177", { cur: curPart, lvl, sn });
        }
        lrDescEl.style.color = "#7cfc00";
      };
      const speciesLabelLrMap: Record<string, string> = { humans: t("auto.056"), rocktal: t("auto.057"), mechas: t("auto.058"), kaelesh: t("auto.059") };
      // v0.0.607 — operator 2026-06-01 bug ①: species change should dim
      // planet rows whose species ≠ selected (mirror lf-build).
      const applyLrSpeciesFilter = (species: string): void => {
        for (const radio of lrPlanetRadios()) {
          const pid = radio.value;
          const sp = livePlanetSpecies(pid);
          const matches = sp === species;
          const label = radio.closest("label") as HTMLElement | null;
          if (!label) continue;
          if (!matches) {
            radio.disabled = true;
            label.style.opacity = "0.3";
            label.style.cursor = "not-allowed";
            label.title = sp
              ? t("auto.169", { sp1: speciesLabelLrMap[sp] ?? sp, sp2: speciesLabelLrMap[species] ?? species })
              : t("auto.082");
          } else {
            radio.disabled = false;
            label.style.opacity = "1";
            label.style.cursor = "pointer";
            label.title = "";
          }
        }
        const checked = lrPlanetRadios().find((r) => r.checked);
        if (checked?.disabled) checked.checked = false;
      };
      // v0.0.625 — operator 2026-06-01 "是沒有更新嗎?". Two add-ons:
      // 1. 🔄 button: force-fetch the SELECTED planet's lfresearch (uses
      //    refreshOnePage with forcePlanetId; REPLACES store data).
      // 2. Auto-rerender on store updates so post-fetch the new data
      //    surfaces without operator clicking the radio again.
      const lrForceSyncBtn = m.querySelector<HTMLButtonElement>("[data-lr-force-sync]");
      if (lrForceSyncBtn) {
        lrForceSyncBtn.addEventListener("click", async () => {
          const planetRadio = lrPlanetRadios().find((r) => r.checked);
          if (!planetRadio) {
            if (lrResearchList) lrResearchList.innerHTML = t("auto.083");
            return;
          }
          const pid = planetRadio.value;
          const refreshFn = (window as Window & { __ogamexRefreshOnePage?: (forcePage?: string, forcePlanetId?: string) => Promise<void> }).__ogamexRefreshOnePage;
          if (typeof refreshFn !== "function") return;
          const origLabel = lrForceSyncBtn.textContent;
          lrForceSyncBtn.disabled = true;
          lrForceSyncBtn.textContent = t("auto.084");
          try {
            console.info(`[panel/lf-research] force-sync planet=${pid}`);
            await refreshFn("lfresearch", pid);
            console.info(`[panel/lf-research] force-sync planet=${pid} done`);
            // Re-render with the freshly-replaced store data.
            renderLrResearch(livePlanetSpecies(pid) ?? "kaelesh");
            refreshLrDesc();
          } catch (e) {
            console.warn(`[panel/lf-research] force-sync planet=${pid} failed`, e);
          } finally {
            lrForceSyncBtn.disabled = false;
            lrForceSyncBtn.textContent = origLabel;
          }
        });
      }
      const initLrSpecies = lrSpeciesRadios().find((r) => r.checked)?.value ?? "kaelesh";
      renderLrResearch(initLrSpecies);
      applyLrSpeciesFilter(initLrSpecies);
      for (const r of lrSpeciesRadios()) r.addEventListener("change", () => {
        applyLrSpeciesFilter(r.value);
        renderLrResearch(r.value);
        refreshLrDesc();
      });
      // v0.0.604 — operator 2026-06-01 "選擇星球的時候, 顯示當前星球的生命
      // 科技". Two-piece UX: (a) annotate each planet row with [species tag]
      // (b) on planet change, auto-pick the matching species radio so the
      // research catalog re-renders for the planet's actual species.
      for (const radio of lrPlanetRadios()) {
        const pid = radio.value;
        const sp = livePlanetSpecies(pid);
        const tag = sp ? speciesLabelMapLr[sp] ?? sp : t("auto.060");
        const span = radio.parentElement?.querySelector("span");
        if (span && !span.textContent?.includes("[")) {
          span.textContent = `${span.textContent} [${tag}]`;
        }
      }
      // v0.0.608 — operator 2026-06-01 "不要猜, 不懂要去看官方文檔".
      // Auto-fetch lfresearch page on planet pick if store is empty for
      // that planet. The page's HTML carries the REAL data-technology IDs
      // and levels — no more catalog guessing. Uses cpPostWithRetry (the
      // standard cp= entry) so cp shift is properly restored.
      const fetchLfResearchForPlanet = async (pid: string): Promise<void> => {
        if (!lrResearchList) return;
        const existing = (storeRef?.state?.planets?.[pid] as { lifeform_research?: Record<string, number> } | undefined)?.lifeform_research;
        if (existing && Object.keys(existing).length > 0) return; // already loaded
        lrResearchList.innerHTML = t("auto.085");
        try {
          // Trigger boot.ts page-aware extraction via the exposed force
          // refresh hook. boot.ts will fetch component=lfresearch, parse
          // technology entries, bucket all into lifeform_research, and
          // merge into store.planets[pid]. Within ~1.5s renderLrResearch
          // sees live data.
          const refreshFn = (window as Window & { __ogamexRefreshOnePage?: (forcePage?: string) => Promise<void> }).__ogamexRefreshOnePage;
          if (typeof refreshFn === "function") await refreshFn("lfresearch");
          // refreshOnePage targets the currently-viewed planet's lfresearch
          // page (cp=meta-planet-id), so this only fills data for the
          // operator's CURRENT planet. To collect data for other planets
          // operator must first navigate there in ogame UI (sniffer events
          // pick it up automatically thereafter).
        } catch (e) {
          console.warn("[lf-research] auto-fetch failed:", e);
        }
        // Re-render whether or not fetch produced data.
        renderLrResearch(livePlanetSpecies(pid) ?? "kaelesh");
        refreshLrDesc();
      };
      for (const r of lrPlanetRadios()) r.addEventListener("change", () => {
        // v0.0.605 — research list is per-planet (live lifeform_research keys),
        // so always re-render when planet changes. Also auto-sync species
        // radio for cosmetic consistency (panel still shows species tag).
        const sp = livePlanetSpecies(r.value);
        if (sp) {
          const target = m.querySelector<HTMLInputElement>(`input[name="lr-species-radio"][value="${sp}"]`);
          if (target) target.checked = true;
        }
        renderLrResearch(sp ?? "kaelesh");
        prefillLrLevel();  // v0.0.767 — planet 换了 → 新 planet 的 current+1
        refreshLrDesc();
        // v0.0.608 fire-and-forget auto-fetch.
        void fetchLfResearchForPlanet(r.value);
      });
      lrLevelInput?.addEventListener("input", refreshLrDesc);
      refreshLrDesc();
      lrCreateBtn?.addEventListener("click", async () => {
        if (!lrStatusEl) return;
        const planetRadio = lrPlanetRadios().find((r) => r.checked);
        const techRadio = lrTechRadios().find((r) => r.checked);
        const lvl = parseInt(lrLevelInput?.value ?? "", 10);
        const pri = parseInt(lrPriorityInput?.value ?? "5", 10) || 5;
        if (!planetRadio) { lrStatusEl.textContent = t("auto.045"); lrStatusEl.style.color = "#a06060"; return; }
        if (!techRadio) { lrStatusEl.textContent = t("auto.076"); lrStatusEl.style.color = "#a06060"; return; }
        if (!lvl || lvl < 1 || lvl > 50) { lrStatusEl.textContent = t("auto.047"); lrStatusEl.style.color = "#a06060"; return; }
        lrStatusEl.textContent = t("auto.048"); lrStatusEl.style.color = "#7080a0";
        try {
          const r = await fetchFn(`${baseUrl.replace(/\/$/, "")}/ogamex/v1/goals/create`, {
            method: "POST",
            headers: authHeadersGlobal({ "Content-Type": "application/json" }),
            body: JSON.stringify({
              type: "lifeform_research",
              target: { tech: techRadio.value, level: lvl },
              planet: planetRadio.value,
              priority: pri,
            }),
          });
          if (r.ok) {
            lrStatusEl.textContent = t("auto.086");
            lrStatusEl.style.color = "#7cfc00";
          } else {
            lrStatusEl.textContent = `HTTP ${r.status}`;
            lrStatusEl.style.color = "#a06060";
          }
        } catch (e) {
          lrStatusEl.textContent = `error: ${(e as Error).message ?? e}`;
          lrStatusEl.style.color = "#a06060";
        }
      });
    }

    // v0.0.687 — colonize pane wiring. Source planet picker (default current),
    // 3 range pairs (galaxy/system/position), last-status fetch from sidecar
    // events, start button POST. Backend (planner.ts scan + dispatch state
    // machine) staged for v0.0.688 — operator 2026-06-03.
    {
      const clPlanetRadios = (): HTMLInputElement[] => Array.from(
        m.querySelectorAll<HTMLInputElement>('input[name="cl-planet-radio"]'),
      );
      const clGalaxy = m.querySelector<HTMLSelectElement>("[data-cl-galaxy]");
      const clSmin = m.querySelector<HTMLInputElement>("[data-cl-s-min]");
      const clSmax = m.querySelector<HTMLInputElement>("[data-cl-s-max]");
      const clPmin = m.querySelector<HTMLSelectElement>("[data-cl-p-min]");
      const clPmax = m.querySelector<HTMLSelectElement>("[data-cl-p-max]");
      const clPriority = m.querySelector<HTMLInputElement>("[data-cl-priority]");
      const clStatusEl = m.querySelector<HTMLElement>("[data-cl-status]");
      const clLastEl = m.querySelector<HTMLElement>("[data-cl-last]");
      const clCreateBtn = m.querySelector<HTMLButtonElement>("[data-cl-create]");
      // Default-check current planet (operator 2026-06-03 "默认星球是当前星球").
      {
        const ogameCurrentPid = doc.querySelector<HTMLMetaElement>('meta[name="ogame-planet-id"]')?.content ?? "";
        if (ogameCurrentPid) {
          const cur = m.querySelector<HTMLInputElement>(`input[name="cl-planet-radio"][value="${ogameCurrentPid}"]`);
          if (cur) cur.checked = true;
        }
      }
      // Fetch last colonize event from sidecar /v1/events (best-effort —
      // backend wiring lands in v0.0.688; until then this 404s silently).
      if (clLastEl) {
        void (async () => {
          try {
            const r = await fetchFn(`${baseUrl.replace(/\/$/, "")}/ogamex/v1/events?type=colonize_done&limit=1`);
            if (!r.ok) return;
            const j = await r.json() as { events?: Array<{ ts?: number; success?: boolean; coord?: string; reason?: string }> };
            const ev = j.events?.[0];
            if (!ev) return;
            const txt = ev.success
              ? `${t("auto.284")}: ✅ ${ev.coord ?? "?"}`
              : `${t("auto.284")}: ❌ ${ev.reason ?? "?"}`;
            clLastEl.textContent = txt;
            clLastEl.style.color = ev.success ? "#7cfc00" : "#a06060";
          } catch { /* */ }
        })();
      }
      clCreateBtn?.addEventListener("click", async () => {
        if (!clStatusEl) return;
        const planetRadio = clPlanetRadios().find((r) => r.checked);
        const galaxy = parseInt(clGalaxy?.value ?? "", 10);
        const sMin = parseInt(clSmin?.value ?? "", 10);
        const sMax = parseInt(clSmax?.value ?? "", 10);
        const pMin = parseInt(clPmin?.value ?? "", 10);
        const pMax = parseInt(clPmax?.value ?? "", 10);
        const pri = parseInt(clPriority?.value ?? "5", 10) || 5;
        if (!planetRadio) { clStatusEl.textContent = t("auto.045"); clStatusEl.style.color = "#a06060"; return; }
        const rangeOk =
          Number.isFinite(galaxy) && galaxy >= 1 && galaxy <= 9
          && Number.isFinite(sMin) && Number.isFinite(sMax) && sMin >= 1 && sMax <= 499 && sMin <= sMax
          && Number.isFinite(pMin) && Number.isFinite(pMax) && pMin >= 1 && pMax <= 15 && pMin <= pMax;
        if (!rangeOk) { clStatusEl.textContent = t("auto.287"); clStatusEl.style.color = "#a06060"; return; }
        clStatusEl.textContent = t("auto.048"); clStatusEl.style.color = "#7080a0";
        try {
          const r = await fetchFn(`${baseUrl.replace(/\/$/, "")}/ogamex/v1/goals/create`, {
            method: "POST",
            headers: authHeadersGlobal({ "Content-Type": "application/json" }),
            body: JSON.stringify({
              type: "colonize",
              target: {
                source_planet: planetRadio.value,
                // v0.0.690 — single galaxy (sidecar schema still has range; map to min=max=N)
                galaxy_min: galaxy, galaxy_max: galaxy,
                system_min: sMin, system_max: sMax,
                position_min: pMin, position_max: pMax,
              },
              planet: planetRadio.value,
              priority: pri,
            }),
          });
          if (r.ok) {
            clStatusEl.textContent = t("auto.292");
            clStatusEl.style.color = "#7cfc00";
          } else {
            clStatusEl.textContent = `HTTP ${r.status}`;
            clStatusEl.style.color = "#a06060";
          }
        } catch (e) {
          clStatusEl.textContent = `error: ${(e as Error).message ?? e}`;
          clStatusEl.style.color = "#a06060";
        }
      });
    }

    // Operator 2026-05-29: planet radio change → auto-fill the coord prefix
    // into the NL textarea so the operator can keep typing the rest of the
    // instruction. Replaces an existing "在 G:S:P " head; otherwise prepends.
    // "(不指定)" radio strips the prefix entirely.
    const nlTa = m.querySelector<HTMLTextAreaElement>("[data-goal-nl]");
    const coordsForId = new Map<string, string>();
    for (const k of sortedCoordKeys) {
      const { planet, moon } = groupedByCoord.get(k)!;
      if (planet) coordsForId.set(planet.id, k);
      if (moon) coordsForId.set(moon.id, k);
    }
    const PREFIX_RE = /^在\s*\d+:\d+:\d+\s*/;
    for (const r of m.querySelectorAll<HTMLInputElement>('input[name="goal-planet-radio"]')) {
      r.addEventListener("change", () => {
        if (!nlTa || !r.checked) return;
        const coord = coordsForId.get(r.value);
        if (!coord) {
          nlTa.value = nlTa.value.replace(PREFIX_RE, "");
        } else {
          const newPrefix = t("auto.178", { coord }) + " ";
          nlTa.value = PREFIX_RE.test(nlTa.value)
            ? nlTa.value.replace(PREFIX_RE, newPrefix)
            : newPrefix + nlTa.value;
        }
        nlTa.focus();
        // Cursor to end so operator can keep typing.
        nlTa.setSelectionRange(nlTa.value.length, nlTa.value.length);
      });
    }
    // Operator 2026-05-29: NL parse button — POST description → sidecar
    // Gemini → fill type/planet/target/priority fields with parsed result.
    m.querySelector<HTMLElement>("[data-goal-nl-parse]")?.addEventListener("click", async () => {
      const ta = m.querySelector<HTMLTextAreaElement>("[data-goal-nl]");
      const status = m.querySelector<HTMLElement>("[data-goal-nl-status]");
      const description = (ta?.value ?? "").trim();
      if (!description) {
        if (status) { status.textContent = t("auto.087"); status.style.color = "#ff6b6b"; }
        return;
      }
      if (status) { status.textContent = "parsing…"; status.style.color = "#7080a0"; }
      try {
        const r = await fetchFn(`${baseUrl}/ogamex/v1/goals/parse`, {
          method: "POST",
          headers: authHeadersGlobal({ "Content-Type": "application/json" }),
          body: JSON.stringify({ description }),
        });
        const j = await r.json() as { ok?: boolean; parsed?: { type: string; target: Record<string, unknown>; planet?: string; priority?: number }; reason?: string };
        if (!r.ok || !j.ok || !j.parsed) throw new Error(j.reason ?? `HTTP ${r.status}`);
        // Apply parsed → form.
        if (typeSel && j.parsed.type) {
          typeSel.value = j.parsed.type;
          // Trigger placeholder refresh first, then overwrite target.
          refreshPreset();
        }
        if (targetTa) targetTa.value = JSON.stringify(j.parsed.target, null, 2);
        const prioInput = m.querySelector<HTMLInputElement>("[data-goal-priority]");
        if (prioInput && typeof j.parsed.priority === "number") prioInput.value = String(j.parsed.priority);
        if (j.parsed.planet) {
          const radio = m.querySelector<HTMLInputElement>(`input[name="goal-planet-radio"][value="${j.parsed.planet}"]`);
          if (radio) radio.checked = true;
        }
        if (status) { status.textContent = t("auto.088"); status.style.color = "#7cfc00"; }
      } catch (e) {
        if (status) { status.textContent = `× ${(e as Error).message}`; status.style.color = "#ff6b6b"; }
      }
    });
    m.querySelector<HTMLElement>("[data-goal-create]")?.addEventListener("click", async () => {
      const status = m.querySelector<HTMLElement>("[data-goal-status]");
      const type = typeSel?.value ?? "";
      const checked = m.querySelector<HTMLInputElement>('input[name="goal-planet-radio"]:checked');
      const planetSel = checked?.value || "";
      const priorityStr = m.querySelector<HTMLInputElement>("[data-goal-priority]")?.value ?? "5";
      const priority = Math.max(1, Math.min(20, parseInt(priorityStr, 10) || 5));
      let target: Record<string, unknown>;
      try {
        const raw = (targetTa?.value ?? "").trim();
        if (!raw) throw new Error(t("auto.089"));
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(t("auto.090"));
        target = parsed;
      } catch (e) {
        if (status) { status.textContent = `× ${(e as Error).message}`; status.style.color = "#ff6b6b"; }
        return;
      }
      // v0.0.451: fanout — "all-planets" / "all-moons" iterates every
      // matching body and POSTs one goal per. Single-planet radio still
      // sends one POST. Operator 2026-05-29: "不指定 — 讓 planner 預設"
      // 改成"所有星球",並加"所有月球"扇出。
      const planetIds: (string | undefined)[] = [];
      if (planetSel === "all-planets") {
        for (const k of sortedCoordKeys) {
          const p = groupedByCoord.get(k)?.planet;
          if (p) planetIds.push(p.id);
        }
        if (planetIds.length === 0) {
          if (status) { status.textContent = t("auto.091"); status.style.color = "#ff6b6b"; }
          return;
        }
      } else if (planetSel === "all-moons") {
        for (const k of sortedCoordKeys) {
          const mn = groupedByCoord.get(k)?.moon;
          if (mn) planetIds.push(mn.id);
        }
        if (planetIds.length === 0) {
          if (status) { status.textContent = t("auto.092"); status.style.color = "#ff6b6b"; }
          return;
        }
      } else {
        planetIds.push(planetSel || undefined);
      }
      if (status) { status.textContent = `creating ${planetIds.length} goal(s)…`; status.style.color = "#7080a0"; }
      const created: string[] = [];
      const errors: string[] = [];
      for (const pid of planetIds) {
        try {
          const r = await fetchFn(`${baseUrl}/ogamex/v1/goals/create`, {
            method: "POST",
            headers: authHeadersGlobal({ "Content-Type": "application/json" }),
            body: JSON.stringify({ type, target, planet: pid, priority }),
          });
          if (!r.ok) {
            const j = await r.json().catch(() => ({ reason: `HTTP ${r.status}` })) as { reason?: string };
            throw new Error(j.reason ?? `HTTP ${r.status}`);
          }
          const j = await r.json() as { ok?: boolean; goal_id?: string; reason?: string };
          if (!j.ok) throw new Error(j.reason ?? "rejected");
          if (j.goal_id) created.push(j.goal_id);
        } catch (e) {
          errors.push(`${pid ?? "(default)"}: ${(e as Error).message}`);
        }
      }
      if (status) {
        if (errors.length === 0) {
          status.textContent = `✓ created ${created.length} goal(s)`;
          status.style.color = "#7cfc00";
          setTimeout(() => m.remove(), 800);
        } else {
          status.textContent = `partial: ${created.length} OK, ${errors.length} fail — ${errors[0]}`;
          status.style.color = "#ff9b6b";
        }
      }
    });
  });
}

// M5 — Transport settings modal. Operator 2026-05-29 spec:
//   1. 選擇運輸艦的來源星球 (displays LC/SC counts on that planet),
//      checkbox "空船跳躍門可用時 是否使用跳躍門".
//   2. 資源所在星球 — pick planet, shows M/C/D, lets operator override
//      the amount to ship per resource, computes needed LC vs SC.
//   3. 目標星球.
//   4. 選 LC or SC → 自動填入數量 = ceil(total_res / ship_cap).
// Submit: Phase 1 POSTs a single `transport` goal (sidecar's existing
// type). Phase 2 will add the JG-aware multi-hop chain (deploy →
// jumpgate → deploy → transport).
function openTransportSettings(
  doc: Document,
  baseUrl: string,
  fetchFn: typeof fetch,
  prefill?: { targetPlanetId?: string; cargo?: { m: number; c: number; d: number } },
): void {
  const placeholder = `<div style="color:#7080a0; padding:8px 0;">loading state…</div>`;
  openSettingsModal(doc, "transport", t("modal.transport.title"), placeholder, async (m) => {
    const body = m.querySelector<HTMLElement>("div[role='dialog'] > div:nth-of-type(2)");
    if (!body) return;
    // v0.0.676 — operator 2026-06-03: shortage-fill entry path (operator
    // clicked "→ 運輸" on a goal row) gets the OLD behaviour back:
    //   1. ship type renders as radio (mutually exclusive, no JS mutex)
    //   2. Quantity = ceil(cargoTotal / cap) (the needed count)
    // Manual entry path (no prefill cargo) keeps v0.0.669/672 behaviour:
    //   1. checkbox + JS mutex
    //   2. Quantity = source planet's actual LC/SC count
    // Discriminated by whether prefill.cargo is present.
    const isShortageFill = !!prefill?.cargo;
    const shipInputType = isShortageFill ? "radio" : "checkbox";
    interface StorePlanet { id: string; type?: string; coords?: number[]; name?: string; resources?: { m?: number; c?: number; d?: number }; ships?: Record<string, number> }
    const storeRef = (window as Window & { __ogamexStore?: { state?: { planets?: Record<string, StorePlanet>; server?: { ship_cargo_capacity?: Record<string, number> } } } }).__ogamexStore;
    const planetsMap = storeRef?.state?.planets ?? {};
    const allPlanets = Object.values(planetsMap)
      .filter((p): p is StorePlanet => Array.isArray(p?.coords) && p.coords.length === 3)
      .sort((a, b) => {
        const ac = a.coords ?? [0, 0, 0]; const bc = b.coords ?? [0, 0, 0];
        for (let i = 0; i < 3; i++) {
          const av = ac[i] ?? 0; const bv = bc[i] ?? 0;
          if (av !== bv) return av - bv;
        }
        if (a.type !== b.type) return a.type === "planet" ? -1 : 1;
        return 0;
      });
    const ltCap = storeRef?.state?.server?.ship_cargo_capacity?.largeCargo ?? 25000;
    const stCap = storeRef?.state?.server?.ship_cargo_capacity?.smallCargo ?? 5000;
    const inputStyle = "background:#0a1018; color:#e0e8f0; border:1px solid #2a3a52; border-radius:3px; padding:3px 6px; font-size:11px;";
    const fmt = (n: number): string => n.toLocaleString("en-US");
    // Operator 2026-05-29: 所有星球選擇框統一 2 列 grid (行星 | 月球).
    // Group by coord key so planet + sibling moon share the same row.
    const groupedByCoord = new Map<string, { planet?: StorePlanet; moon?: StorePlanet }>();
    for (const p of allPlanets) {
      const k = (p.coords ?? []).join(":");
      if (!k) continue;
      const slot = groupedByCoord.get(k) ?? {};
      if (p.type === "moon") slot.moon = p; else slot.planet = p;
      groupedByCoord.set(k, slot);
    }
    const sortedCoordKeys = [...groupedByCoord.keys()].sort((a, b) => {
      const an = a.split(":").map((s) => parseInt(s, 10));
      const bn = b.split(":").map((s) => parseInt(s, 10));
      for (let i = 0; i < 3; i++) {
        const av = an[i] ?? 0; const bv = bn[i] ?? 0;
        if (av !== bv) return av - bv;
      }
      return 0;
    });
    // v0.0.512 — operator 2026-05-31: 改成 type 切換 + 2 列 coord cells.
    // 頭排 radio "🌍 星球 / 🌙 月球" 切類型, 下面 coord cells 2 列, 每 cell
    // 是 [G:S:P] + 選擇 radio. 切換 type 時顯示對應類型的 cells。
    // v0.0.519 — empire-wide moon count, drives type-toggle moon disable.
    const hasAnyMoon = sortedCoordKeys.some(k => !!groupedByCoord.get(k)?.moon);
    const planetSelectHtml = (radioName: string, includeUnset = false): string => {
      const moonAttrs = hasAnyMoon
        ? `data-tr-type-toggle="${radioName}"`
        : `data-tr-type-toggle="${radioName}" disabled`;
      const moonLabelStyle = hasAnyMoon ? "cursor:pointer;" : "cursor:not-allowed; opacity:0.4;";
      const typeRadio = `<div style="padding:6px 8px; display:flex; gap:14px; font-size:11px; color:#d0d8e0; border-bottom:1px solid #2a3a52; background:#0a1018; position:sticky; top:0;">
        <label style="cursor:pointer;"><input type="radio" name="${radioName}-type" value="planet" checked data-tr-type-toggle="${radioName}" style="margin-right:4px; vertical-align:middle;"/>🌍 ${escapeHtml(t('common.planet'))}</label>
        <label style="${moonLabelStyle}" title="${hasAnyMoon ? "" : escapeHtml(t('auto.265'))}"><input type="radio" name="${radioName}-type" value="moon" ${moonAttrs} style="margin-right:4px; vertical-align:middle;"/>🌙 ${escapeHtml(t('auto.118'))}</label>
      </div>`;
      const unset = includeUnset
        ? `<div style="padding:4px 8px; border-bottom:1px solid #1a2030;">
            <label style="cursor:pointer; color:#7080a0; font-size:11px;">
              <input type="radio" name="${radioName}" value="" checked style="margin-right:6px; vertical-align:middle;"/>${escapeHtml(t('auto.247'))}
            </label>
          </div>`
        : "";
      // Build cells: 2-col flex grid, each cell = one body of selected type.
      // Render BOTH types up front, toggle visibility via data attr + JS.
      const buildCells = (kind: "planet" | "moon"): string => {
        const cells = sortedCoordKeys.map((k) => {
          const { planet, moon } = groupedByCoord.get(k)!;
          const body = kind === "planet" ? planet : moon;
          if (!body) {
            return `<div style="flex:0 0 50%; padding:3px 6px; box-sizing:border-box; color:#3a4658; font-size:11px; font-style:italic;">[${escapeHtml(k)}] —</div>`;
          }
          const icon = kind === "planet" ? "🌍" : "🌙";
          return `<label style="flex:0 0 50%; padding:3px 6px; box-sizing:border-box; cursor:pointer; color:#d0d8e0; font-size:11px; display:inline-flex; align-items:center; gap:4px;">
            <input type="radio" name="${radioName}" value="${escapeHtml(body.id)}" data-tr-planet-id="${escapeHtml(body.id)}" data-tr-body-kind="${kind}" style="margin:0;"/>
            <span>${icon}[${escapeHtml(k)}]</span>
          </label>`;
        }).join("");
        return `<div data-tr-body-section="${kind}" style="display:${kind === "planet" ? "flex" : "none"}; flex-wrap:wrap;">${cells}</div>`;
      };
      return typeRadio + unset + buildCells("planet") + buildCells("moon");
    };
    const sectionCard = (title: string, inner: string): string =>
      `<div style="padding:8px 10px; background:#0a1018; border:1px solid #2a3a52; border-radius:4px; margin-bottom:8px;">
        <div style="color:#7080a0; font-size:10px; padding-bottom:6px; border-bottom:1px solid #1a2030; margin-bottom:6px;">${title}</div>
        ${inner}
      </div>`;
    body.innerHTML = `
      <div style="color:#7080a0; font-size:11px; padding-bottom:6px;">${escapeHtml(t('auto.209'))}</div>
      ${sectionCard(t("auto.144"),
        `<div style="max-height:140px; overflow-y:auto; background:#06090f; border-radius:3px;">${planetSelectHtml("tr-source-radio")}</div>
        <div data-tr-source-info style="color:#7080a0; font-size:10px; padding-top:6px; min-height:14px;">${escapeHtml(t('auto.248'))}</div>
        <label style="display:flex; gap:6px; align-items:center; padding-top:6px; cursor:pointer; color:#d0d8e0; font-size:11px;">
          <input type="checkbox" data-tr-jg-enable checked/>
          <span>${escapeHtml(t('auto.223'))}</span>
        </label>`)}
      ${sectionCard(t("auto.145"),
        `<label style="display:block; cursor:pointer; color:#d0d8e0; font-size:11px; padding-bottom:6px;">
          <input type="checkbox" data-tr-resource-sameas-ship checked style="margin-right:6px; vertical-align:middle;"/>${escapeHtml(t('auto.267'))}
        </label>
        <div data-tr-resource-picker-wrap style="display:none; max-height:140px; overflow-y:auto; background:#06090f; border-radius:3px;">${planetSelectHtml("tr-resource-radio")}</div>
        <div data-tr-resource-info style="color:#7080a0; font-size:10px; padding-top:6px; min-height:14px;">${escapeHtml(t('auto.249'))}</div>`)}
      ${sectionCard(t("auto.146"),
        `<div style="max-height:140px; overflow-y:auto; background:#06090f; border-radius:3px;">${planetSelectHtml("tr-target-radio")}</div>`)}
      ${sectionCard(t("auto.147"),
        `<div style="display:flex; gap:14px; flex-wrap:wrap; padding-bottom:6px; font-size:11px; color:#d0d8e0;">
          <label style="cursor:pointer;"><input type="radio" name="tr-stopover-shortcut" value="ship" data-tr-stopover-shortcut checked style="margin-right:4px; vertical-align:middle;"/>${escapeHtml(t('auto.268'))}</label>
          <label style="cursor:pointer;"><input type="radio" name="tr-stopover-shortcut" value="resource" data-tr-stopover-shortcut style="margin-right:4px; vertical-align:middle;"/>${escapeHtml(t('auto.269'))}</label>
          <label style="cursor:pointer;"><input type="radio" name="tr-stopover-shortcut" value="target" data-tr-stopover-shortcut style="margin-right:4px; vertical-align:middle;"/>${escapeHtml(t('auto.270'))}</label>
          <label style="cursor:pointer;"><input type="radio" name="tr-stopover-shortcut" value="other" data-tr-stopover-shortcut style="margin-right:4px; vertical-align:middle;"/>${escapeHtml(t('auto.271'))}</label>
        </div>
        <div data-tr-stopover-picker-wrap style="display:none; max-height:140px; overflow-y:auto; background:#06090f; border-radius:3px;">${planetSelectHtml("tr-stopover-radio", true)}</div>`)}
      ${sectionCard(t("auto.148"),
        `<div style="display:flex; gap:12px; padding-bottom:6px;">
          <label style="cursor:pointer; color:#d0d8e0; font-size:11px;"><input type="${shipInputType}" name="tr-ship" value="largeCargo" checked data-tr-ship/> ${escapeHtml(techName('largeCargo'))} (cap ${fmt(ltCap)})</label>
          <label style="cursor:pointer; color:#d0d8e0; font-size:11px;"><input type="${shipInputType}" name="tr-ship" value="smallCargo" data-tr-ship/> ${escapeHtml(techName('smallCargo'))} (cap ${fmt(stCap)})</label>
        </div>
        <div style="display:flex; flex-direction:column; gap:4px; padding:4px 0; font-size:11px;">
          <label style="display:flex; align-items:center; gap:6px; cursor:pointer; color:#d0d8e0;">
            <input type="checkbox" data-tr-cargo-enable="m" checked style="margin:0;"/>
            <span style="min-width:60px;">${escapeHtml(t('auto.215'))}</span>
            <input data-tr-cargo="m" type="number" min="0" step="1000" value="0" onclick="this.select()" style="${inputStyle} width:140px;"/>
            <span data-tr-stock="m" style="color:#7080a0; font-size:10px; font-family:monospace;" title="resource planet stock">/0</span>
          </label>
          <label style="display:flex; align-items:center; gap:6px; cursor:pointer; color:#d0d8e0;">
            <input type="checkbox" data-tr-cargo-enable="c" checked style="margin:0;"/>
            <span style="min-width:60px;">${escapeHtml(t('auto.216'))}</span>
            <input data-tr-cargo="c" type="number" min="0" step="1000" value="0" onclick="this.select()" style="${inputStyle} width:140px;"/>
            <span data-tr-stock="c" style="color:#7080a0; font-size:10px; font-family:monospace;" title="resource planet stock">/0</span>
          </label>
          <label style="display:flex; align-items:center; gap:6px; cursor:pointer; color:#d0d8e0;">
            <input type="checkbox" data-tr-cargo-enable="d" checked style="margin:0;"/>
            <span style="min-width:60px;">${escapeHtml(t('auto.217'))}</span>
            <input data-tr-cargo="d" type="number" min="0" step="1000" value="0" onclick="this.select()" style="${inputStyle} width:140px;"/>
            <span data-tr-stock="d" style="color:#7080a0; font-size:10px; font-family:monospace;" title="resource planet stock">/0</span>
          </label>
        </div>
        <div style="display:flex; gap:8px; align-items:center; padding-top:4px;">
          <span style="color:#d0d8e0; font-size:11px; width:60px;">${escapeHtml(t('auto.218'))}</span>
          <input data-tr-ship-count type="number" min="0" step="1" value="0" onclick="this.select()" style="${inputStyle} width:100px;"/>
          <span data-tr-ship-need style="color:#7cfc00; font-size:10px;">${escapeHtml(t('auto.252'))}</span>
        </div>`)}
      ${sectionCard(t("auto.149"),
        `<label style="cursor:pointer; color:#d0d8e0; font-size:11px; display:block;">
          <input type="checkbox" data-tr-moon-take-all checked/>
          <span style="margin-left:4px;">${escapeHtml(t('auto.220'))}</span>
          <span style="color:#7080a0; font-size:10px; display:block; margin-left:20px; margin-top:2px;">${escapeHtml(t('auto.221'))}<br/>${escapeHtml(t('auto.222'))}</span>
        </label>`)}
      <div style="display:flex; justify-content:flex-end; gap:8px; padding-top:8px;">
        <span data-tr-status style="color:#7080a0; font-size:10px; align-self:center;"></span>
        <button data-tr-submit style="background:#205a20; color:#fff; border:1px solid #408a40; padding:4px 14px; border-radius:3px; cursor:pointer; font-size:11px;">${escapeHtml(t('auto.219'))}</button>
      </div>
    `;
    // v0.0.518 — section ②/④ shortcut wiring (operator 2026-05-31).
    // ② 同 ① 艦船 checkbox (預設勾選, 折疊 picker; ship!=resource 時自動展開):
    const resourceSameAsShipCb = m.querySelector<HTMLInputElement>("[data-tr-resource-sameas-ship]");
    const resourcePickerWrap = m.querySelector<HTMLElement>("[data-tr-resource-picker-wrap]");
    const syncResourceFromShip = (): void => {
      if (!resourceSameAsShipCb?.checked) return;
      const sourcePid = m.querySelector<HTMLInputElement>('input[name="tr-source-radio"]:checked')?.value ?? "";
      if (!sourcePid) return;
      const rr = m.querySelector<HTMLInputElement>(`input[name="tr-resource-radio"][value="${sourcePid}"]`);
      if (rr) {
        rr.checked = true;
        rr.dispatchEvent(new Event("change", { bubbles: true }));
      }
    };
    resourceSameAsShipCb?.addEventListener("change", () => {
      if (resourcePickerWrap) resourcePickerWrap.style.display = resourceSameAsShipCb.checked ? "none" : "block";
      if (resourceSameAsShipCb.checked) syncResourceFromShip();
    });
    // When ship planet changes AND "same as ship" still ticked → sync resource;
    // when user manually picks a different resource → uncheck "same as ship".
    for (const sr of m.querySelectorAll<HTMLInputElement>('input[name="tr-source-radio"]')) {
      sr.addEventListener("change", () => { if (resourceSameAsShipCb?.checked) syncResourceFromShip(); });
    }
    for (const rr of m.querySelectorAll<HTMLInputElement>('input[name="tr-resource-radio"]')) {
      rr.addEventListener("change", () => {
        if (!rr.checked) return;
        const sourcePid = m.querySelector<HTMLInputElement>('input[name="tr-source-radio"]:checked')?.value ?? "";
        if (rr.value !== sourcePid && resourceSameAsShipCb?.checked) {
          resourceSameAsShipCb.checked = false;
          if (resourcePickerWrap) resourcePickerWrap.style.display = "block";
        }
      });
    }
    // ④ stopover shortcut wiring: 艦船/資源/目標/其他 → 自動設 tr-stopover-radio
    // 到對應 body id; "其他" 才顯 picker。
    const stopoverPickerWrap = m.querySelector<HTMLElement>("[data-tr-stopover-picker-wrap]");
    const applyStopoverShortcut = (val: string): void => {
      if (stopoverPickerWrap) stopoverPickerWrap.style.display = val === "other" ? "block" : "none";
      let targetPid = "";
      if (val === "ship") targetPid = m.querySelector<HTMLInputElement>('input[name="tr-source-radio"]:checked')?.value ?? "";
      else if (val === "resource") targetPid = m.querySelector<HTMLInputElement>('input[name="tr-resource-radio"]:checked')?.value ?? "";
      else if (val === "target") targetPid = m.querySelector<HTMLInputElement>('input[name="tr-target-radio"]:checked')?.value ?? "";
      if (val !== "other") {
        // Set the underlying tr-stopover-radio to picked id (or unset radio if empty)
        const unsetRadio = m.querySelector<HTMLInputElement>('input[name="tr-stopover-radio"][value=""]');
        const targetRadio = targetPid ? m.querySelector<HTMLInputElement>(`input[name="tr-stopover-radio"][value="${targetPid}"]`) : null;
        if (targetRadio) targetRadio.checked = true;
        else if (unsetRadio) unsetRadio.checked = true;
      }
    };
    for (const sh of m.querySelectorAll<HTMLInputElement>("[data-tr-stopover-shortcut]")) {
      sh.addEventListener("change", () => { if (sh.checked) applyStopoverShortcut(sh.value); });
    }
    // Re-apply on upstream radio changes (ship/resource/target) so shortcut value stays in sync.
    for (const upstreamName of ["tr-source-radio", "tr-resource-radio", "tr-target-radio"]) {
      for (const r of m.querySelectorAll<HTMLInputElement>(`input[name="${upstreamName}"]`)) {
        r.addEventListener("change", () => {
          const cur = m.querySelector<HTMLInputElement>('input[name="tr-stopover-shortcut"]:checked')?.value ?? "ship";
          if (cur !== "other") applyStopoverShortcut(cur);
        });
      }
    }
    // v0.0.512 — type toggle wiring: switch 🌍 星球 ↔ 🌙 月球 sections.
    // Selecting a type swaps visible body cells. Existing body radio
    // selection is cleared if the body's kind no longer matches.
    for (const tt of m.querySelectorAll<HTMLInputElement>("[data-tr-type-toggle]")) {
      tt.addEventListener("change", () => {
        if (!tt.checked) return;
        const radioName = tt.getAttribute("data-tr-type-toggle");
        if (!radioName) return;
        const kind = tt.value; // "planet" | "moon"
        // Toggle visibility of body cell sections under this radioName.
        // Each section is uniquely identified by its data-tr-body-section,
        // scoped to the closest container (radio name shared per modal so
        // we filter by adjacent siblings to the type radio's parent).
        const ttParent = tt.closest("div");
        const container = ttParent?.parentElement;
        if (!container) return;
        for (const sec of container.querySelectorAll<HTMLElement>("[data-tr-body-section]")) {
          sec.style.display = sec.getAttribute("data-tr-body-section") === kind ? "flex" : "none";
        }
        // If currently-checked body radio has wrong kind, uncheck it.
        const checked = container.querySelector<HTMLInputElement>(`input[name="${radioName}"]:checked`);
        if (checked && checked.getAttribute("data-tr-body-kind") !== kind && checked.value !== "") {
          checked.checked = false;
        }
      });
    }
    // Section ① — source planet → display ship counts.
    const sourceInfo = m.querySelector<HTMLElement>("[data-tr-source-info]");
    for (const r of m.querySelectorAll<HTMLInputElement>('input[name="tr-source-radio"]')) {
      r.addEventListener("change", () => {
        if (!r.checked || !sourceInfo) return;
        const p = planetsMap[r.value];
        const lt = p?.ships?.largeCargo ?? 0;
        const st = p?.ships?.smallCargo ?? 0;
        sourceInfo.innerHTML = `<span style="color:#d0d8e0;">${techName('largeCargo')} × ${fmt(lt)} · ${techName('smallCargo')} × ${fmt(st)}</span>`;
      });
    }
    // Operator 2026-05-29: 預設來源 = 當前 ogame 所在 planet. Reads the
    // ogame-planet-id meta (which ogame keeps in sync with the active
    // session-cp). Falls back silently if meta missing or planet not in
    // the grid (e.g. operator on a moon row not exposed).
    const ogameCurrentPid = doc.querySelector<HTMLMetaElement>('meta[name="ogame-planet-id"]')?.content ?? "";
    if (ogameCurrentPid) {
      // v0.0.521 — operator 2026-05-31 "我在月球時預設艦船星球不對". 之前只
      // setChecked 但 type toggle 預設 "星球" mode, 月球 radio 在隱藏 section。
      // 現在: 先判斷當前 body type, 把 type toggle 切到對應 mode, 再 set radio。
      const currentBody = planetsMap[ogameCurrentPid];
      const currentKind: "planet" | "moon" = currentBody?.type === "moon" ? "moon" : "planet";
      const switchTypeToggle = (radioName: string, kind: "planet" | "moon"): void => {
        const tt = m.querySelector<HTMLInputElement>(`input[name="${radioName}-type"][value="${kind}"]`);
        if (tt && !tt.checked) {
          tt.checked = true;
          tt.dispatchEvent(new Event("change", { bubbles: true }));
        }
      };
      switchTypeToggle("tr-source-radio", currentKind);
      switchTypeToggle("tr-resource-radio", currentKind);
      switchTypeToggle("tr-target-radio", currentKind);
      switchTypeToggle("tr-stopover-radio", currentKind);
      const sourceRadio = m.querySelector<HTMLInputElement>(`input[name="tr-source-radio"][value="${ogameCurrentPid}"]`);
      if (sourceRadio) {
        sourceRadio.checked = true;
        sourceRadio.dispatchEvent(new Event("change", { bubbles: true }));
        // Scroll the row into view so operator sees the preset selection.
        sourceRadio.scrollIntoView({ block: "center" });
      }
      // v0.0.518 — section ③ 目標預設也 = 當前星球 (operator 2026-05-31).
      const targetRadioDefault = m.querySelector<HTMLInputElement>(`input[name="tr-target-radio"][value="${ogameCurrentPid}"]`);
      if (targetRadioDefault) {
        targetRadioDefault.checked = true;
        targetRadioDefault.dispatchEvent(new Event("change", { bubbles: true }));
      }
      // v0.0.518 — section ② "同上" 預設勾選, 同步 resource = ship。
      const resCb = m.querySelector<HTMLInputElement>("[data-tr-resource-sameas-ship]");
      if (resCb?.checked) {
        const rr = m.querySelector<HTMLInputElement>(`input[name="tr-resource-radio"][value="${ogameCurrentPid}"]`);
        if (rr) {
          rr.checked = true;
          rr.dispatchEvent(new Event("change", { bubbles: true }));
        }
      }
      // v0.0.518 — section ④ shortcut 預設 "艦船星球", stopover = ship planet。
      const stopRadio = m.querySelector<HTMLInputElement>(`input[name="tr-stopover-radio"][value="${ogameCurrentPid}"]`);
      if (stopRadio) stopRadio.checked = true;
      // v0.0.521 — operator "顯示當前資源部分預設顯示艦船星球資源"
      // 同上模式下雖然 resource radio 已經 set + dispatched change, 但如果 resInfo
      // 元素查詢發生在這之前就漏了。 這裏直接強制更新一次。
      const resInfo2 = m.querySelector<HTMLElement>("[data-tr-resource-info]");
      const currentP = planetsMap[ogameCurrentPid];
      if (resInfo2 && currentP) {
        const m_v = currentP.resources?.m ?? 0;
        const c_v = currentP.resources?.c ?? 0;
        const d_v = currentP.resources?.d ?? 0;
        resInfo2.innerHTML = `<span style="color:#d0d8e0;">M ${fmt(m_v)} · C ${fmt(c_v)} · D ${fmt(d_v)}</span>`;
        // v0.0.523 — operator 2026-05-31 "資源沒有自動填入輸入框". 真因:
        // boot 時 dispatch change 比 resource radio listener 注冊早, change 事件
        // 沒人接 → cargo auto-fill 路徑漏了。 這裏直接強制把當前星球 bank
        // 寫到 cargo input (curM === 0 時), 跟正常 change handler 行爲對齊。
        const cmEl = m.querySelector<HTMLInputElement>('[data-tr-cargo="m"]');
        const ccEl = m.querySelector<HTMLInputElement>('[data-tr-cargo="c"]');
        const cdEl = m.querySelector<HTMLInputElement>('[data-tr-cargo="d"]');
        if (cmEl && (parseInt(cmEl.value || "0", 10) || 0) === 0) cmEl.value = String(m_v);
        if (ccEl && (parseInt(ccEl.value || "0", 10) || 0) === 0) ccEl.value = String(c_v);
        if (cdEl && (parseInt(cdEl.value || "0", 10) || 0) === 0) cdEl.value = String(d_v);
        // v0.0.530 — operator 2026-05-31 "第一次進入頁面沒有和資源聯動".
        // 填完 cargo 後強制 updateShipCount, 不再等 input 事件。
        updateShipCount();
      }
    }
    // Section ② — resource planet → display M/C/D + auto-fill cargo inputs.
    const resInfo = m.querySelector<HTMLElement>("[data-tr-resource-info]");
    function cargoEnabled(key: "m" | "c" | "d"): boolean {
      const cb = m.querySelector<HTMLInputElement>(`[data-tr-cargo-enable="${key}"]`);
      return cb ? cb.checked : true;
    }
    function updateShipCount(): void {
      // v0.0.531 — 未勾選的資源視爲 0
      const cm = cargoEnabled("m") ? (parseInt((m.querySelector<HTMLInputElement>('[data-tr-cargo="m"]')?.value ?? "0"), 10) || 0) : 0;
      const cc = cargoEnabled("c") ? (parseInt((m.querySelector<HTMLInputElement>('[data-tr-cargo="c"]')?.value ?? "0"), 10) || 0) : 0;
      const cd = cargoEnabled("d") ? (parseInt((m.querySelector<HTMLInputElement>('[data-tr-cargo="d"]')?.value ?? "0"), 10) || 0) : 0;
      // v0.0.505 — moon target buffer 改 50K (operator 2026-05-30 "500K 太多")
      const targetVal = m.querySelector<HTMLInputElement>('input[name="tr-target-radio"]:checked')?.value ?? "";
      const targetP = targetVal ? planetsMap[targetVal] : null;
      const moonBufferD = targetP?.type === "moon" ? 50_000 : 0;
      const total = cm + cc + cd + moonBufferD;
      const ship = m.querySelector<HTMLInputElement>('input[name="tr-ship"]:checked')?.value ?? "largeCargo";
      const cap = ship === "smallCargo" ? stCap : ltCap;
      const needed = total > 0 ? Math.ceil(total / cap) : 0;
      const countInput = m.querySelector<HTMLInputElement>("[data-tr-ship-count]");
      // v0.0.762 — operator 2026-06-04 "船数输入框要同步算出来的值, 不是最大值".
      // 拉平: shortage prefill 和手动模式都跟 needed (按 cargo 反推). haveShips
      // 仍用来做 isShort 红字高亮判定; 不再写进输入框. (推翻 v0.0.671/676 分支.)
      const sourceVal = m.querySelector<HTMLInputElement>('input[name="tr-source-radio"]:checked')?.value ?? "";
      const sourceP = sourceVal ? planetsMap[sourceVal] : null;
      const shipKey = ship === "smallCargo" ? "smallCargo" : "largeCargo";
      const haveShips = (sourceP?.ships as Record<string, number | undefined> | undefined)?.[shipKey] ?? 0;
      if (countInput) countInput.value = String(needed);
      // v0.0.530 — operator 2026-05-31 "船不夠顯示紅色". 比對 ① 艦船星球 的
      // 真實船數 (LC 或 SC) vs needed, 不夠 → 數量輸入框 + 旁邊提示 紅字。
      const isShort = needed > haveShips;
      if (countInput) {
        countInput.style.color = isShort ? "#ff6b6b" : "#e0e8f0";
        countInput.style.borderColor = isShort ? "#ff6b6b" : "#2a3a52";
      }
      const needSpan = m.querySelector<HTMLElement>("[data-tr-ship-need]");
      if (needSpan) {
        const shortNote = isShort ? ` <span style="color:#ff6b6b; font-weight:bold;">${t("auto.179", { n: fmt(haveShips) })}</span>` : "";
        needSpan.innerHTML = `${escapeHtml(t('auto.272', { n: String(needed), total: fmt(total) }))}${moonBufferD ? escapeHtml(t('auto.273')) : ""} (cap ${fmt(cap)})${shortNote}`;
      }
    }
    for (const r of m.querySelectorAll<HTMLInputElement>('input[name="tr-resource-radio"]')) {
      r.addEventListener("change", (ev) => {
        if (!r.checked || !resInfo) return;
        if (!r.value) { resInfo.textContent = "—"; return; }
        // v0.0.667 — operator 2026-06-02 "刷新那个装载资源的资源输入框":
        // re-read planet LIVE from store (planetsMap is a snapshot from
        // section render; sniffer may have updated bank since). And on
        // user-initiated click (isTrusted), OVERRIDE cargo inputs to the
        // picked planet's bank — explicit click = explicit "use this".
        // Programmatic dispatchEvent (sameAsShip sync) has isTrusted=false
        // so keeps legacy "fill-when-empty" behavior to protect operator's
        // shortage-button prefill (v0.0.504 rule).
        const liveP = (storeRef?.state?.planets ?? {})[r.value] as StorePlanet | undefined;
        const m_v = liveP?.resources?.m ?? 0;
        const c_v = liveP?.resources?.c ?? 0;
        const d_v = liveP?.resources?.d ?? 0;
        resInfo.innerHTML = `<span style="color:#d0d8e0;">M ${fmt(m_v)} · C ${fmt(c_v)} · D ${fmt(d_v)}</span>`;
        const mi = m.querySelector<HTMLInputElement>('[data-tr-cargo="m"]');
        const ci = m.querySelector<HTMLInputElement>('[data-tr-cargo="c"]');
        const di = m.querySelector<HTMLInputElement>('[data-tr-cargo="d"]');
        const userInitiated = ev.isTrusted;
        if (userInitiated) {
          // Override regardless of current cargo values — user explicitly
          // picked this planet, so its bank is the authoritative source.
          if (mi) mi.value = String(m_v);
          if (ci) ci.value = String(c_v);
          if (di) di.value = String(d_v);
        } else {
          // Programmatic sync (sameAsShip): preserve any manual prefill.
          const curM = parseInt(mi?.value || "0", 10) || 0;
          const curC = parseInt(ci?.value || "0", 10) || 0;
          const curD = parseInt(di?.value || "0", 10) || 0;
          if (mi && curM === 0) mi.value = String(m_v);
          if (ci && curC === 0) ci.value = String(c_v);
          if (di && curD === 0) di.value = String(d_v);
        }
        updateShipCount();
      });
    }
    // v0.0.477: cargo overflow indicator (operator 2026-05-30 "如果填的資源
    // 大於星球有的資源，資源顯示紅字"). Each input compares against the
    // CURRENT resource-source planet's bank; if user-typed value exceeds,
    // paint the input text red. Reads from radio selection live.
    // v0.0.1044 — owner 2026-06-09 "TM 运输也同样改一下 库存资源显示位置": 同步
    // 更新 data-tr-stock chip 紧贴 input 显 /X.XM, over 时红色.
    const fmtStockChip = (n: number): string => n >= 1_000_000 ? `${(n/1_000_000).toFixed(1)}M`
      : n >= 1_000 ? `${(n/1_000).toFixed(0)}K` : String(n);
    const refreshCargoOverflowColors = (): void => {
      const sel = m.querySelector<HTMLInputElement>('input[name="tr-resource-radio"]:checked')?.value ?? "";
      const src = sel ? planetsMap[sel] : null;
      const bank = {
        m: src?.resources?.m ?? Infinity,
        c: src?.resources?.c ?? Infinity,
        d: src?.resources?.d ?? Infinity,
      };
      for (const ci of m.querySelectorAll<HTMLInputElement>("[data-tr-cargo]")) {
        const key = ci.getAttribute("data-tr-cargo") as "m" | "c" | "d";
        const val = parseInt(ci.value || "0", 10) || 0;
        const cap = bank[key];
        const isOver = val > cap;
        if (isOver) {
          ci.style.color = "#ff6b6b";
          ci.style.borderColor = "#ff6b6b";
          ci.title = t("auto.180", { key: key.toUpperCase(), cap: fmt(cap), val: fmt(val) });
        } else {
          // v0.0.504 — operator 2026-05-30: setting style.color="" wiped the
          // inline style attr color (#e0e8f0), letting browser default win
          // (usually dark on dark bg → 文字不可見). Restore explicit values.
          ci.style.color = "#e0e8f0";
          ci.style.borderColor = "#2a3a52";
          ci.title = "";
        }
        // v0.0.1044 — stock chip 同步: /X.XM 文本 + 红/灰颜色
        const stockEl = m.querySelector<HTMLElement>(`[data-tr-stock="${key}"]`);
        if (stockEl) {
          stockEl.textContent = `/${isFinite(cap) ? fmtStockChip(cap) : "?"}`;
          stockEl.style.color = isOver ? "#ff6b6b" : "#7080a0";
        }
      }
    };
    // Cargo amount inputs → recompute ship count + overflow colors live.
    for (const ci of m.querySelectorAll<HTMLInputElement>("[data-tr-cargo]")) {
      ci.addEventListener("input", () => { updateShipCount(); refreshCargoOverflowColors(); });
    }
    // v0.0.531 — operator 2026-05-31: cargo enable checkbox (M/C/D 各一個).
    // 預設勾選, 不勾時該資源不裝船 (cargo 視爲 0)。 同時灰禁對應 input。
    const updateCargoEnabledState = (key: "m" | "c" | "d"): void => {
      const cb = m.querySelector<HTMLInputElement>(`[data-tr-cargo-enable="${key}"]`);
      const inp = m.querySelector<HTMLInputElement>(`[data-tr-cargo="${key}"]`);
      if (!cb || !inp) return;
      const enabled = cb.checked;
      inp.disabled = !enabled;
      inp.style.opacity = enabled ? "1" : "0.4";
    };
    for (const key of ["m", "c", "d"] as const) {
      const cb = m.querySelector<HTMLInputElement>(`[data-tr-cargo-enable="${key}"]`);
      cb?.addEventListener("change", () => {
        updateCargoEnabledState(key);
        updateShipCount();
        refreshCargoOverflowColors();
      });
      updateCargoEnabledState(key);
    }
    // Also re-check overflow when resource-source radio changes.
    for (const rr of m.querySelectorAll<HTMLInputElement>('input[name="tr-resource-radio"]')) {
      rr.addEventListener("change", refreshCargoOverflowColors);
    }
    // v0.0.669/676 — shortage-fill mode renders radios (browser-native
    // mutex). Manual mode renders checkboxes + JS mutex (this loop). Both
    // paths still trigger updateShipCount on change.
    for (const sr of m.querySelectorAll<HTMLInputElement>('input[name="tr-ship"]')) {
      sr.addEventListener("change", () => {
        if (!isShortageFill && sr.checked) {
          for (const other of m.querySelectorAll<HTMLInputElement>('input[name="tr-ship"]')) {
            if (other !== sr) other.checked = false;
          }
        }
        updateShipCount();
      });
    }
    // v0.0.504 — also recompute on target radio change (moon target adds
    // 500K d buffer → ship count needs to include it).
    for (const tr of m.querySelectorAll<HTMLInputElement>('input[name="tr-target-radio"]')) {
      tr.addEventListener("change", updateShipCount);
    }
    // v0.0.1044 — modal init 完后强制一次 stock chip 真态刷新 (init 时 listener
    // 未注册导致 dispatchEvent 漏接, stock chip 仍显默认 "/0").
    refreshCargoOverflowColors();
    // Submit — POST /v1/goals/create with a transport goal.
    m.querySelector<HTMLElement>("[data-tr-submit]")?.addEventListener("click", async () => {
      const status = m.querySelector<HTMLElement>("[data-tr-status]");
      const source = m.querySelector<HTMLInputElement>('input[name="tr-source-radio"]:checked')?.value ?? "";
      const resourceSrc = m.querySelector<HTMLInputElement>('input[name="tr-resource-radio"]:checked')?.value ?? "";
      const target = m.querySelector<HTMLInputElement>('input[name="tr-target-radio"]:checked')?.value ?? "";
      const ship = m.querySelector<HTMLInputElement>('input[name="tr-ship"]:checked')?.value ?? "largeCargo";
      const shipCount = parseInt((m.querySelector<HTMLInputElement>("[data-tr-ship-count]")?.value ?? "0"), 10) || 0;
      // v0.0.531 — 未勾選的資源 cargo = 0
      const cargoM = cargoEnabled("m") ? (parseInt((m.querySelector<HTMLInputElement>('[data-tr-cargo="m"]')?.value ?? "0"), 10) || 0) : 0;
      const cargoC = cargoEnabled("c") ? (parseInt((m.querySelector<HTMLInputElement>('[data-tr-cargo="c"]')?.value ?? "0"), 10) || 0) : 0;
      const cargoD = cargoEnabled("d") ? (parseInt((m.querySelector<HTMLInputElement>('[data-tr-cargo="d"]')?.value ?? "0"), 10) || 0) : 0;
      if (!source) { if (status) { status.textContent = t("auto.093"); status.style.color = "#ff6b6b"; } return; }
      if (!target) { if (status) { status.textContent = t("auto.094"); status.style.color = "#ff6b6b"; } return; }
      if (shipCount <= 0) { if (status) { status.textContent = t("auto.095"); status.style.color = "#ff6b6b"; } return; }
      const targetPlanet = planetsMap[target];
      const targetCoords = (targetPlanet?.coords ?? []).join(":");
      const jgEnabled = (m.querySelector<HTMLInputElement>("[data-tr-jg-enable]")?.checked) ?? false;
      // v0.0.921 — owner 2026-06-07 "扩展到所有从月球出发的任务". Renamed
      // jgTakeAll → moonTakeAll, applies to every leg whose source body type
      // is "moon" (not only JG hop). Default checked.
      const moonTakeAll = (m.querySelector<HTMLInputElement>("[data-tr-moon-take-all]")?.checked) ?? true;
      // Build the chain: depending on (source vs resource) and (JG) we emit
      // 1-3 goals with a shared chain id + priority ladder so the planner
      // dispatches them in order as ships arrive at each waypoint.
      // v0.0.763 — operator 2026-06-04 "完全克隆 flagship":
      // chain planning lifted to @ogamex/shared/transport_planner so the
      // web dashboard (/api/me/goals/transport) reuses the EXACT same rules
      // (same-coord shortcut, JG-only-empty, moon buffers, 3 segments).
      const chainId = makeTransportChainId(Date.now());
      const ships = { [ship]: shipCount };
      const stopoverIdRaw = m.querySelector<HTMLInputElement>('input[name="tr-stopover-radio"]:checked')?.value ?? "";
      const toPlannerPlanet = (p: StorePlanet | undefined): PlannerPlanet | null => {
        if (!p?.coords || p.coords.length < 3) return null;
        const base: PlannerPlanet = {
          id: p.id,
          type: (p.type === "moon" ? "moon" : "planet"),
          coords: [p.coords[0]!, p.coords[1]!, p.coords[2]!],
        };
        const res = (p as { resources?: { m?: number; c?: number; d?: number } }).resources;
        if (res) base.resources = res;
        // v0.0.946 — owner 2026-06-07 "应该 2leg 不是 4leg": findSiblingMoon
        // 现在 require jumpgateLevel > 0. 月球无 JG → 退回直送 sublight.
        const buildings = (p as { buildings?: Record<string, number> }).buildings;
        if (buildings && typeof buildings.jumpgate === "number") {
          base.jumpgateLevel = buildings.jumpgate;
        }
        return base;
      };
      const ppSource = toPlannerPlanet(planetsMap[source]);
      const ppResource = resourceSrc ? toPlannerPlanet(planetsMap[resourceSrc]) : ppSource;
      const ppTarget = toPlannerPlanet(planetsMap[target]);
      const ppStopover = stopoverIdRaw && stopoverIdRaw !== target ? toPlannerPlanet(planetsMap[stopoverIdRaw]) : null;
      if (!ppSource || !ppTarget) {
        if (status) { status.textContent = "missing source/target planet metadata"; status.style.color = "#ff6b6b"; }
        return;
      }
      const ppAll = Object.values(planetsMap)
        .map(toPlannerPlanet)
        .filter((p): p is PlannerPlanet => p !== null);
      const { goals: plannedGoals } = planTransportChain({
        source: ppSource,
        resource: ppResource,
        target: ppTarget,
        stopover: ppStopover,
        ships,
        cargo: { m: cargoM, c: cargoC, d: cargoD },
        jgEnabled,
        moonTakeAll,
        allPlanets: ppAll,
        chainId,
      });
      const goalBodies: Array<{ type: string; target: Record<string, unknown>; planet?: string; priority?: number }> = plannedGoals;
      if (status) { status.textContent = `creating ${goalBodies.length} goal(s)…`; status.style.color = "#7080a0"; }
      try {
        const ids: string[] = [];
        for (const body of goalBodies) {
          const r = await fetchFn(`${baseUrl}/ogamex/v1/goals/create`, {
            method: "POST",
            headers: authHeadersGlobal({ "Content-Type": "application/json" }),
            body: JSON.stringify(body),
          });
          if (!r.ok) {
            const j = await r.json().catch(() => ({ reason: `HTTP ${r.status}` })) as { reason?: string };
            throw new Error(j.reason ?? `HTTP ${r.status}`);
          }
          const j = await r.json() as { ok?: boolean; goal_id?: string; reason?: string };
          if (!j.ok) throw new Error(j.reason ?? "rejected");
          if (j.goal_id) ids.push(j.goal_id);
        }
        if (status) { status.textContent = `✓ chain ${chainId} created (${ids.length} goals)`; status.style.color = "#7cfc00"; }
        setTimeout(() => m.remove(), 900);
      } catch (e) {
        if (status) { status.textContent = `× ${(e as Error).message}`; status.style.color = "#ff6b6b"; }
      }
    });
    // v0.0.449 + v0.0.450: post-render prefill. Chain shortage button
    // passes targetPlanetId + cargo. Apply order:
    //   ① target radio pre-check
    //   ② resource radio pre-check = current planet (operator 2026-05-29
    //      "源地址和船所在的星球地址 用我的當前星球"). Set .checked = true
    //      WITHOUT firing change event — the change handler auto-fills
    //      cargo from resource planet's stockpile, which would overwrite
    //      the shortage cargo we want.
    //   ③ cargo inputs filled with shortage amounts
    //   ④ call updateShipCount() so 大運數量 auto-computes (input event
    //      doesn't fire when setting .value programmatically).
    // Source ships planet auto-defaults to current planet via the
    // existing tr-source-radio default-checked logic.
    if (prefill?.targetPlanetId) {
      // v0.0.522 — goals 的 → 運輸 按鈕過來時, prefill.targetPlanetId 可能
      // 是 moon (lunarBase / jumpgate goal). 之前只 setChecked 但 type toggle
      // 預設 "星球" → moon radio 在隱藏 section, submit 讀不到正確 body。
      // 現在: 判 target body 的 type → 切 target type toggle 到對應 mode → 再 set radio。
      const tgtBody = planetsMap[prefill.targetPlanetId];
      if (tgtBody?.type === "moon") {
        const tt = m.querySelector<HTMLInputElement>('input[name="tr-target-radio-type"][value="moon"]');
        if (tt && !tt.checked) {
          tt.checked = true;
          tt.dispatchEvent(new Event("change", { bubbles: true }));
        }
      }
      const r = m.querySelector<HTMLInputElement>(`input[name="tr-target-radio"][value="${prefill.targetPlanetId}"]`);
      if (r) {
        r.checked = true;
        r.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }
    if (prefill) {
      const ogameCurrentPid = doc.querySelector<HTMLMetaElement>('meta[name="ogame-planet-id"]')?.content ?? "";
      if (ogameCurrentPid) {
        // v0.0.522 — 同 v0.0.521, 資源 radio 在 hidden moon section 時切 type toggle
        const curBody2 = planetsMap[ogameCurrentPid];
        if (curBody2?.type === "moon") {
          const tt = m.querySelector<HTMLInputElement>('input[name="tr-resource-radio-type"][value="moon"]');
          if (tt && !tt.checked) {
            tt.checked = true;
            tt.dispatchEvent(new Event("change", { bubbles: true }));
          }
        }
        const rr = m.querySelector<HTMLInputElement>(`input[name="tr-resource-radio"][value="${ogameCurrentPid}"]`);
        if (rr) {
          rr.checked = true;
          rr.dispatchEvent(new Event("change", { bubbles: true }));
        }
      }
    }
    if (prefill?.cargo) {
      // v0.0.541 — operator 2026-05-31 "建築任務裏面點運輸以後,所需資源
      // 沒有正確填入". Bug: 舊邏輯 if (X > 0) 只覆蓋正值, X=0 時保留 boot 塊
      // 填的"當前星球庫存"殘留 → shortage 只缺 c 時, m/d 輸入框還是當前
      // 星球的 m/d 庫存, 操作員看到的"所需資源"跟實際填的對不上.
      // 修法: 顯式按 prefill.cargo 三件都寫, 0 就是 0; 同步把 cargoEnable
      // checkbox 在該資源 == 0 時取消, 不勾不裝船 (跟 v0.0.531 配套).
      const cm = m.querySelector<HTMLInputElement>('[data-tr-cargo="m"]');
      const cc = m.querySelector<HTMLInputElement>('[data-tr-cargo="c"]');
      const cd = m.querySelector<HTMLInputElement>('[data-tr-cargo="d"]');
      if (cm) cm.value = String(prefill.cargo.m);
      if (cc) cc.value = String(prefill.cargo.c);
      if (cd) cd.value = String(prefill.cargo.d);
      for (const [key, val] of [["m", prefill.cargo.m], ["c", prefill.cargo.c], ["d", prefill.cargo.d]] as const) {
        const cb = m.querySelector<HTMLInputElement>(`[data-tr-cargo-enable="${key}"]`);
        if (cb) cb.checked = val > 0;
        updateCargoEnabledState(key);
      }
      updateShipCount();
    }
    // v0.0.522 — prefill 來源是 goals "→ 運輸" 按鈕 (有 targetPlanetId), 這意味着
    // 操作員要 ship → 目標, 跟"同上"語義不衝突, resource 仍然 = ship 預設對。
    // 但 stopover shortcut 預設 ship 也對 (operator 想運到目標, 然後船回艦船星球
    // 是合理的)。 這裏不強制改 shortcut, 讓 v0.0.518 預設 = ship 生效。
  });
}

export function startGoalsPanel(opts: GoalsPanelOptions = {}): GoalsPanelHandle {
  const doc = opts.doc ?? document;
  const fetchFn = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const baseUrl = opts.httpBaseUrl ?? "https://ogame.anyfq.com";
  const pollMs = opts.pollMs ?? 3000;
  const showTerminal = opts.showTerminal ?? false;

  // authHeaders helper now module-level (see top of file). Wrap with opts.bridgeToken
  // preference; falls back to localStorage when not injected (legacy install).
  const authHeaders = (extra: Record<string, string> = {}): Record<string, string> => {
    const tok = readBridgeTok(opts.bridgeToken);
    return tok ? { ...extra, "Authorization": `Bearer ${tok}` } : extra;
  };

  // Operator 2026-05-29: poll sidecar /v1/runtime-version every 60s; on
  // newer version, set window.__ogamexLatestVersion + __ogamexDownloadURL
  // so the next render shows the update button.
  const checkRuntimeUpdate = async (): Promise<void> => {
    try {
      const r = await fetchFn(`${baseUrl}/ogamex/v1/runtime-version`, { method: "GET" });
      if (!r.ok) return;
      const j = await r.json() as { version?: string; downloadURL?: string };
      const win = (typeof window !== "undefined" ? window : globalThis) as {
        __ogamexVersion?: string;
        __ogamexLatestVersion?: string;
        __ogamexDownloadURL?: string;
      };
      if (j.version) win.__ogamexLatestVersion = j.version;
      if (j.downloadURL) win.__ogamexDownloadURL = j.downloadURL;
      // v0.0.801 — operator 2026-06-05 "以后都强制更新, 省的你老瞎怀疑":
      // 不持久 dismiss, 每 60s poll 都 ensure modal on screen. id check
      // (showUpdateModal 内) 防重复 append. owner 安装新版后 cur===latest
      // → mismatch=false → modal 自动不再弹. "稍后" 关 modal 只本次,
      // 下次 poll 又会自动 re-pop 直到 owner 立即安装.
      const cur = win.__ogamexVersion ?? "";
      const latest = win.__ogamexLatestVersion ?? "";
      const dl = win.__ogamexDownloadURL ?? "";
      if (cur && latest && dl && cmpSemver(latest, cur) > 0) {
        showUpdateModal(cur, latest, dl);
      }
    } catch { /* sidecar down or CORS — keep button hidden */ }
  };
  const showUpdateModal = (cur: string, latest: string, dl: string): void => {
    if (typeof document === "undefined" || document.getElementById("ogamex-update-modal")) return;
    const overlay = document.createElement("div");
    overlay.id = "ogamex-update-modal";
    overlay.style.cssText = "position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.6);z-index:2147483647;display:flex;align-items:center;justify-content:center;";
    const titleTxt = t("panel.update.modal.title");
    const bodyTpl = t("panel.update.modal.body", { cur: "{cur}", latest: "{latest}" })
      .replace("{cur}", `<strong>${escapeHtml(cur)}</strong>`)
      .replace("{latest}", `<strong style="color:#7cfc00;">${escapeHtml(latest)}</strong>`);
    const hintTxt = t("panel.update.modal.hint");
    const btnNowTxt = t("panel.update.modal.btn_now");
    const btnLaterTxt = t("panel.update.modal.btn_later");
    overlay.innerHTML = `
      <div style="background:#1a2a40;border:2px solid #4a8a4a;border-radius:8px;padding:24px;color:#e0e8f0;font-family:Arial,sans-serif;max-width:420px;box-shadow:0 6px 24px rgba(0,0,0,0.5);">
        <div style="font-size:16px;font-weight:bold;margin-bottom:8px;color:#7cfc00;">${escapeHtml(titleTxt)}</div>
        <div style="font-size:13px;margin-bottom:14px;color:#bcc8d8;">${bodyTpl}</div>
        <div style="font-size:12px;margin-bottom:16px;color:#8090a8;">${escapeHtml(hintTxt)}</div>
        <div style="display:flex;gap:8px;justify-content:flex-end;">
          <button id="ogamex-update-later" style="background:#404040;color:#fff;border:1px solid #606060;padding:6px 14px;border-radius:4px;cursor:pointer;font-size:12px;">${escapeHtml(btnLaterTxt)}</button>
          <button id="ogamex-update-now" style="background:#205a20;color:#fff;border:1px solid #408a40;padding:6px 14px;border-radius:4px;cursor:pointer;font-size:12px;font-weight:bold;">${escapeHtml(btnNowTxt)}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.querySelector("#ogamex-update-now")?.addEventListener("click", () => {
      try { window.open(dl, "_blank"); } catch { /* */ }
      overlay.remove();
    });
    overlay.querySelector("#ogamex-update-later")?.addEventListener("click", () => overlay.remove());
  };
  void checkRuntimeUpdate();
  const updateCheckTimer = setInterval(() => { void checkRuntimeUpdate(); }, 60_000);

  // v0.0.804 — operator 2026-06-05 "过期还可以用 弹强制更新类似窗口 点击
  // 跳充值页面". 60s poll subscription-status, expired → always-on modal
  // 设计 (同 update modal). 点 "立即续费" → window.open(/flagship).
  const checkSubscription = async (): Promise<void> => {
    try {
      // v0.0.807 — operator "没有提示续费" 真因: subscription-status endpoint
      // 需 per-user Bearer 才能查 PG; 无 Bearer 时 endpoint 返 fallback
      // {active:true} → modal 永不弹. 加 Bearer header 跟 fetchGoals (line
      // 3528-3531) 同款.
      let tok: string | null = opts.bridgeToken ?? null;
      if (!tok) {
        try { tok = (typeof window !== "undefined" ? window.localStorage.getItem("OGAMEX_BRIDGE_TOKEN") : null); }
        catch { /* sandbox isolation */ }
      }
      const init: RequestInit = tok ? { headers: { "Authorization": `Bearer ${tok}` } } : {};
      const r = await fetchFn(`${baseUrl}/ogamex/v1/subscription-status`, init);
      if (!r.ok) return;
      const j = await r.json() as { active?: boolean; expires_at?: number | null };
      if (j.active === false) {
        showSubscriptionExpiredModal();
      }
    } catch { /* sidecar down / 无 bearer → keep modal hidden */ }
  };
  const showSubscriptionExpiredModal = (): void => {
    if (typeof document === "undefined" || document.getElementById("ogamex-sub-expired-modal")) return;
    // v0.0.808 — operator 2026-06-05 "续费充值挑错页面了 /pricing".
    const renewUrl = ((): string => {
      try {
        const u = new URL(baseUrl);
        return `${u.protocol}//${u.host}/pricing`;
      } catch { return "https://ogame.anyfq.com/pricing"; }
    })();
    const overlay = document.createElement("div");
    overlay.id = "ogamex-sub-expired-modal";
    overlay.style.cssText = "position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.7);z-index:2147483646;display:flex;align-items:center;justify-content:center;";
    const sTitle = t("panel.sub_expired.modal.title");
    const sBody = t("panel.sub_expired.modal.body");
    const sHint = t("panel.sub_expired.modal.hint");
    const sBtnRenew = t("panel.sub_expired.modal.btn_renew");
    const sBtnLater = t("panel.sub_expired.modal.btn_later");
    overlay.innerHTML = `
      <div style="background:#2a1a1a;border:2px solid #a04040;border-radius:8px;padding:24px;color:#e0e8f0;font-family:Arial,sans-serif;max-width:420px;box-shadow:0 6px 24px rgba(0,0,0,0.5);">
        <div style="font-size:16px;font-weight:bold;margin-bottom:8px;color:#ff8080;">${escapeHtml(sTitle)}</div>
        <div style="font-size:13px;margin-bottom:14px;color:#bcc8d8;">${escapeHtml(sBody)}</div>
        <div style="font-size:12px;margin-bottom:16px;color:#8090a8;">${escapeHtml(sHint)}</div>
        <div style="display:flex;gap:8px;justify-content:flex-end;">
          <button id="ogamex-sub-later" style="background:#404040;color:#fff;border:1px solid #606060;padding:6px 14px;border-radius:4px;cursor:pointer;font-size:12px;">${escapeHtml(sBtnLater)}</button>
          <button id="ogamex-sub-renew" style="background:#7a3030;color:#fff;border:1px solid #a05050;padding:6px 14px;border-radius:4px;cursor:pointer;font-size:12px;font-weight:bold;">${escapeHtml(sBtnRenew)}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.querySelector("#ogamex-sub-renew")?.addEventListener("click", () => {
      try { window.open(renewUrl, "_blank"); } catch { /* */ }
      overlay.remove();
    });
    overlay.querySelector("#ogamex-sub-later")?.addEventListener("click", () => overlay.remove());
  };
  void checkSubscription();
  const subCheckTimer = setInterval(() => { void checkSubscription(); }, 60_000);

  // Local-storage helpers — persist position + collapse state across page
  // reloads so the operator's preferred layout sticks.
  const LS_POS_KEY = "ogamex.panel.pos";
  // v0.0.938 — owner "TM 删错折叠了, 恢复": 折叠功能恢复, 删的是树 toggle.
  const LS_COLLAPSED_KEY = "ogamex.panel.collapsed";
  function loadJSON<T>(key: string, fallback: T): T {
    try {
      const raw = doc.defaultView?.localStorage?.getItem(key);
      return raw ? JSON.parse(raw) as T : fallback;
    } catch { return fallback; }
  }
  function saveJSON(key: string, val: unknown): void {
    try { doc.defaultView?.localStorage?.setItem(key, JSON.stringify(val)); } catch {}
  }

  // Skip re-render only when the mouse is over the PANEL itself. Earlier
  // logic tracked global page mousedown/keydown to detect "user busy",
  // but that meant clicking anywhere in ogame (which the operator does
  // constantly) would pin the panel into never-refresh. New rule: panel
  // refreshes freely; only pauses while pointer is on it (so a click
  // inside the panel doesn't get yanked mid-action).
  let panelHovered = false;
  const markPanelActivity = (): void => { panelHovered = true; };
  const onPanelLeave = (): void => { panelHovered = false; };

  // Insert / locate panel root.
  let panel = doc.getElementById(PANEL_ID);
  if (!panel) {
    panel = doc.createElement("div");
    panel.id = PANEL_ID;
    panel.setAttribute("style", PANEL_STYLE);
    doc.body.appendChild(panel);
  }
  // Inject the :hover CSS once. Can't be inline because :hover requires a
  // stylesheet, not a style attribute.
  if (!doc.getElementById("ogamex-goals-panel-hover-css")) {
    const styleEl = doc.createElement("style");
    styleEl.id = "ogamex-goals-panel-hover-css";
    styleEl.textContent = PANEL_HOVER_CSS;
    doc.head.appendChild(styleEl);
  }
  panel.addEventListener("mouseenter", markPanelActivity);
  panel.addEventListener("mousemove", markPanelActivity);
  panel.addEventListener("mouseleave", onPanelLeave);

  // Restore saved position (if any). Default top:80px right:12px otherwise.
  // Clamp to viewport — a saved offscreen position would make the panel
  // invisible to the operator (common bug: dragged offscreen, then forget).
  const savedPos = loadJSON<{ left?: number; top?: number } | null>(LS_POS_KEY, null);
  if (savedPos && typeof savedPos.left === "number" && typeof savedPos.top === "number") {
    const vw = doc.defaultView?.innerWidth ?? 1280;
    const vh = doc.defaultView?.innerHeight ?? 720;
    const margin = 40; // keep at least this many px of panel on-screen
    const left = Math.max(0, Math.min(savedPos.left, vw - margin));
    const top = Math.max(0, Math.min(savedPos.top, vh - margin));
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
    panel.style.right = "auto";
    // If clamped, persist the corrected value back so it sticks next reload.
    if (left !== savedPos.left || top !== savedPos.top) {
      saveJSON(LS_POS_KEY, { left, top });
    }
  }
  let collapsed = loadJSON<boolean>(LS_COLLAPSED_KEY, false);

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  // Last fetched goals — used so tree-toggle clicks can re-render without
  // hitting /v1/goals again.
  let lastGoals: GoalRowFromHttp[] | null = null;
  // v0.0.487 accordion — operator 2026-05-30 "panel goals 全部展開太長了, 改
  // 成手風琴". Only one goal expanded at a time; click row header to toggle.
  // null = all collapsed. Persists in localStorage so panel re-mounts (page
  // reload, panel close+open) keep the same row open.
  let expandedGoalId: string | null = (() => {
    try { return localStorage.getItem("ogamex.panel.expanded") || null; } catch { return null; }
  })();
  const setExpandedGoalId = (id: string | null): void => {
    expandedGoalId = id;
    try {
      if (id) localStorage.setItem("ogamex.panel.expanded", id);
      else localStorage.removeItem("ogamex.panel.expanded");
    } catch { /* private mode */ }
  };
  let lastEmergency: EmergencyPayload | null = null;
  let lastExpedition: ExpeditionPayload | null = null;
  // Persisted section-level collapse state.
  // Operator 2026-05-26: "panel 菜單 預設都是收起的". One-time migration:
  // if sentinel v302 not set, overwrite all section flags to collapsed=true
  // (old users had localStorage values from before this directive).
  const COLLAPSED_DEFAULT_SENTINEL = "ogamex.panel.collapsed-default.v302";
  if (!loadJSON<boolean>(COLLAPSED_DEFAULT_SENTINEL, false)) {
    saveJSON("ogamex.panel.section.emergency", true);
    saveJSON("ogamex.panel.section.expedition", true);
    saveJSON("ogamex.panel.section.goals", true);
    saveJSON("ogamex.panel.section.discovery", true);
    saveJSON("ogamex.panel.section.moons", true);
    saveJSON("ogamex.panel.section.cargo", true);
    saveJSON(COLLAPSED_DEFAULT_SENTINEL, true);
  }
  const sectionCollapsed: Record<string, boolean> = {
    emergency: loadJSON<boolean>("ogamex.panel.section.emergency", true),
    expedition: loadJSON<boolean>("ogamex.panel.section.expedition", true),
    goals: loadJSON<boolean>("ogamex.panel.section.goals", true),
    moons: loadJSON<boolean>("ogamex.panel.section.moons", true),
    discovery: loadJSON<boolean>("ogamex.panel.section.discovery", true),
    cargo: loadJSON<boolean>("ogamex.panel.section.cargo", true),
  };
  // Cargo calculator local state (persisted across re-renders within session).
  // auto-follow: when true, Cargo Calc planet auto-tracks ogame's active planet
  // (meta[name="ogame-planet-id"]). operator 切星球時資源自動刷新. 一旦 operator
  // 手動改 dropdown → autoFollow=false, planet 鎖定. 重置 autoFollow 透過再次
  // 選中"= ogame 當前" (UI暫不暴露, 預設就是自動).
  const cargoState: { planetId: string; ship: "smallCargo" | "largeCargo"; use: { m: boolean; c: boolean; d: boolean }; autoFollow: boolean } = {
    planetId: loadJSON<string>("ogamex.panel.cargo.planet", ""),
    ship: (loadJSON<string>("ogamex.panel.cargo.ship", "largeCargo") as "smallCargo" | "largeCargo"),
    use: loadJSON<{ m: boolean; c: boolean; d: boolean }>("ogamex.panel.cargo.use", { m: true, c: true, d: true }),
    autoFollow: loadJSON<boolean>("ogamex.panel.cargo.autoFollow", true),
  };
  function setSectionCollapsed(name: string, val: boolean): void {
    sectionCollapsed[name] = val;
    saveJSON(`ogamex.panel.section.${name}`, val);
  }

  async function fetchGoals(): Promise<GoalRowFromHttp[]> {
    // 2026-06-05 — per-user Bearer routes sidecar listGoals → goalsStorePg.list(uid)
    // so PG-only goals (web POST /api/me/goals/transport → PG) become visible
    // to the in-page TM panel. Without Bearer, sidecar resolveBearer returns
    // legacy → SQLite cross-tenant only → webtx-* invisible. Token source
    // matches the pause-daemon path above: opts.bridgeToken → localStorage.
    let tok: string | null = opts.bridgeToken ?? null;
    if (!tok) {
      try { tok = (typeof window !== "undefined" ? window.localStorage.getItem("OGAMEX_BRIDGE_TOKEN") : null); }
      catch { /* sandbox isolation */ }
    }
    const init: RequestInit = tok
      ? { headers: { "Authorization": `Bearer ${tok}` } }
      : {};
    const r = await fetchFn(`${baseUrl}/ogamex/v1/goals`, init);
    if (!r.ok) throw new Error(`http ${r.status}`);
    const body = await r.json() as { goals: GoalRowFromHttp[] };
    return body.goals;
  }

  interface EmergencyPayload {
    hostile: Array<{ id: string; type: string; arrives_at: number; eta_in_seconds: number; from: string | null; to: string | null; to_type?: "planet" | "moon"; ships_count: number | "?"; }>;
    count: number;
    snapshot_age_ms: number | null;
  }
  interface ExpeditionPayload {
    active: Array<{ fleet_id: string; arrival_at: number; return_at: number | null; eta_in_seconds: number; origin: string | null; dest: string | null; ships: Record<string, number>; }>;
    used: number; max: number; astrophysics_level: number;
    state_ready?: boolean;
  }
  async function fetchEmergency(): Promise<EmergencyPayload | null> {
    try {
      // v0.0.841 同 fetchExpedition 修补 — 加 Bearer header 避免 fallback stateRef.current.
      const r = await fetchFn(`${baseUrl}/ogamex/v1/emergency`, { headers: authHeaders() });
      if (!r.ok) return null;
      const body = await r.json() as Partial<EmergencyPayload>;
      // Validate shape — tests / stale stubs may return wrong objects.
      if (!Array.isArray(body.hostile)) return null;
      return body as EmergencyPayload;
    } catch { return null; }
  }
  async function fetchExpedition(): Promise<ExpeditionPayload | null> {
    try {
      // v0.0.841 — operator 2026-06-06 "新号 TM 远征看到老号, 老号看到新号":
      // fetchExpedition 老逻辑没带 Bearer header → sidecar resolveBearer 落空,
      // expeditionProvider fallback stateRef.current (全局主号 state) → cross-tenant
      // 串流. 跟 fetchEmergency / fetchGoals 对齐用 authHeaders (含 localStorage fallback).
      const r = await fetchFn(`${baseUrl}/ogamex/v1/expedition`, { headers: authHeaders() });
      if (!r.ok) return null;
      const body = await r.json() as Partial<ExpeditionPayload>;
      if (!Array.isArray(body.active)) return null;
      return body as ExpeditionPayload;
    } catch { return null; }
  }
  function fmtEta(seconds: number): string {
    if (seconds < 60) return `${seconds}s`;
    const m = Math.floor(seconds / 60), s = seconds % 60;
    if (m < 60) return `${m}m${s.toString().padStart(2,"0")}s`;
    const h = Math.floor(m / 60);
    return `${h}h${(m % 60).toString().padStart(2,"0")}m`;
  }

  async function actGoal(id: string, action: "cancel" | "pause" | "resume" | "set-main" | "unset-main"): Promise<void> {
    const r = await fetchFn(`${baseUrl}/ogamex/v1/goals/${encodeURIComponent(id)}/${action}`, { method: "POST", headers: authHeaders() });
    if (!r.ok) {
      const body = await r.text();
      throw new Error(`${action} failed: http ${r.status} ${body}`);
    }
  }

  function isPaused(g: GoalRowFromHttp): boolean {
    return g.status === "blocked" && (g.reason ?? "").startsWith("PAUSED");
  }

  // v0.0.474: derive panel display status from goal status+reason+type.
  // Operator 2026-05-30: "停下的時候不要都顯示block 添加 building reseaching
  // 可以反映真實的狀態". Maps raw "blocked" + reason text into specific
  // sub-states so operator can see WHY a goal isn't progressing at a glance.
  function deriveDisplayStatus(g: GoalRowFromHttp, allGoals: GoalRowFromHttp[] = []): { label: string; color: string } {
    // v0.0.484 — operator 2026-05-30 "統一檢查所有任務狀態". Single unified
    // priority ladder, top to bottom. Every layer carries current_step or
    // body_build_q specificity (not just generic "blocked / waiting"). The
    // ladder is documented inline so future edits don't drift.
    //
    // Priority ladder (high → low):
    //   L1.  paused                                       ★ operator override
    //   L2.  ogame build_q in flight on this body         ★ ground truth (any tech)
    //   L3.  goal.eta_at > now (planner says we're building)
    //   L4.  status === "active" — by type sub-label
    //   L5.  current_step shortage AND body has no prod   → "awaiting transport: <cs.tech>"
    //   L6.  current_step shortage AND body has prod      → "waiting resources: <cs.tech>"
    //   L7.  same-family sibling active                    → "queued · waiting <sib.tech>"
    //   L8.  blocked — reason pattern → friendly label
    //   L9.  pending / completed / cancelled fallback
    const reason = g.reason ?? "";
    const goalType = g.type;
    const cs = g.current_step;
    // v0.0.847 — operator 2026-06-06 "如果建了能源会变负值, 没有优化吗": planner
    // 真在 cascade (energy gate trigger → 派 solarPlant 先), 但 cs 还是 root goal
    // tech. 解析 reason "need <tech> L<lvl> first" 提 cascade leaf 覆盖显示, 让
    // owner 一眼看出当前是在等谁的资源.
    const cascadeMatch = reason.match(/need\s+(\w+)\s+L(\d+)\s+first/i);
    const stepLabel = cascadeMatch
      ? `${techName(cascadeMatch[1]!)} L${cascadeMatch[2]} (cascade prereq)`
      : (cs ? `${techName(cs.tech)} L${cs.level}` : "");
    const now = Date.now();

    // L1
    if (isPaused(g)) return { label: t("goal.state.paused"), color: "#8a8aff" };
    // L2 — body's ogame queue is ground truth FOR BUILD/RESEARCH FAMILY ONLY.
    // v0.0.510 — operator 2026-05-31: deploy/transport/jumpgate chain leg
    // 誤顯示 "building <body's tech>" 因爲 body_build_q 跟 deploy 語義無關。
    // fleet/jg goals 走自己 status 路徑, 不蹭 body 的 build_q。
    const isBuildFamily = goalType === "build" || goalType === "build_universal"
      || goalType === "research" || goalType === "build_ships" || goalType === "build_defense"
      || goalType === "lifeform_building";
    const bq = g.body_build_q;
    // v0.0.836 — operator 2026-06-06 "为什么要渲染两次, 两套代码合并一下".
    // L2 老逻辑 蹭 body_build_q 不管 queue 在建的是不是本 goal 目标. 同 planet
    // 多 goal 时, A goal 显示 B goal 的 tech+L+eta (panel 第一次刷新错), 直到
    // L3 eta_at fresh 数据来了才纠正绿色. 修: L2 仅当 bq.tech === goal.target.
    // building (或同等 alias) 时才认为 "ogame queue 正在做本 goal". 否则不蹭
    // bq, 让 L3 (planner eta_at) / L4 (status active) 主导.
    const goalTargetBuilding = (g.target as { building?: string; tech?: string } | undefined);
    const goalTargetTech = goalTargetBuilding?.building ?? goalTargetBuilding?.tech ?? "";
    const bqMatchesGoal = bq && goalTargetTech && bq.tech === goalTargetTech;
    if (isBuildFamily && bq && bq.ends_at > now && bqMatchesGoal) {
      const lvLabel = bq.level !== null && bq.level !== undefined ? ` L${bq.level}` : "";
      const etaMin = Math.max(0, Math.round((bq.ends_at - now) / 60_000));
      const tplKey = bq.queue === "lf_build" ? "goal.state.body_q.lifeform_template"
        : bq.queue === "shipyard" ? "goal.state.body_q.constructing_template"
        : "goal.state.body_q.building_template";
      return { label: t(tplKey, { tech: techName(bq.tech), lvl: lvLabel, eta: etaMin }), color: "#7cfc00" };
    }
    // L2.5 — v0.0.692: operator 2026-06-03 "卡资源就写等待资源，为什么用绿色的建造中".
    // 资源饥饿（current_step 缺 m/c/d 或 goal-level resource_shortage > 0）+ ogame
    // 队列实际没在 build (bq 不在 future) → 不是"建造中"，是"等待资源/运输"。
    // 此分支必须比 L3 (eta_at>now) 和 L4 (status=active) 优先，否则 4516d 的
    // eta_at 会让 L3 误返"🏗 建造中 (绿色)"。
    const csShortageEarly = cs ? cs.shortage.m + cs.shortage.c + cs.shortage.d : 0;
    const goalShortageEarly = g.resource_shortage;
    const hasShortageEarly = csShortageEarly > 0
      || !!(goalShortageEarly && (goalShortageEarly.m + goalShortageEarly.c + goalShortageEarly.d) > 0);
    // v0.0.837 — operator 2026-06-06 "感觉还是有两套渲染机制, 点一下绿色 多点
    // 几次变黄色 再点几次又绿色 循环". 真因 = L2.5 hasShortageEarly 每 tick
    // 抖, planner shortage 数据跨 tick 变化导致 green↔yellow 闪烁. 修: L2.5
    // 收紧只 status==='blocked' 才 fire (status=pending/active 让 L3 eta_at 或
    // L4 status label 主导, 绿色稳定). 老 v0.0.811 eta_at 兜底保留.
    if (isBuildFamily && hasShortageEarly && g.status === "blocked") {
      if (typeof g.eta_at === "number" && g.eta_at > now) {
        // fall through to L3 building branch — eta_at 是 ground truth
      } else {
        const target = cs ? stepLabel : "";
        return { label: target ? t("goal.state.waiting_resources_step", { step: target }) : t("goal.state.waiting_resources"), color: "#ffaa55" };
      }
    }
    // L3 — planner's eta_at for this goal's tech is in the future
    if (typeof g.eta_at === "number" && g.eta_at > now) {
      const slot = cs ? stepLabel : t("goal.state.in_queue");
      if (cs?.kind === "research") return { label: t("goal.state.researching_with_step", { step: slot }), color: "#7cc0ff" };
      if (goalType === "build_ships" || goalType === "build_defense") return { label: t("goal.state.building_ships"), color: "#7cfc00" };
      if (goalType === "lifeform_building") return { label: t("goal.state.building_lifeform_with_step", { step: slot }), color: "#7cfc00" };
      return { label: t("goal.state.building_with_step", { step: slot }), color: "#7cfc00" };
    }
    // L4 — active/pending status without eta_at. v0.0.802 — operator
    // 2026-06-05 "不要显示 pending 显示当前动作是什么": pending 走跟 active
    // 同 logic, 推 "building X" / "researching X" 等 contextual label, 不再
    // 在 L7 fallthrough 显示 raw "pending" 文本.
    if (g.status === "active" || g.status === "pending") {
      if (goalType === "research") return { label: cs ? t("goal.state.researching_with_step", { step: stepLabel }) : t("goal.state.researching"), color: "#7cc0ff" };
      if (goalType === "build" || goalType === "build_universal") return { label: cs ? t("goal.state.building_with_step", { step: stepLabel }) : t("goal.state.building"), color: "#7cfc00" };
      if (goalType === "build_ships" || goalType === "build_defense") return { label: t("goal.state.constructing_ships"), color: "#7cfc00" };
      if (goalType === "lifeform_building") return { label: cs ? t("goal.state.building_lifeform_with_step", { step: stepLabel }) : t("goal.state.building_lifeform"), color: "#7cfc00" };
      if (goalType === "expedition") return { label: t("goal.state.expedition_flying"), color: "#80c0ff" };
      if (goalType === "colonize") return { label: t("goal.state.colonizing"), color: "#80c0ff" };
      if (goalType === "deploy") return { label: t("goal.state.deploying"), color: "#80c0ff" };
      if (goalType === "transport") return { label: t("goal.state.transporting"), color: "#80c0ff" };
      if (goalType === "jumpgate") return { label: t("goal.state.jumping"), color: "#80c0ff" };
      return { label: t("goal.state.active"), color: "#7cfc00" };
    }
    // L5 + L6 — blocked on resources. Use current_step for specificity.
    // Body has no production (moon or 0-prod planet) → must be operator-fed
    // via transport. Body has production → just waiting for natural fill.
    const csShortageSum = cs ? cs.shortage.m + cs.shortage.c + cs.shortage.d : 0;
    const goalShortage = g.resource_shortage;
    const hasShortage = csShortageSum > 0 || !!(goalShortage && (goalShortage.m + goalShortage.c + goalShortage.d) > 0);
    if (g.status === "blocked" && hasShortage && /waiting.*resources|waiting \d+s for resources/i.test(reason)) {
      // v0.0.693 — operator 2026-06-03 "等待资源和等待运输合并". Single
      // status replaces L5 (awaiting_transport) + L6 (waiting_resources).
      const target = cs ? stepLabel : "";
      return { label: target ? t("goal.state.waiting_resources_step", { step: target }) : t("goal.state.waiting_resources"), color: "#ffaa55" };
    }
    // L7 — same slot-family sibling currently building (queued behind)
    const slotFamily = (gg: GoalRowFromHttp): string | null => {
      const tVal = gg.type;
      if (tVal === "research") return "research:*";
      if (tVal === "build_ships" || tVal === "build_defense") return gg.planet ? `shipyard:${gg.planet}` : null;
      if (tVal === "lifeform_building") return gg.planet ? `lf:${gg.planet}` : null;
      if (tVal === "build" || tVal === "build_universal") return gg.planet ? `build:${gg.planet}` : null;
      return null;
    };
    const myFamily = slotFamily(g);
    if (myFamily) {
      const sibling = allGoals.find((o) =>
        o.id !== g.id &&
        slotFamily(o) === myFamily &&
        o.status === "active" &&
        typeof o.eta_at === "number" &&
        (o.eta_at ?? 0) > now,
      );
      if (sibling) {
        const sib = sibling.current_step;
        const sibLabel = sib ? `${techName(sib.tech)} L${sib.level}` : sibling.type;
        const etaMin = Math.max(0, Math.round(((sibling.eta_at ?? 0) - now) / 60_000));
        return { label: t("goal.state.queued_waiting", { step: sibLabel, eta: etaMin }), color: "#bdb76b" };
      }
    }
    // L8 — blocked with other reason patterns
    if (g.status === "blocked") {
      if (/build slot.*in use|shipyard slot.*in use|research slot.*in use|lf build slot.*in use/i.test(reason)) return { label: t("goal.state.queued_slot_busy"), color: "#bdb76b" };
      if (/moon fields nearly full/i.test(reason)) return { label: t("goal.state.fields_full_lb"), color: "#ff9b6b" };
      if (/120012|該行星已沒空間了|该行星已没空间/i.test(reason)) return { label: t("goal.state.fields_full_planet"), color: "#ff6b6b" };
      if (/chain prereq.*waiting/i.test(reason)) return { label: t("goal.state.chain_wait"), color: "#bdb76b" };
      if (/has \d+× .*, need \d+|insufficient.*ship|0× .*, need/i.test(reason)) return { label: t("goal.state.ships_short"), color: "#ff9b6b" };
      if (/expedition slots full|fleet slots full|early skip, not queued/i.test(reason)) return { label: t("goal.state.slots_full"), color: "#bdb76b" };
      if (/storage.*insufficient|insufficient.*storage|倉存容量不足|倉存容量不足|140028/i.test(reason)) return { label: t("goal.state.dest_storage_full"), color: "#ff9b6b" };
      if (/transient race|140043|請稍後再試|請稍後再試|try again later/i.test(reason)) return { label: t("goal.state.ogame_race_retry"), color: "#bdb76b" };
      if (/100001|未知的錯誤|未知的錯誤/i.test(reason)) return { label: t("goal.state.ogame_error_100001"), color: "#ff6b6b" };
      if (/120023|沒有空間|沒有空間|月球上.*空間|月球上.*空間/i.test(reason)) return { label: t("goal.state.moon_space_full"), color: "#ff6b6b" };
      if (/cooldown.*remaining/i.test(reason)) return { label: t("goal.state.cooldown"), color: "#bdb76b" };
      if (/jumpgate.*not on moon|missing source_moon|missing target_moon/i.test(reason)) return { label: t("goal.state.jg_misconfig"), color: "#ff6b6b" };
      if (/planet-only building.*cannot.*moon|moon-only building.*cannot.*planet/i.test(reason)) return { label: t("goal.state.body_type_mismatch"), color: "#ff6b6b" };
      if (/awaiting.*event|awaiting empire_poll|awaiting operator_retry/i.test(reason)) return { label: t("goal.state.awaiting_event"), color: "#80c0ff" };
      return { label: t("goal.state.blocked"), color: "#bdb76b" };
    }
    if (g.status === "pending") return { label: t("goal.state.pending"), color: "#80c0ff" };
    if (g.status === "completed") return { label: t("goal.state.completed"), color: "#888" };
    if (g.status === "cancelled") return { label: t("goal.state.cancelled"), color: "#888" };
    return { label: g.status, color: "#ccc" };
  }

  // v0.0.526 — operator 2026-05-31 "這部分爲什麼不折疊?". 翻轉預設:
  // tree node 預設全部折疊, 點選 chevron 才展開 (而不是預設全展開)。
  // treeExpanded Set 裝當前展開的 node key, 沒在 set 裏的就是折疊。
  const treeExpanded = new Set<string>();
  // v0.0.740 — operator "tree 不要一个一个点 一键展开和收回". 全局 toggle:
  //   true  → 所有节点展开 (无视 treeExpanded set)
  //   false → 默认 (v0.0.526 折叠语义 + v0.0.739 root depth=0 强制展开)
  let treeExpandAll = false;
  function treeKey(n: PrereqTreeNode): string { return `${n.tech}:${n.targetLevel}`; }

  /**
   * Render a PrereqTreeNode and its subtree as nested HTML. Each row shows:
   *   [▸/▾]  tech_name  cur/target  [✓ met / ⏳ in-progress]
   * Children rendered with left-indent. Met leaves don't get a chevron.
   */
  function fmtSeconds(sec: number): string {
    if (sec < 60) return `${Math.round(sec)}s`;
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    if (h === 0) return `${m}m`;
    if (h < 24) return `${h}h${m.toString().padStart(2,"0")}m`;
    const d = Math.floor(h / 24);
    return `${d}d${(h % 24).toString().padStart(2,"0")}h`;
  }

  // v0.0.916 — renderTreeNode 接 ctx: 若 ctx.currentStep 匹配本节点 tech+level,
  // 在该行追加 shortage 数字 + 右对齐的 運輸 按钮.
  // v0.0.917 — owner "当前任务不要折叠": forceExpandKeys 集合包含 current-step
  // 节点 + 到 root 的所有 ancestor key, 这些节点 collapsed 强制 false.
  type RenderTreeCtx = {
    goalId: string;
    goalPlanet?: string | undefined;
    currentStep?: { tech: string; level: number; shortage: { m: number; c: number; d: number }; kind?: string; cost?: unknown } | null | undefined;
    bodyBuildQ?: { tech?: string | undefined; level?: number | null | undefined; ends_at?: number | undefined; queue?: string | undefined } | null | undefined;
    bypassFillBtn?: boolean | undefined;
    forceExpandKeys?: Set<string> | undefined;
  };
  // 预扫描 tree 找出 current-step 节点到 root 的路径上所有 key, 让这些节点
  // 不被 treeExpanded 集合的"折叠默认"影响.
  function collectCurrentStepPath(root: PrereqTreeNode, cs: { tech: string; level: number } | null | undefined): Set<string> {
    const keys = new Set<string>();
    if (!cs) return keys;
    const stack: string[] = [];
    const walk = (n: PrereqTreeNode): boolean => {
      stack.push(treeKey(n));
      if (n.tech === cs.tech && n.targetLevel === cs.level) {
        for (const k of stack) keys.add(k);
        return true;
      }
      for (const c of n.children) {
        if (walk(c)) return true;
      }
      stack.pop();
      return false;
    };
    walk(root);
    return keys;
  }
  function renderTreeNode(n: PrereqTreeNode, depth = 0, ctx?: RenderTreeCtx): string {
    const indent = depth * 14;
    const hasChildren = n.children.length > 0;
    const key = treeKey(n);
    // v0.0.917 — owner "当前任务不要折叠": 路径上的 key 强制展开.
    const onCurrentPath = ctx?.forceExpandKeys?.has(key) === true;
    const collapsed = !treeExpandAll && depth > 0 && !treeExpanded.has(key) && !onCurrentPath;
    const chev = hasChildren
      ? `<span data-tree-toggle="${escapeHtml(key)}" style="display:inline-block; width:12px; cursor:pointer; color:#8090a8; user-select:none;">${collapsed ? "▸" : "▾"}</span>`
      : `<span style="display:inline-block; width:12px;"></span>`;
    const statusBadge = n.met
      ? `<span style="color:#7cfc00;" title="prereq met">✓</span>`
      : n.currentLevel > 0
        ? `<span style="color:#bdb76b;" title="partial">⏳</span>`
        : `<span style="color:#ff6b6b;" title="not started">●</span>`;
    const kindIcon = n.kind === "research" ? "🧪" : "🏗";
    const levelStr = `${n.currentLevel}/${n.targetLevel}`;
    const techColor = n.met ? "#7080a8" : "#d8e0ec";
    const subtreeEta = n.subtree_eta_seconds ?? 0;
    const etaBadge = (n.met || subtreeEta <= 0)
      ? ""
      : `<span style="color:#8090a8; font-size:10px; margin-left:4px;" title="time to complete this branch (serial)">⏱ ${fmtSeconds(subtreeEta)}</span>`;
    const qlbl = n.queue_label
      ? `<span style="color:#9ab; font-size:10px; background:#1a2332; padding:1px 4px; border-radius:3px; margin-right:3px;" title="ogame 执行序: ${n.queue_label.startsWith("R") ? "research_q" : "build_q"}">${escapeHtml(n.queue_label)}</span>`
      : "";
    // v0.0.916 — current-step inline chip + right-aligned 運輸 button
    let csChipHtml = "";
    let csBtnHtml = "";
    if (ctx?.currentStep && ctx.currentStep.tech === n.tech && ctx.currentStep.level === n.targetLevel) {
      const cs = ctx.currentStep;
      const csh = cs.shortage;
      const bqMatchesCS = ctx.bodyBuildQ
        && ctx.bodyBuildQ.tech === cs.tech
        && ctx.bodyBuildQ.level === cs.level
        && (ctx.bodyBuildQ.ends_at ?? 0) > Date.now();
      if (bqMatchesCS) {
        const etaMin = Math.max(0, Math.round(((ctx.bodyBuildQ!.ends_at ?? 0) - Date.now()) / 60_000));
        csChipHtml = `<span style="color:#7cfc00; font-size:10px; margin-left:6px;">~${etaMin}m</span>`;
      } else {
        const fmtRes = (x: number): string => x >= 1_000_000 ? `${(x/1_000_000).toFixed(1)}M` : x >= 1_000 ? `${(x/1_000).toFixed(0)}K` : String(Math.round(x));
        const bits = [
          csh.m > 0 ? `${fmtRes(csh.m)} m` : "",
          csh.c > 0 ? `${fmtRes(csh.c)} c` : "",
          csh.d > 0 ? `${fmtRes(csh.d)} d` : "",
        ].filter(Boolean).join(" · ");
        if (bits) csChipHtml = `<span style="color:#ff9b6b; font-size:10px; margin-left:6px;">${escapeHtml(t('auto.289'))} ${bits}</span>`;
        const csTotal = csh.m + csh.c + csh.d;
        if (csTotal > 0 && !ctx.bypassFillBtn) {
          // inline button style (btnStyle is scoped to render() at L3996,
          // renderTreeNode is hoisted above it).
          const btnInline = "background:#205a40; color:#fff; border:1px solid #408a60; padding:1px 6px; border-radius:3px; cursor:pointer; font-size:10px;";
          csBtnHtml = `<button data-action-fill-shortage="${escapeHtml(ctx.goalId)}" data-fill-target="${escapeHtml(ctx.goalPlanet ?? "")}" data-fill-building="${escapeHtml(cs.tech)}" data-fill-m="${Math.ceil(csh.m)}" data-fill-c="${Math.ceil(csh.c)}" data-fill-d="${Math.ceil(csh.d)}" style="${btnInline}" title="${escapeHtml(t('auto.154'))}">${escapeHtml(t('auto.274'))}</button>`;
        }
      }
    }
    const me = `
      <div style="padding:2px 0 2px ${indent}px; font-size:11px; color:${techColor}; display:flex; align-items:center; gap:4px;">
        ${chev}<span>${kindIcon}</span>
        ${qlbl}<span style="flex:1;">${escapeHtml(techName(n.tech))} <span style="color:#8090a8;">(${levelStr})</span>${etaBadge}${csChipHtml}</span>
        ${statusBadge}
        ${csBtnHtml}
      </div>`;
    const kids = hasChildren && !collapsed
      ? n.children.map((c) => renderTreeNode(c, depth + 1, ctx)).join("")
      : "";
    return me + kids;
  }

  function render(goals: GoalRowFromHttp[], err?: string): void {
    if (!panel) return;
    // v0.0.426: when a chain has ANY non-terminal leg, keep ALL its legs in
    // the view so the tree renders end-to-end (operator 2026-05-29: Leg A
    // completed → panel hid it → jumpgate appeared as "Leg 1 logic error").
    // Singleton terminal goals still hide as before.
    const filtered = showTerminal
      ? goals
      : (() => {
          const liveChainIds = new Set<string>();
          for (const g of goals) {
            const cid = (g.target as Record<string, unknown>)?.chain_id;
            if (typeof cid === "string" && cid && g.status !== "completed" && g.status !== "cancelled") {
              liveChainIds.add(cid);
            }
          }
          return goals.filter((g) => {
            const cid = (g.target as Record<string, unknown>)?.chain_id;
            if (typeof cid === "string" && cid && liveChainIds.has(cid)) return true;
            return g.status !== "completed" && g.status !== "cancelled";
          });
        })();
    const statusColor: Record<string, string> = {
      pending: "#bdb76b", active: "#7cfc00", blocked: "#ff6b6b",
      completed: "#666", cancelled: "#888",
    };
    const btnStyle = (bg: string, border: string) =>
      `background:${bg}; color:#fff; border:1px solid ${border}; padding:2px 6px; border-radius:3px; cursor:pointer; font-size:10px;`;
    // Compact target formatter — operator wants:
    //   build      [1:190:6] P deuteriumSynth 12
    //   research   combustion 6
    //   build_ships [1:190:6] P largeCargo×2
    //   expedition [1:190:6] P ×1
    const fmtTarget = (type: string, target: Record<string, unknown>): string => {
      const coords = (target["source_coords"] as string | undefined)
        ?? (target["coords"] as string | undefined)
        ?? "";
      const planetTag = coords ? `[${coords}] P` : (target["planet_id"] ? `[${String(target["planet_id"]).slice(-4)}] P` : "");
      switch (type) {
        case "build": {
          const b = techName(String(target["building"] ?? "?"));
          const lvl = target["target_level"] ?? target["level"] ?? "";
          return [planetTag, b, lvl].filter(Boolean).join(" ");
        }
        case "research": {
          const tVal = techName(String(target["tech"] ?? "?"));
          const lvl = target["target_level"] ?? target["level"] ?? "";
          return [tVal, lvl].filter(Boolean).join(" ");
        }
        // v0.0.742 — operator "修 i18n 所有27种语言". lifeform_building +
        // lifeform_research 之前掉进 default JSON.stringify, 显示 raw
        // {"building":"supraRefractor","level":1}. 现在走 techName(),
        // 27 locale 全覆盖 (TW 中文 / 其他英文兜底 from catalog).
        case "lifeform_building": {
          const b = techName(String(target["building"] ?? "?"));
          const lvl = target["target_level"] ?? target["level"] ?? "";
          return [planetTag, b, lvl].filter(Boolean).join(" ");
        }
        case "lifeform_research": {
          const tVal = techName(String(target["tech"] ?? target["research"] ?? "?"));
          const lvl = target["target_level"] ?? target["level"] ?? "";
          return [planetTag, tVal, lvl].filter(Boolean).join(" ");
        }
        case "pick_lifeform":
        case "lifeform_level_to": {
          const species = String(target["species"] ?? target["lifeform"] ?? "?");
          const lvl = target["target_level"] ?? target["level"] ?? "";
          return [planetTag, species, lvl].filter(Boolean).join(" ");
        }
        case "build_ships": {
          const s = techName(String(target["ship"] ?? "?"));
          const amt = target["amount"] ?? 1;
          return [planetTag, `${s}×${amt}`].filter(Boolean).join(" ");
        }
        case "expedition": {
          const cnt = target["count"] ?? target["count_remaining"] ?? 1;
          return [planetTag, `×${cnt}`].filter(Boolean).join(" ");
        }
        case "colonize": {
          const tgtCoords = String(target["target_coords"] ?? "?");
          return [planetTag, "→", tgtCoords].filter(Boolean).join(" ");
        }
        case "species_discovery": {
          // Operator 2026-05-28: don't JSON-dump the completed[] array
          // (200+ coord strings). Show only source planet coords.
          const srcId = String(target["source_planet"] ?? "");
          let srcCoords = srcId ? `(${srcId.slice(-4)})` : "?";
          try {
            const st = (window as Window & { __ogamexStore?: { state: { planets: Record<string, { coords?: number[] }> } } }).__ogamexStore;
            const p = srcId ? st?.state.planets?.[srcId] : undefined;
            if (p?.coords) srcCoords = p.coords.join(":");
          } catch { /* */ }
          return `@ ${srcCoords}`;
        }
        default:
          return JSON.stringify(target);
      }
    };
    // Operator 2026-05-29: chain-aware grouping. Goals carrying the same
    // target.chain_id (written by the transport modal) collapse under one
    // synthetic "🚚 運輸 chain" parent row, with each leg shown as a
    // compact "* G:S:P → G:S:P 部署/跳躍/運輸" line.
    const chainStoreRef = (window as Window & { __ogamexStore?: { state?: { planets?: Record<string, { id?: string; coords?: number[] }> } } }).__ogamexStore;
    const planetCoordMap = chainStoreRef?.state?.planets ?? {};
    const resolveCoord = (idOrCoord: string): string => {
      if (!idOrCoord) return "?";
      if (/^\d+:\d+:\d+$/.test(idOrCoord)) return idOrCoord;
      const p = planetCoordMap[idOrCoord];
      return p?.coords ? p.coords.join(":") : idOrCoord;
    };
    const actionCN = (type: string): string =>
      type === "deploy" ? t("auto.150")
      : type === "jumpgate" ? t("auto.096")
      : type === "transport" ? t("auto.151")
      : type;
    const formatChainLeg = (g: GoalRowFromHttp): string => {
      const tgt = (g.target ?? {}) as Record<string, unknown>;
      let src = "?", dest = "?";
      if (g.type === "jumpgate") {
        src = resolveCoord(String(tgt.source_moon ?? ""));
        dest = resolveCoord(String(tgt.target_moon ?? ""));
      } else {
        src = resolveCoord(String(tgt.source_planet ?? g.planet ?? ""));
        dest = String(tgt.target_coords ?? "?");
      }
      return `${src} → ${dest}  ${actionCN(g.type)}`;
    };
    // Partition filtered into chain groups + singletons; sort chain members
    // by priority DESC so dispatch order matches the visual stack.
    const chainGroups = new Map<string, GoalRowFromHttp[]>();
    const singletons: GoalRowFromHttp[] = [];
    for (const g of filtered) {
      const cid = (g.target as Record<string, unknown>)?.chain_id;
      if (typeof cid === "string" && cid) {
        let arr = chainGroups.get(cid);
        if (!arr) { arr = []; chainGroups.set(cid, arr); }
        arr.push(g);
      } else {
        singletons.push(g);
      }
    }
    for (const arr of chainGroups.values()) {
      arr.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
    }
    // v0.0.481 architecture B: parent_goal_id graph. Children render nested
    // under their parent; we pre-compute the children map then hide children
    // from top-level singletons so they don't render twice.
    const childrenByParent = new Map<string, GoalRowFromHttp[]>();
    for (const g of filtered) {
      const pid = (g as { parent_goal_id?: string }).parent_goal_id;
      if (typeof pid === "string" && pid) {
        let arr = childrenByParent.get(pid);
        if (!arr) { arr = []; childrenByParent.set(pid, arr); }
        arr.push(g);
      }
    }
    for (const arr of childrenByParent.values()) {
      arr.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
    }
    // Remove children from singletons (they render under their parent).
    const singletonsTopLevel = singletons.filter((g) => {
      const pid = (g as { parent_goal_id?: string }).parent_goal_id;
      return !pid || !filtered.some((p) => p.id === pid);
    });
    const renderSingleGoalRow = (g: GoalRowFromHttp): string => {
      const targetStr = fmtTarget(g.type, g.target as Record<string, unknown>);
      const paused = isPaused(g);
      // v0.0.1034b — sh / cs 提到 outer scope (treeHtml IIFE 内 sh 不可见时 1034
      // header/mini-row 引用 sh 抛 ReferenceError 整片挂掉).
      const sh = g.resource_shortage;
      const cs = g.current_step;
      // v0.0.916 — isMain UI 已删 (owner "删掉主要任务"); 字段在 PG 仍存在
      // 仅 panel 不再渲染 mainStar/mainBtn/mainBg.
      const derived = deriveDisplayStatus(g, goals);
      const displayStatus = derived.label;
      const color = derived.color;
      // v0.0.702 — operator 2026-06-03 "还是描述了两次缺多少资源，删掉灰色的那个".
      // resource-wait 类 reason 被 csLine 详细 shortage 重复, 直接抑制灰色 raw reason.
      // 非 resource-wait reason (slot busy / moon full / 100001 etc) 仍正常显示。
      const _reasonIsResWait = g.reason && /waiting for resources|waiting \d+s for resources|awaiting transport/i.test(g.reason);
      const reasonLine = (g.reason && !(_reasonIsResWait && g.current_step))
        ? `<div style="color:#a0a0a0; font-size:10px; margin-top:2px;">↳ ${escapeHtml(g.reason)}</div>`
        : "";
      const canAct = g.status === "pending" || g.status === "active" || g.status === "blocked";
      // v0.0.460: awaiting-event chip + Retry button. Only show on blocked
      // goals that have a non-empty awaiting set (the new pure event-driven
      // gate — operator 2026-05-29). Retry button calls /v1/goals/{id}/resume
      // which clears awaiting + immediately re-dispatches.
      const awaitingArr = Array.isArray(g.awaiting_events) ? g.awaiting_events : [];
      const isAwaiting = g.status === "blocked" && awaitingArr.length > 0;
      const awaitingChip = isAwaiting
        ? `<span style="color:#80c0ff; font-size:10px; margin-left:6px; background:#1a3a5a; padding:1px 5px; border-radius:8px;" title="goal blocked until one of these events fires">⏸ awaiting ${awaitingArr.join("/")}</span>`
        : "";
      const retryBtn = isAwaiting
        ? `<button data-action-resume="${escapeHtml(g.id)}" style="${btnStyle("#205a40", "#408a60")}" title="${escapeHtml(t("panel.action.retry_tooltip"))}">${escapeHtml(t("panel.action.retry"))}</button>`
        : "";
      // Active / pending → Pause + Cancel. Paused → Resume + Cancel.
      const pauseOrResume = !canAct ? ""
        : paused
          ? `<button data-action-resume="${escapeHtml(g.id)}" style="${btnStyle("#205a20", "#408a40")}">${escapeHtml(t("panel.action.resume"))}</button>`
          : `<button data-action-pause="${escapeHtml(g.id)}" style="${btnStyle("#5a4a20", "#8a7a40")}">${escapeHtml(t("panel.action.pause"))}</button>`;
      const cancelBtn = canAct
        ? `<button data-action-cancel="${escapeHtml(g.id)}" style="${btnStyle("#5a2020", "#8a4040")}">${escapeHtml(t("panel.action.cancel"))}</button>`
        : "";
      // v0.0.916 — "主要任务" UI 删除 (mainBtn / mainStar / mainBg / isMain
      // 引用全部去掉). PG schema 仍保留 is_main_goal 字段, 仅 UI 层不再渲染.
      // Auto-optimizer-managed goal (id starts with "opt-") gets a 🔧 marker
      // so the operator can distinguish it from manually-added goals.
      const optIcon = g.id?.startsWith("opt-") ? `<span style="color:#7cfc00; font-size:11px;" title="auto-optimizer managed">🔧</span> ` : "";
      // Render the prereq tree for ANY goal that has one — sidecar now
      // attaches it to all non-terminal goals, not only main.
      const treeHtml = g.prereq_tree
        ? (() => {
            const totalEta = g.prereq_tree.subtree_eta_seconds ?? 0;
            // Operator 2026-05-29: shortage chip — "缺 X m / Y c / Z d".
            // Shows EXACTLY how much operator still needs to transport in
            // (or accrue locally) to fully execute the chain. 0 across the
            // board → bank already covers everything; chain only spends
            // build_time.
            const fmtRes = (n: number): string => {
              if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
              if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
              return String(Math.round(n));
            };
            // v0.0.1034b — sh hoisted to renderSingleGoalRow outer scope (above).
            // v0.0.701 — operator 2026-06-03 "当前任务就是最终任务时, 不用比较资源".
            // identity 判定取代浮点比较: current_step.tech+level 等同 goal.target →
            // 没有 prereq 横在中间, 主行 shortage 与 step shortage 必然同一笔账,
            // 只保留主行 Transport 按钮 + step 行 shortage 数字。
            const csForCmp = g.current_step;
            const goalTarget = g.target as { building?: unknown; tech?: unknown; level?: unknown } | undefined;
            const goalTechName = typeof goalTarget?.building === "string" ? goalTarget.building
              : typeof goalTarget?.tech === "string" ? goalTarget.tech
              : "";
            const goalTargetLevel = typeof goalTarget?.level === "number" ? goalTarget.level : -1;
            const samePrereqShortage = !!(csForCmp
              && goalTechName && goalTechName === csForCmp.tech
              && goalTargetLevel >= 0 && goalTargetLevel === csForCmp.level);
            const shortageNumbersHtml = sh && (sh.m + sh.c + sh.d) > 0
              ? `<span style="color:#ff9b6b; font-size:10px; margin-left:6px;" title=t("auto.152")>${escapeHtml(t('auto.289'))} ${sh.m > 0 ? `${fmtRes(sh.m)} m` : ""}${sh.c > 0 ? `${sh.m > 0 ? " · " : ""}${fmtRes(sh.c)} c` : ""}${sh.d > 0 ? `${(sh.m + sh.c) > 0 ? " · " : ""}${fmtRes(sh.d)} d` : ""}</span>`
              : "";
            // v0.0.940 — owner 2026-06-07 "没有总资源, 和总资源的运输按钮": sidecar 送了 total_cost (链总成本)
            // 但 panel 没渲染, owner 看到的"缺"是 cost - bank, 跟 B2 当前步骤
            // 一致 (因为 bank 覆盖了 crystalMine 部分) → owner 误以为只显当前 building.
            // 修: etaHeader 加 "总" 显示链 total_cost, 跟"缺" 并列, owner 一眼看出
            // 全链成本 vs 真实需运输的短缺差.
            const tc = g.total_cost;
            const totalCostHtml = tc && (tc.m + tc.c + tc.d) > 0
              ? `<span style="color:#a0c0e8; font-size:10px; margin-left:6px;" title="链路全部成本(不扣bank)">总 ${tc.m > 0 ? `${fmtRes(tc.m)} m` : ""}${tc.c > 0 ? `${tc.m > 0 ? " · " : ""}${fmtRes(tc.c)} c` : ""}${tc.d > 0 ? `${(tc.m + tc.c) > 0 ? " · " : ""}${fmtRes(tc.d)} d` : ""}</span>`
              : "";
            // v0.0.784 — 操作员当时显示是 csh, 期望按钮填 csh.
            // v0.0.899 — owner 2026-06-07 实证: 当前主行 shortageNumbersHtml
            // 显示的是 `sh` (chain total = 整链累计 e.g. 80.4M m), 但 fillSrc=csh
            // 只填 current_step (e.g. 15.6M m). 显示跟填值不符 owner 报错.
            // 修法 — 主行按钮跟主行显示同源: 用 sh 填 (链总). step 行按钮维持
            // csh (line 4247 stepFillBtn). 两个按钮两种语义清晰: 主行 = "运够
            // 整条链", step 行 = "运够当前一步".
            const fillSrc = sh ?? csForCmp?.shortage ?? { m: 0, c: 0, d: 0 };
            const shortageBtnHtml = (fillSrc.m + fillSrc.c + fillSrc.d) > 0
              ? `<button data-action-fill-shortage="${escapeHtml(g.id)}" data-fill-target="${escapeHtml(g.planet ?? "")}" data-fill-building="${escapeHtml(String((g.target as { building?: unknown })?.building ?? ""))}" data-fill-m="${Math.ceil(fillSrc.m)}" data-fill-c="${Math.ceil(fillSrc.c)}" data-fill-d="${Math.ceil(fillSrc.d)}" style="${btnStyle("#205a40", "#408a60")} margin-left:6px; font-size:10px; padding:1px 6px;" title="${escapeHtml(t('auto.153'))}">${escapeHtml(t('auto.274'))}</button>`
              : "";
            // v0.0.916 — etaHeader 拆 left/right: 文本+缺资源数字左, 運輸按钮右
            // (owner 2026-06-07 "运输按钮居右"). csLine 块整段删除, 当前步骤
            // 的 shortage + 運輸 chip 由 renderTreeNode 在匹配节点上 inline.
            const hasShortage = sh && (sh.m + sh.c + sh.d) > 0;
            const cs2 = g.current_step;
            const bqMatchesCS_outer = cs2 && g.body_build_q
              && g.body_build_q.tech === cs2.tech
              && g.body_build_q.level === cs2.level
              && g.body_build_q.ends_at > Date.now();
            const etaLeftHtml = bqMatchesCS_outer
              ? `<span style="color:#7cfc00;">building ${escapeHtml(cs2.tech)} L${cs2.level} (~${fmtSeconds(Math.floor((g.body_build_q!.ends_at - Date.now())/1000))})</span>`
              : totalEta > 0
                ? `<span style="color:#ffd700;">ETA ≈ ${fmtSeconds(totalEta)}</span>${totalCostHtml}${shortageNumbersHtml}`
                : hasShortage
                  ? `<span style="color:#ffaa55;">awaiting transport (ETA n/a — moon local prod = 0)</span>${totalCostHtml}${shortageNumbersHtml}`
                  : `<span style="color:#7cfc00;">${escapeHtml(t("panel.prereq.all_met"))}</span>${totalCostHtml}`;
            const etaHeader = `<div style="font-size:10px; color:#8090a8; margin-bottom:2px; display:flex; justify-content:space-between; align-items:center; gap:6px;">
              <span>${etaLeftHtml}</span>
              <span>${shortageBtnHtml}</span>
            </div>`;
            // v0.0.527 — 前置鏈都歸入主鏈 tree; etaHeader 直接掛在 tree 顶部.
            // v0.0.916 — csLine 删除, 当前步骤的 shortage+按钮渲染到 tree 节点上.
            return `<div style="margin-top:6px; padding:4px 0 2px; border-top:1px dashed #2a3a52;">
              ${etaHeader}
              ${renderTreeNode(g.prereq_tree, 0, {
                goalId: g.id,
                goalPlanet: g.planet,
                currentStep: g.current_step,
                bodyBuildQ: g.body_build_q,
                // v0.0.989i — owner 2026-06-08 "当前在建的建筑的运输按钮没有了":
                // samePrereqShortage=true (goal.targetLevel === currentStep.level,
                // 即 goal 剩最后 1 级且当前在建该级) 时, 旧逻辑 bypassFillBtn 把整棵树
                // 按钮全 skip 掉 → 缺资源但无 button → "运输按钮没了". 实际只该
                // dedup root 行的 shortage 数字, 按钮该渲染就渲染. 撤 bypassFillBtn.
                bypassFillBtn: false,
                forceExpandKeys: collectCurrentStepPath(g.prereq_tree, g.current_step ?? null),
              })}
            </div>`;
          })()
        : "";
      // ETA from in-flight queue — sidecar computes from build_q /
      // shipyard_q / lf_build_q / research.queue. Renders "ETA ~X min" if
      // an ogame queue is actively building for this goal's planet.
      const etaAtBadge = (typeof g.eta_at === "number" && g.eta_at > Date.now())
        ? `<span style="color:#ffd700; font-size:10px; margin-left:6px;" title="next step finishes at ${new Date(g.eta_at).toLocaleTimeString()}">⏱ ${fmtSeconds(Math.floor((g.eta_at - Date.now()) / 1000))}</span>`
        : "";
      // v0.0.487 accordion — header row is clickable to toggle expansion.
      // Detail block (reason + prereq tree + current_step + buttons) only
      // renders for the currently-expanded goal. Chevron indicates state.
      // v0.0.488 — operator 2026-05-30 "bar 上要顯示星球坐標". Coord shows
      // inline on the bar even when collapsed, so operator can scan moons
      // without expanding.
      // v0.0.1037 — owner 2026-06-09 "取消 L5 不折叠, 总资源显示在天体物理 9 后面,
      // 等资源时当前资源显示在总资源的位置": 删 mini-row (currentStepRow), chip 改
      // 挂在 target name 后面 (collapsed 用 collapsedRow2 同行, expanded 用 targetStr
      // 同行). 切换逻辑: cs 跟 body_build_q 匹配 (in-queue) → 显 chain total 缺;
      // cs 不在 queue (等资源) → 用 cs.shortage 替代显当前 step 缺.
      const isExpanded = expandedGoalId === g.id;
      const chevron = `<span style="color:#8090a8; font-size:10px; width:10px; display:inline-block; user-select:none;">${isExpanded ? "▾" : "▸"}</span>`;
      const coordChip = g.planet
        ? `<span style="color:#a0b0c8; font-size:10px; margin-left:4px;" title="${escapeHtml(g.planet)}">@${escapeHtml(g.planet)}</span>`
        : "";
      const detailBlock = isExpanded
        ? `${reasonLine}${treeHtml}`
        : "";
      const lvlForRow2 = ((): string | "" => {
        const tg = g.target as { target_level?: unknown; level?: unknown; amount?: unknown };
        const v = tg?.target_level ?? tg?.level ?? tg?.amount;
        return typeof v === "number" || (typeof v === "string" && v !== "") ? `L${String(v)}` : "";
      })();
      const collapsedRow2 = (lvlForRow2 || g.planet)
        ? `<span style="color:#8090a8;">${lvlForRow2 ? escapeHtml(lvlForRow2) : ""}${lvlForRow2 && g.planet ? " " : ""}${g.planet ? `@${escapeHtml(g.planet)}` : ""}</span>`
        : "";
      const fmtRes2 = (n: number): string => n >= 1_000_000 ? `${(n/1_000_000).toFixed(1)}M` : n >= 1_000 ? `${(n/1_000).toFixed(0)}K` : String(Math.round(n));
      // v0.0.1037 — 选 chip 源:
      //   in-queue (bqMatchesCS): chain total shortage (主行运资源给后续 dispatch)
      //   等资源 (cs 真态没在 ogame queue): 用 cs.shortage 替代 (这一步要凑多少)
      const bqForChip = g.body_build_q;
      const bqMatchesCS = !!(cs && bqForChip && bqForChip.tech === cs.tech
        && bqForChip.level === cs.level && (bqForChip.ends_at ?? 0) > Date.now());
      const chipSrc: { m: number; c: number; d: number } = (cs && !bqMatchesCS)
        ? cs.shortage
        : (sh ?? { m: 0, c: 0, d: 0 });
      const chipLabel = bqMatchesCS ? "📦" : "⚡";
      const chipTitle = bqMatchesCS ? "整条链累计缺 (后续 dispatch)" : "当前等待的一步 cost - bank";
      const chipHasValue = (chipSrc.m + chipSrc.c + chipSrc.d) > 0;
      const targetChipHtml = chipHasValue
        ? `<span style="color:#ff9b6b; font-size:10px; margin-left:6px;" title="${chipTitle}">${chipLabel} ${escapeHtml(t('auto.289'))} ${chipSrc.m > 0 ? `${fmtRes2(chipSrc.m)} m` : ""}${chipSrc.c > 0 ? `${chipSrc.m > 0 ? " · " : ""}${fmtRes2(chipSrc.c)} c` : ""}${chipSrc.d > 0 ? `${(chipSrc.m + chipSrc.c) > 0 ? " · " : ""}${fmtRes2(chipSrc.d)} d` : ""}</span>`
        : "";
      const targetFillBtnHtml = chipHasValue
        ? `<button data-action-fill-shortage="${escapeHtml(g.id)}" data-fill-target="${escapeHtml(g.planet ?? "")}" data-fill-building="${escapeHtml(cs && !bqMatchesCS ? cs.tech : String((g.target as { building?: unknown })?.building ?? ""))}" data-fill-m="${Math.ceil(chipSrc.m)}" data-fill-c="${Math.ceil(chipSrc.c)}" data-fill-d="${Math.ceil(chipSrc.d)}" style="${btnStyle("#205a40", "#408a60")} font-size:10px; padding:1px 6px; margin-left:4px;" title="${escapeHtml(t('auto.153'))}">${escapeHtml(t('auto.274'))}</button>`
        : "";
      // v0.0.1037b — owner 2026-06-09 "title 上 当前任务的下面 加运输按钮":
      // chip + 运输按钮 挂在 title 行 (status + coord + eta 后, P 之前), 不在 row2.
      // 切换源: bqMatchesCS → chain sh (📦 总缺), else → cs.shortage (⚡ 当前缺).
      return `
        <div style="border-top: 1px solid #2a3a52; padding: 6px 0;">
          <div data-action-toggle-expand="${escapeHtml(g.id)}" style="display:flex; align-items:center; gap:6px; justify-content:space-between; cursor:pointer;" title="${isExpanded ? t("auto.257") : t("auto.258")}">
            <span style="display:flex; align-items:center; gap:6px; flex-wrap:wrap;">${chevron}${optIcon}<span style="color:${color}; font-weight:bold;">${escapeHtml(displayStatus)}</span>${coordChip}${etaAtBadge}${awaitingChip}${targetChipHtml}${targetFillBtnHtml}</span>
            <span style="color:#8090a8; font-size:10px;">P${g.priority}</span>
            <span style="display:flex; gap:4px; flex-wrap:wrap;" data-stop-toggle="1">${retryBtn}${pauseOrResume}${cancelBtn}</span>
          </div>
          ${isExpanded
            ? `<div data-action-toggle-expand="${escapeHtml(g.id)}" style="margin-top:2px; cursor:pointer; font-size:11px;"><strong style="color:#e0e8f0;">${escapeHtml(t(`goal.type.${g.type}`))}</strong> ${escapeHtml(targetStr)}</div>`
            : (collapsedRow2 ? `<div data-action-toggle-expand="${escapeHtml(g.id)}" style="margin-top:2px; cursor:pointer; font-size:10px; padding-left:16px;">${collapsedRow2}</div>` : "")}
          ${detailBlock}
        </div>`;
    };
    // Chain child row — compact format with leg index + prerequisite hint.
    const renderChainChildRow = (g: GoalRowFromHttp, idx: number, prevType: string | null, paused: boolean): string => {
      const leg = formatChainLeg(g);
      const canAct = g.status === "pending" || g.status === "active" || g.status === "blocked";
      const cancelBtn = canAct
        ? `<button data-action-cancel="${escapeHtml(g.id)}" style="${btnStyle("#5a2020", "#8a4040")}">${escapeHtml(t("panel.action.cancel"))}</button>`
        : "";
      const derivedLeg = deriveDisplayStatus(g);
      const color = derivedLeg.color;
      const displayStatus = derivedLeg.label;
      const prereq = idx === 0
        ? t("auto.097")
        : `<span style="color:#a0a8b8; font-size:10px;">前置: 等 Leg ${idx} (${escapeHtml(actionCN(prevType ?? ""))}) 完成</span>`;
      const reasonLine = g.reason ? `<div style="color:#a0a0a0; font-size:10px; margin-top:1px; padding-left:18px;">↳ ${escapeHtml(g.reason)}</div>` : "";
      return `
        <div style="border-top:1px solid #1a2330; padding:4px 0 4px 18px; display:flex; flex-direction:column; gap:2px;">
          <div style="display:flex; align-items:center; gap:6px; justify-content:space-between;">
            <span style="color:#d0d8e0; font-size:11px;"><span style="color:#80a0c8;">Leg ${idx + 1}</span> · ${escapeHtml(leg)} · <span style="color:${color}; font-weight:bold;">${escapeHtml(displayStatus)}</span></span>
            <span style="display:flex; gap:4px; align-items:center;">
              <span style="color:#8090a8; font-size:10px;">P${g.priority}</span>
              ${cancelBtn}
            </span>
          </div>
          ${prereq}
          ${reasonLine}
        </div>`;
    };
    // Chain parent row — synthetic header summarizing the chain. Click is
    // not wired to anything yet (each leg has its own Cancel).
    const renderChainParent = (cid: string, members: GoalRowFromHttp[]): string => {
      const n = members.length;
      const first = members[0]!;
      const last = members[members.length - 1]!;
      const firstSrc = resolveCoord(String(((first.target ?? {}) as Record<string, unknown>).source_planet ?? first.planet ?? ""));
      const lastDest = String(((last.target ?? {}) as Record<string, unknown>).target_coords ?? "?");
      const allDone = members.every((g) => g.status === "completed");
      const anyActive = members.some((g) => g.status === "active");
      const status = allDone ? "completed" : (anyActive ? "running" : "queued");
      const statusColor2 = allDone ? "#7cfc00" : (anyActive ? "#ffd700" : "#80a0c8");
      const cancelAll = `<button data-action-cancel-chain="${escapeHtml(cid)}" style="${btnStyle("#5a2020", "#8a4040")}" title="cancel all ${n} legs">Cancel chain</button>`;
      return `
        <div style="border-top:1px solid #2a3a52; padding:6px 0; background:rgba(60,160,200,0.04);">
          <div style="display:flex; align-items:center; gap:6px; justify-content:space-between;">
            <span>
              <span style="color:#80ffd0; font-weight:bold;">${escapeHtml(t('auto.275'))}</span>
              <span style="color:#8090a8; font-size:10px; margin-left:6px;">${n} legs · ${escapeHtml(firstSrc)} → … → ${escapeHtml(lastDest)}</span>
            </span>
            <span style="display:flex; gap:4px; align-items:center;">
              <span style="color:${statusColor2}; font-size:11px; font-weight:bold;">${status}</span>
              ${cancelAll}
            </span>
          </div>
          <div style="color:#7080a0; font-size:10px; margin-top:2px;">chain id: ${escapeHtml(cid)}</div>
        </div>`;
    };
    // Final assembly: chain groups + singletons. Chains render parent header
    // + indented children in dispatch order. Singletons render as before.
    const chainBlocks: string[] = [];
    for (const [cid, members] of chainGroups) {
      chainBlocks.push(renderChainParent(cid, members));
      members.forEach((g, idx) => {
        chainBlocks.push(renderChainChildRow(g, idx, members[idx - 1]?.type ?? null, isPaused(g)));
      });
    }
    // v0.0.481 — render top-level singletons + their nested children. depth
    // bounded by recursion of renderWithChildren; children get a left indent
    // marker so visual hierarchy is clear.
    const renderWithChildren = (g: GoalRowFromHttp, depth: number): string => {
      const indent = depth * 16;
      // v0.0.800 — operator 2026-06-05 "sub 去掉 树保持主树": parent slot
      // promote active child status (例: colonize 卡片显示 opt-crystalMine 当前
      // waiting resources L10), parent 自己的 stale reason (ogame 100001 旧
      // failure) 隐藏. tree 仍是 parent prereq_tree (已通过 v0.0.790 enrich
      // opt-* nodes). buttons 控 parent (id 不变).
      if (depth === 0) {
        // v0.0.1031 — owner 2026-06-09 "不会你又建立了第二决策树吧" — v0.0.803
        // activeChild promote 把 main goal 的 type/target 替换成 child 的 → PG 一套
        // main target / panel 渲染另一套 → 33620666 main=research astro L9 但 panel
        // 顶层显 "build Solar Plant 20" 因为 opt-solarPlant promote 上来. 严格按
        // [[single-decision-tree]]: panel 顶层永远显 PG main goal 真 target, child
        // status 用 tree node 里 contextual chip 自然表达, 不替顶层.
        return renderSingleGoalRow(g);
      }
      const body = renderSingleGoalRow(g);
      const childRows = (childrenByParent.get(g.id) ?? [])
        .map((c) => `<div style="margin-left:${indent + 16}px; border-left:2px solid #3a4a60; padding-left:6px;">${renderWithChildren(c, depth + 1)}</div>`)
        .join("");
      return body + childRows;
    };
    // v0.0.767 — operator 2026-06-04 "goals 按照坐标排序". 同 flagship
    // FlagshipPanelV2 行为对齐. Top-level singletons + chain groups 都按
    // [galaxy, system, position] 升序; 月球次于同坐标星球; coords 缺失
    // 排末尾 (放底)防止混乱.
    const storeRefForSort = (window as Window & { __ogamexStore?: { state?: { planets?: Record<string, { coords?: number[]; type?: string }> } } }).__ogamexStore;
    const goalCoordsKey = (g: GoalRowFromHttp): [number, number, number, number] => {
      const target = (g.target ?? {}) as Record<string, unknown>;
      const parseCoords = (s: string | undefined): number[] | null => {
        if (typeof s !== "string") return null;
        const m = s.match(/^(\d+):(\d+):(\d+)$/);
        return m && m[1] && m[2] && m[3] ? [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)] : null;
      };
      const srcCoordsStr = target["source_coords"] as string | undefined;
      const tgtCoordsStr = target["coords"] as string | undefined;
      const topPlanetStr = (g as { planet?: string }).planet;
      // v0.0.771 — operator 2026-06-04 evidence: g.planet 在 sidecar HTTP
      // /v1/goals 里其实是 coord 字符串 "4:299:8" 不是 planet id.
      // (PG ogame_goals 存 target.planet_id 但 sidecar listGoals 把它
      // 映射成 coord 字符串放到 top level g.planet).
      // 直接 parseCoords g.planet 而不是当 pid lookup.
      let coords: number[] | null = parseCoords(srcCoordsStr)
        ?? parseCoords(tgtCoordsStr)
        ?? parseCoords(topPlanetStr);
      let isMoon = 0;
      // pid lookup 仍保留作 ULTIMATE 兜底 (deploy/transport 等 source_planet_id 路径)
      const targetPid = (target["planet_id"] as string | undefined)
        ?? (target["source_planet"] as string | undefined)
        ?? (target["source_planet_id"] as string | undefined);
      if (!coords && typeof targetPid === "string") {
        const p = storeRefForSort?.state?.planets?.[targetPid];
        if (Array.isArray(p?.coords) && p.coords.length === 3) {
          coords = p.coords as number[];
          if (p.type === "moon") isMoon = 1;
        }
      }
      if (!coords) return [Number.MAX_SAFE_INTEGER, 0, 0, 0]; // 没坐标 → 排末尾
      return [coords[0] ?? 0, coords[1] ?? 0, coords[2] ?? 0, isMoon];
    };
    // v0.0.769 — operator 2026-06-04 "不要倒序": 维持 asc by
    // [galaxy:system:position], 月球紧跟同坐标星球; 无 coords 兜底
    // (MAX_SAFE_INTEGER) 排末尾.
    const cmpByCoords = (a: GoalRowFromHttp, b: GoalRowFromHttp): number => {
      const ka = goalCoordsKey(a); const kb = goalCoordsKey(b);
      for (let i = 0; i < 4; i++) if (ka[i]! !== kb[i]!) return ka[i]! - kb[i]!;
      return 0;
    };
    singletonsTopLevel.sort(cmpByCoords);
    // chainGroups Map 转 entries 按 chain 首成员的 coords 排序后重 set
    const sortedChainGroupEntries = [...chainGroups.entries()].sort(
      (a, b) => cmpByCoords(a[1][0]!, b[1][0]!),
    );
    chainGroups.clear();
    for (const [cid, members] of sortedChainGroupEntries) chainGroups.set(cid, members);

    const singletonRows = singletonsTopLevel.map((g) => renderWithChildren(g, 0)).join("");
    const rows = chainBlocks.join("") + singletonRows;
    // v0.0.529 — operator 2026-05-31 "把運輸任務從 goals 移到這裏 (cargo 位置)".
    // 拆 rows: 運輸系 (deploy/transport/jumpgate, 含 chain) 單獨到 cargoSection,
    // 其它 (build/research 等) 留在 goalsSection (常規任務).
    // v0.0.723 — operator 2026-06-03 "遠征還有問題" (panel 截圖: 5 個
    // 遠征 goal 跑到常規任務). expedition 类型也独立分流到 expeditionSection
    // (live fleet 列表下追加), 不再跟 build/research 混。
    const isTransportType = (t: string): boolean => t === "deploy" || t === "transport" || t === "jumpgate";
    const isExpeditionType = (t: string): boolean => t === "expedition";
    const transportChainBlocks_v529: string[] = [];
    const expeditionChainBlocks_v723: string[] = [];
    const restChainBlocks_v529: string[] = [];
    for (const [cid, members] of chainGroups) {
      const isTransport = members.some(g => isTransportType(g.type));
      const isExpChain = !isTransport && members.some(g => isExpeditionType(g.type));
      const bucket = isTransport ? transportChainBlocks_v529 : (isExpChain ? expeditionChainBlocks_v723 : restChainBlocks_v529);
      bucket.push(renderChainParent(cid, members));
      members.forEach((g, idx) => {
        bucket.push(renderChainChildRow(g, idx, members[idx - 1]?.type ?? null, isPaused(g)));
      });
    }
    const transportSingletonsHtml_v529 = singletonsTopLevel.filter(g => isTransportType(g.type)).map(g => renderWithChildren(g, 0)).join("");
    const expeditionSingletonsHtml_v723 = singletonsTopLevel.filter(g => isExpeditionType(g.type)).map(g => renderWithChildren(g, 0)).join("");
    const restSingletonsHtml_v529 = singletonsTopLevel.filter(g => !isTransportType(g.type) && !isExpeditionType(g.type)).map(g => renderWithChildren(g, 0)).join("");
    const transportRowsHtml_v529 = transportChainBlocks_v529.join("") + transportSingletonsHtml_v529;
    const expeditionRowsHtml_v723 = expeditionChainBlocks_v723.join("") + expeditionSingletonsHtml_v723;
    const restRowsHtml_v529 = restChainBlocks_v529.join("") + restSingletonsHtml_v529;
    const transportGoalCount_v529 = filtered.filter(g => isTransportType(g.type)).length;
    const expeditionGoalCount_v723 = filtered.filter(g => isExpeditionType(g.type)).length;
    const restGoalCount_v529 = filtered.length - transportGoalCount_v529 - expeditionGoalCount_v723;
    // Header is the drag handle (cursor:move). Collapse button toggles the
    // body. Close removes the panel entirely.
    // Operator 2026-05-29 "panel 名稱改成 oGame+版本號 添加按鈕更新版本":
    // title shows current runtime version, update button hidden by default,
    // shown when latestRuntimeVersion (polled from sidecar) > currentVersion.
    // Operator 2026-06-02 — title prefix shows the actual ogame server slug
    // (e.g. "s274-en") instead of generic "oGame", so when operator runs the
    // panel on multiple ogame tabs (lobby + game + alt account) each panel
    // identifies which one it's wired to.
    const currentVersion = ((typeof window !== "undefined" ? window : globalThis) as { __ogamexVersion?: string }).__ogamexVersion ?? "?";
    const serverSlug = ((): string => {
      try {
        const host = (typeof window !== "undefined" ? window.location.hostname : "") ?? "";
        const slug = host.split(".")[0] ?? "";
        // Only use as title if it looks like a real ogame server slug (sNNN-xx).
        // Lobby (lobby.ogame...) / dashboard / non-ogame pages fall back.
        return slug && /^s\d+-/i.test(slug) ? slug : "ogame";
      } catch { return "ogame"; }
    })();
    const latestVersion = ((typeof window !== "undefined" ? window : globalThis) as { __ogamexLatestVersion?: string }).__ogamexLatestVersion ?? "";
    const hasUpdate = latestVersion !== "" && latestVersion !== currentVersion && cmpSemver(latestVersion, currentVersion) > 0;
    const updateBtn = hasUpdate
      ? `<button data-action="update-runtime" style="background:#205a20; color:#fff; border:1px solid #408a40; padding:1px 6px; border-radius:3px; cursor:pointer; font-size:10px;" title="${escapeHtml(t("panel.btn.update_tooltip", { version: latestVersion }))}">${escapeHtml(t("panel.btn.update", { version: latestVersion }))}</button>`
      : "";
    // Operator 2026-06-04 "添加信号灯" — bridge transport+status dot.
    //   绿 = WS open · 黄 = HTTP fallback open · 红 = both down
    // Read from window.__ogamexBridgeStatus (set by wireBridge.publishStatus).
    // Static initial render — separate setInterval below updates 1s.
    const bs = (window as Window & { __ogamexBridgeStatus?: { transport: "ws" | "http"; status: string } }).__ogamexBridgeStatus;
    let lightColor = "#c43d3d", lightTitle = "Bridge: 离线 (both down)";
    if (bs && bs.status === "open") {
      if (bs.transport === "ws") { lightColor = "#4ac44a"; lightTitle = "Bridge: WS (real-time push)"; }
      else { lightColor = "#e0c020"; lightTitle = "Bridge: HTTP long-poll (~30s push latency)"; }
    } else if (bs && (bs.status === "connecting" || bs.status === "reconnecting")) {
      lightColor = "#e0c020"; lightTitle = `Bridge: ${bs.transport} ${bs.status}`;
    }
    const bridgeLightHtml = `<span data-bridge-light style="display:inline-block; width:10px; height:10px; border-radius:50%; background:${lightColor}; box-shadow:0 0 6px ${lightColor}; margin-right:6px; vertical-align:middle;" title="${escapeHtml(lightTitle)}"></span>`;
    // v0.0.765 — operator "暂停所有 TM 动作" global kill-switch button.
    const globalPaused = (() => {
      try { return window.localStorage.getItem("ogamex.global.paused") === "true"; }
      catch { return false; }
    })();
    // v0.0.* — operator 2026-06-04 "运行和暂停的 run 按钮搞反了": icon
    // 用动作语义 (点了会发生啥), 不是当前状态. PAUSED → ▶ (继续, 红);
    // RUN → ⏸ (暂停, 绿).
    const globalPauseBtn = `<button data-action="global-pause-toggle" style="background:${globalPaused ? "#5a2020" : "#205a20"}; color:#fff; border:1px solid ${globalPaused ? "#8a4040" : "#408a40"}; cursor:pointer; font-size:11px; padding:2px 8px; border-radius:3px; font-weight:bold;" title="${globalPaused ? "TM 已暂停 — 点击恢复" : "暂停全部 TM 动作 (build/fleet/research/...)"}">${globalPaused ? "▶ PAUSED" : "⏸ RUN"}</button>`;
    const header = `
      <div data-ogamex-drag="1" style="display:flex; align-items:center; justify-content:space-between; padding-bottom:4px; cursor:move; user-select:none;">
        <strong style="color:#e0e8f0;">${bridgeLightHtml}${escapeHtml(t("panel.title_prefix"))} ${escapeHtml(serverSlug)} v${escapeHtml(currentVersion)}</strong>
        <span style="display:flex; gap:4px; align-items:center;">
          ${globalPauseBtn}
          ${updateBtn}
          <button data-action="collapse" style="background:transparent; color:#8090a8; border:none; cursor:pointer; font-size:14px; padding:0 4px;" title="${escapeHtml(collapsed ? t("panel.btn.collapse_expand") : t("panel.btn.collapse_collapse"))}">${collapsed ? "▸" : "▾"}</button>
          <button data-action="close" style="background:transparent; color:#8090a8; border:none; cursor:pointer; font-size:14px; padding:0 4px;" title="${escapeHtml(t("panel.btn.close"))}">×</button>
        </span>
      </div>
      <div style="color:#8090a8; font-size:10px;">${escapeHtml(t("panel.counter.active", { n: filtered.length }))}${err ? ` — ${escapeHtml(err)}` : ""} · <span id="ogamex-server-time" style="color:#6080a8;">--:--:--</span></div>`;
    const empty = filtered.length === 0 && !err
      ? `<div style="color:#666; text-align:center; padding:12px;">(no active goals)</div>`
      : "";
    // Body wraps everything below the header so collapse can hide rows
    // while keeping the header visible/draggable.
    const bodyDisplay = collapsed ? "none" : "block";

    // Section helpers — collapsible per section with persistent state.
    // `extraButton` accepts arbitrary action-button HTML (already styled).
    // Convention: section-scope actions (pause daemon, stop discovery) sit
    // in the header right slot — operator can hit them without expanding.
    const sectionHeader = (name: string, label: string, count: number, accentColor: string, extraButton = ""): string => {
      const c = sectionCollapsed[name];
      const pauseable = name === "emergency" || name === "expedition";
      const paused = pauseable ? loadJSON<boolean>(`ogamex.${name}.paused`, false) : false;
      const pauseBtn = pauseable
        ? `<button data-pause-daemon="${escapeHtml(name)}" style="${paused ? btnStyle("#205a20", "#408a40") : btnStyle("#5a4a20", "#8a7a40")}" title="${paused ? "Resume daemon" : "Pause daemon"}">${paused ? "▶" : "⏸"}</button>`
        : "";
      return `<div data-section-toggle="${escapeHtml(name)}" style="display:flex; align-items:center; gap:6px; cursor:pointer; padding:4px 0; user-select:none; border-top:1px solid #2a3a52;">
        <span style="color:#8090a8; width:12px;">${c ? "▸" : "▾"}</span>
        <strong style="color:${accentColor}; font-size:11px; flex:1;">${escapeHtml(label)}</strong>
        <span style="color:#8090a8; font-size:10px;">${count}</span>
        ${pauseBtn}${extraButton}
      </div>`;
    };

    // Emergency section
    const emCollapsed = sectionCollapsed.emergency;
    const emCount = lastEmergency?.count ?? 0;
    const emColor = emCount > 0 ? "#ff6b6b" : "#7080a0";
    // Spy-triggers-save toggle (operator 2026-05-23). localStorage value of
    // "off" disables; anything else (or unset) is ON by default.
    const spySaveOn = (() => {
      try { return window.localStorage.getItem("OGAMEX_SPY_TRIGGERS_SAVE") !== "off"; }
      catch { return true; }
    })();
    const spyToggleRow = `<div style="font-size:11px; padding:4px 0; display:flex; justify-content:space-between; align-items:center; border-top:1px solid #2a2a3a;">
        <span style="color:#a0a8b8;">偵察 → 緊急起飛</span>
        <button data-spy-save-toggle="1" style="${spySaveOn ? btnStyle("#205a20", "#408a40") : btnStyle("#5a2020", "#8a4040")}">${spySaveOn ? "ON" : "OFF"}</button>
      </div>`;
    const emRows = !emCollapsed && lastEmergency
      ? (emCount === 0
          ? `<div style="color:#666; font-size:10px; padding:2px 0;">(no hostile incoming)</div>${spyToggleRow}`
          : lastEmergency.hostile.map((h) => {
              // operator 2026-06-04 "紧急任务区分是星球还是月球" — render
              // 🌑 for moon target, 🪐 for planet, so operator can tell at
              // a glance which body the threat is heading to.
              const dstIcon = h.to_type === "moon" ? "🌑" : "🪐";
              return `
              <div style="font-size:11px; padding:3px 0; border-top:1px solid #2a2a3a;">
                <div style="display:flex; gap:6px; justify-content:space-between;">
                  <span style="color:#ff6b6b; font-weight:bold;">${escapeHtml(h.type)}</span>
                  <span style="color:#ff9b9b;">${fmtEta(h.eta_in_seconds)}</span>
                </div>
                <div style="color:#a0a8b8; font-size:10px;">${escapeHtml(h.from ?? "?")} → ${dstIcon} ${escapeHtml(h.to ?? "?")} · ships=${escapeHtml(String(h.ships_count))}</div>
              </div>`;
            }).join("") + spyToggleRow)
      : "";
    // Operator 2026-05-29: ⚙️ button opens emergency-specific settings modal.
    // Per "每個功能用自己的設定頁面" — section header gets a per-feature
    // settings button instead of a global "AI 設定" tab.
    const emSettingsBtn = t("auto.098");
    const emergencySection = `${sectionHeader("emergency", t("section.emergency"), emCount, emColor, emSettingsBtn)}<div style="display:${emCollapsed ? "none" : "block"};">${emRows}</div>`;

    // Expedition section
    const exCollapsed = sectionCollapsed.expedition;
    const ex = lastExpedition;
    const exLabel = ex
      ? (ex.state_ready === false
          ? t("section.expedition.loading")
          : t("section.expedition.active", { used: ex.used, max: ex.max, astro: ex.astrophysics_level }))
      : t("section.expedition.idle");
    const exRows = !exCollapsed && ex
      ? (ex.active.length === 0
          ? `<div style="color:#666; font-size:10px; padding:2px 0;">${escapeHtml(t("section.expedition.no_active"))}</div>`
          : ex.active.map((f) => `
              <div style="font-size:11px; padding:3px 0; border-top:1px solid #2a2a3a;">
                <div style="display:flex; gap:6px; justify-content:space-between;">
                  <span style="color:#7cfc00;">${escapeHtml(f.fleet_id)}</span>
                  <span style="color:#a0a8b8;">${fmtEta(f.eta_in_seconds)}</span>
                </div>
                <div style="color:#8090a8; font-size:10px;">${escapeHtml(f.origin ?? "?")} → ${escapeHtml(f.dest ?? "?")}</div>
              </div>`).join(""))
      : "";
    // M2 — expedition section ⚙ button → openExpeditionSettings modal.
    const exSettingsBtn = t("auto.099");
    // v0.0.723 — operator 2026-06-03: expedition goals rendered alongside the
    // live fleet list (was混入 常規任務). Header count = live fleets +
    // queued goals so panel reads "N active + M queued" at a glance.
    const exTotalCount = (ex?.active.length ?? 0) + expeditionGoalCount_v723;
    const expeditionSection = `${sectionHeader("expedition", exLabel, exTotalCount, "#8a8aff", exSettingsBtn)}<div style="display:${exCollapsed ? "none" : "block"};">${exRows}${expeditionRowsHtml_v723}</div>`;

    // Goals section — wraps existing goal rows with a collapsible header.
    const goalsCollapsed = sectionCollapsed.goals;
    const goalsBody = !goalsCollapsed ? `${empty}${rows}` : "";
    // M4 — Goals section ⚙ → openGoalsSettings modal (create new goal form).
    const goalsSettingsBtn = t("auto.100");
    // v0.0.460: awaiting count badge — operator sees at a glance how many
    // goals are quiet because they're waiting for empire_poll / operator_retry.
    const awaitingCount = filtered.filter((g) => g.status === "blocked" && Array.isArray(g.awaiting_events) && g.awaiting_events.length > 0).length;
    const awaitingBadge = awaitingCount > 0
      ? `<span style="color:#80c0ff; font-size:10px; background:#1a3a5a; padding:1px 6px; border-radius:8px; margin-left:6px;" title="goals quietly waiting for an event before next dispatch attempt">⏸ ${awaitingCount} awaiting</span>`
      : "";
    // v0.0.529 — goalsSection 只裝非運輸 goals (運輸移到 cargoSection)
    const goalsBody_v529 = !goalsCollapsed ? `${empty}${restRowsHtml_v529}` : "";
    const goalsSection = `${sectionHeader("goals", t("section.goals"), restGoalCount_v529, "#e0e8f0", awaitingBadge + goalsSettingsBtn)}<div style="display:${goalsCollapsed ? "none" : "block"};">${goalsBody_v529}</div>`;

    // Species Discovery section — operator's new task type (Galaxy view DNA).
    const discCollapsed = sectionCollapsed.discovery ?? false;
    // Active discovery goal (if any).
    const activeDisc = goals.find((g) => (g as { type?: string }).type === "species_discovery" && !["completed", "cancelled"].includes(g.status));
    // Build planet dropdown sorted by coords (G:S:P ascending). Read from
    // current state.planets via window.__ogamexStore.
    const planetEntries: Array<{ id: string; coords: number[]; name: string }> = [];
    try {
      const st = (window as Window & { __ogamexStore?: { state: { planets?: Record<string, { coords?: number[]; name?: string }> } } }).__ogamexStore;
      const planets = st?.state?.planets ?? {};
      for (const [pid, p] of Object.entries(planets)) {
        if (Array.isArray(p.coords) && p.coords.length === 3) {
          planetEntries.push({ id: pid, coords: p.coords as number[], name: p.name ?? "?" });
        }
      }
      planetEntries.sort((a, b) =>
        a.coords[0]! - b.coords[0]! || a.coords[1]! - b.coords[1]! || a.coords[2]! - b.coords[2]!
      );
    } catch { /* no store yet */ }
    const planetOpts = planetEntries.map((p) =>
      `<option value="${p.id}" data-galaxy="${p.coords[0]}" data-system="${p.coords[1]}">[${p.coords.join(":")}] ${p.name}</option>`
    ).join("");
    // Resolve activeDisc target → display strings + a header Stop button.
    // Operator 2026-05-23: "發現的 stop 按鈕放上一層 位置類似於遠征" —
    // section-scope actions live in the header right slot, same as the
    // pause-daemon button in Expedition / Emergency headers. Keeps the
    // body row purely informational (coords + progress).
    let discHeaderBtn = "";
    const discBody = activeDisc
      ? (() => {
          const tgt = ((activeDisc as { target?: Record<string, unknown> }).target ?? {}) as { galaxy?: number; base_system?: number; range?: number; completed?: string[]; source_planet?: string };
          const done = Array.isArray(tgt.completed) ? tgt.completed.length : 0;
          const total = ((tgt.range ?? 10) * 2 + 1) * 15;
          const srcPlanet = tgt.source_planet ? planetEntries.find((p) => p.id === tgt.source_planet) : undefined;
          const srcCoords = srcPlanet ? `[${srcPlanet.coords.join(":")}]` : "[?:?:?]";
          discHeaderBtn = `<button data-action="discovery-stop" data-goal-id="${escapeHtml((activeDisc as { id: string }).id)}" style="${btnStyle("#5a2020", "#8a4040")}" title="Stop discovery">Stop</button>`;
          return `
<div style="padding:6px 10px; color:#c0d0e0; font-size:12px;">
  ${srcCoords} ±${tgt.range} ${done}/${total}
</div>`;
        })()
      : `
<div style="padding:6px 10px; color:#c0d0e0; font-size:12px;">
  Start from:
  <select data-action="discovery-planet" style="background:#1a2330; color:#c0d0e0; border:1px solid #354050;">${planetOpts}</select>
  range: <input data-action="discovery-range" type="number" min="1" max="20" value="10" style="width:50px; background:#1a2330; color:#c0d0e0; border:1px solid #354050;">
  <button data-action="discovery-start" style="margin-left:10px; ${btnStyle("#205a20", "#408a40")}">Start Discovery</button>
</div>`;
    // M3 — section header ⚙ → openDiscoverySettings modal. Keeps existing
    // Stop/inline UI intact for backward compat; modal adds rich status +
    // structured Start form.
    const discSettingsBtn = t("auto.101");
    const discSection = `${sectionHeader("discovery", t("section.discovery"), activeDisc ? 1 : 0, "#c080ff", `${discHeaderBtn}${discSettingsBtn}`)}<div style="display:${discCollapsed ? "none" : "block"};">${discBody}</div>`;

    // Jumpgate cooldown per moon — operator 2026-05-26:
    //   "在月球上顯示，跳躍門冷卻時間" + "ready 的不用顯示，只顯示倒計時的，
    //    時間加上秒 mm:ss"
    // Lazy computation: live remaining = max(0, snapshot - (now - harvestedAt)).
    // 1-second ticker (#jg-cd-N spans) updates display without re-rendering whole panel.
    let moonsSection = "";
    try {
      const st = (window as Window & { __ogamexStore?: { state: { planets?: Record<string, { id?: string; type?: string; coords?: number[]; buildings?: Record<string, number | undefined>; jumpgate_cooldown_sec?: number | null; jumpgate_harvested_at?: number | null; jumpgate_pair_with?: string | null }> } } }).__ogamexStore;
      const planets = st?.state?.planets ?? {};
      const now = Date.now();
      // v0.0.514 — operator 2026-05-31 "應該有 4 個月球倒計時, 只顯示了 2 個".
      // 實證: 4 月球 pair_with 被 sniffer 抓到, 但只 3 cd_sec 被 overlay 拉取 (cp race).
      // Fallback: 用 localStorage OGAMEX_JUMPGATE_LOG 兜底, log 裏 ts 30min 內
      // 的 src moon 即使 cd_sec=null 也按 1800-elapsed 估算顯示。
      // (JG L1 cooldown ~30min, L2 24min, L3 20min...; 用 1800 L1 預設猜測)
      const jgLog = (() => {
        try {
          return JSON.parse(window.localStorage.getItem("OGAMEX_JUMPGATE_LOG") || "[]") as Array<{ ts: number; src: string; tgt: string }>;
        } catch { return [] as Array<{ ts: number; src: string; tgt: string }>; }
      })();
      const jgLogBySrc = new Map<string, { ts: number; tgt: string }>();
      for (const e of jgLog) {
        const cur = jgLogBySrc.get(e.src);
        if (!cur || e.ts > cur.ts) jgLogBySrc.set(e.src, { ts: e.ts, tgt: e.tgt });
      }
      // v0.0.513 — operator 2026-05-31 "顯示的月球不全". 改成顯示**所有有 JG 建築**的月球
      // (建造了 jumpgate L≥1 都列出), 無冷卻的顯示 "ready" 綠色, 有冷卻的顯示 mm:ss 黃。
      // 排序按 G:S:P, 2 列布局不變。
      const allJgMoons = Object.entries(planets)
        .filter(([_id, p]) => {
          if (p.type !== "moon") return false;
          const jgLv = (p.buildings as Record<string, number | undefined> | undefined)?.["jumpgate"] ?? 0;
          return jgLv >= 1;
        })
        .map(([id, p]) => ({
          id, p,
          coords: p.coords ?? [0, 0, 0],
        }))
        // 按 G:S:P 升序
        .sort((a, b) => {
          const ac = a.coords, bc = b.coords;
          if ((ac[0] ?? 0) !== (bc[0] ?? 0)) return (ac[0] ?? 0) - (bc[0] ?? 0);
          if ((ac[1] ?? 0) !== (bc[1] ?? 0)) return (ac[1] ?? 0) - (bc[1] ?? 0);
          return (ac[2] ?? 0) - (bc[2] ?? 0);
        });
      // v0.0.517 — operator 2026-05-31 "不要顯示 ready". 只渲染有真 cooldown
      // 的月球。 cd_sec 沒值但 log 30min 內有記錄的, 按 1800 fallback 顯示。
      const FALLBACK_JG_CD_SEC = 1800; // JG L1 預設 30 min; 真值 hydrate 後覆蓋
      const cells: string[] = [];
      for (const { id, p } of allJgMoons) {
        let cd = p.jumpgate_cooldown_sec ?? 0;
        let at = p.jumpgate_harvested_at ?? now;
        // Fallback: 沒 cd_sec 但 log 30min 內有記錄 → 按 (1800 - elapsed) 估算
        if ((!p.jumpgate_cooldown_sec) && jgLogBySrc.has(id)) {
          const logEntry = jgLogBySrc.get(id)!;
          const elapsedFromLog = Math.floor((now - logEntry.ts) / 1000);
          if (elapsedFromLog < FALLBACK_JG_CD_SEC) {
            cd = FALLBACK_JG_CD_SEC;
            at = logEntry.ts;
          }
        }
        const elapsed = Math.floor((now - at) / 1000);
        const remain = Math.max(0, cd - elapsed);
        if (remain <= 0) continue; // ready 不顯示
        const mm = Math.floor(remain / 60);
        const ss = remain % 60;
        const coordsThis = (p.coords ?? []).join(":");
        cells.push(`<div style="flex:0 0 50%; padding:2px 4px; box-sizing:border-box; color:#c0d0e0; font-size:11px;">🌙 [${coordsThis}]/<span class="jg-cd" data-snap="${cd}" data-at="${at}" style="color:#bdb76b;">${mm}:${ss.toString().padStart(2, "0")}</span></div>`);
      }
      const pairRows: string[] = cells.length > 0
        ? [`<div style="display:flex; flex-wrap:wrap;">${cells.join("")}</div>`]
        : [];
      if (cells.length > 0) {
        // v0.0.513 — section header 計數顯示 monn 總數 (有 JG 的), 之前是
        // pair-row 數會被誤以爲"很少"。
        // v0.0.528 — operator 2026-05-31 "Moons/JumpGate 無法折疊".
        // 之前 body 寫死 display:block (源於 v0.0.??? "force expand" hack),
        // 現在尊重 sectionCollapsed.moons 狀態, 跟其他 section 一致。
        const moonsBodyDisp = sectionCollapsed.moons ? "none" : "block";
        moonsSection = `${sectionHeader("moons", t("section.moons"), cells.length, "#80c0ff", "")}<div style="display:${moonsBodyDisp};">${pairRows.join("")}</div>`;
      }
      console.info(`[panel/moons] render allJgMoons=${allJgMoons.length} cells=${cells.length}`);
    } catch (e) { console.warn("[panel/moons] render failed:", e); }

    // Cargo calculator section — operator 2026-05-26:
    //   "1 選擇星球 2 選擇運輸艦類型 LC/SC 3 checkbox 列出星球三種資源
    //    自動算需要的戰艦數量 點選復制到剪貼板"
    let cargoSection = "";
    try {
      const st = (window as Window & { __ogamexStore?: { state: { planets?: Record<string, { id?: string; coords?: number[]; name?: string; resources?: { m?: number; c?: number; d?: number }; type?: string }>; server?: { ship_cargo_capacity?: Record<string, number> } } } }).__ogamexStore;
      const planets = Object.values(st?.state?.planets ?? {})
        // Operator 2026-05-26: "刪除裏面的月球，只顯示星球" — Cargo Calc 拉資源
        // 來源限定 planets (月球通常無資源生產), 簡化 dropdown 選擇.
        .filter((p) => Array.isArray(p.coords) && p.coords.length === 3 && p.type === "planet")
        .sort((a, b) => (a.coords![0]! - b.coords![0]!) || (a.coords![1]! - b.coords![1]!) || (a.coords![2]! - b.coords![2]!));
      // Auto-follow ogame's active planet (meta) — operator 2026-05-26:
      // "切換星球，資源沒有刷新". When autoFollow=true, cargoState.planetId
      // tracks the currently-visible planet so resources update immediately
      // as operator clicks between planets in ogame's sidebar.
      const ogameCurrentPid = doc.querySelector<HTMLMetaElement>('meta[name="ogame-planet-id"]')?.content ?? "";
      if (cargoState.autoFollow && ogameCurrentPid && planets.find((p) => p.id === ogameCurrentPid)) {
        cargoState.planetId = ogameCurrentPid;
      }
      const selectedId = cargoState.planetId && planets.find((p) => p.id === cargoState.planetId) ? cargoState.planetId : (planets[0]?.id ?? "");
      cargoState.planetId = selectedId;
      const planetOptsCargo = planets.map((p) =>
        // 只顯示坐標 (operator 2026-05-26): planets only, 不含 moon, 不帶後綴.
        `<option value="${escapeHtml(p.id ?? "")}" ${p.id === selectedId ? "selected" : ""}>[${p.coords!.join(":")}]</option>`
      ).join("");
      const selected = planets.find((p) => p.id === selectedId);
      const m = selected?.resources?.m ?? 0;
      const c = selected?.resources?.c ?? 0;
      const d = selected?.resources?.d ?? 0;
      const total = (cargoState.use.m ? m : 0) + (cargoState.use.c ? c : 0) + (cargoState.use.d ? d : 0);
      const cap = (st?.state?.server?.ship_cargo_capacity ?? {})[cargoState.ship]
        ?? (cargoState.ship === "smallCargo" ? 5000 : 25000);
      const shipsNeeded = total > 0 && cap > 0 ? Math.ceil(total / cap) : 0;
      const lbl = (v: number): string => v.toLocaleString();
      const cargoCollapsed = sectionCollapsed.cargo;
      const cargoSettingsBtn = t("auto.102");
      // v0.0.529 — operator 2026-05-31 "這部分不要了, 把運輸任務從 goals 移到這裏".
      // 舊的 Cargo Calc UI (Planet 選擇 / SC|LC / M C D / Need / Deploy→Moon)
      // 全刪, cargo section header 改成 "🚚 運輸任務" + 裝 transportRowsHtml.
      // ⚙ 按鈕保留 (跳到 transport modal 創建新運輸任務).
      // 靜默引用以保留 lbl 等閉包變量, 不致 TS 誤報 unused.
      void planetOptsCargo; void m; void c; void d; void total; void cap; void shipsNeeded; void lbl; void selected;
      cargoSection = `${sectionHeader("cargo", t("section.cargo"), transportGoalCount_v529, "#80ffd0", cargoSettingsBtn)}<div style="display:${cargoCollapsed ? "none" : "block"};">${transportRowsHtml_v529}</div>`;
    } catch { /* no store yet */ }

    const body = `<div data-ogamex-body="1" style="display:${bodyDisplay};">${emergencySection}${expeditionSection}${discSection}${moonsSection}${cargoSection}${goalsSection}</div>`;
    panel.innerHTML = header + body;
    // Operator 2026-06-04 "添加信号灯" — lightweight 1s tick to recolor the
    // bridge status dot WITHOUT a full panel re-render. Only mutates the
    // colored dot element's inline style; idempotent re-attach guarded
    // by a panel-scoped property to avoid duplicate timers across renders.
    const panelExt = panel as HTMLElement & { __ogamexBridgeLightTimer?: { stop: () => void } };
    if (panelExt.__ogamexBridgeLightTimer !== undefined) {
      panelExt.__ogamexBridgeLightTimer.stop();
    }
    // v0.0.990 — owner 2026-06-09 "装载TM以后很卡": 500ms 闪烁 JS 改 CSS @keyframes,
    // color/title 更新降到 2000ms (4× CPU 降). 红灯闪烁靠 CSS animation 跑, JS 只
    // 负责切 class. 全局 style 一次注入, 渲染漏 (panel.innerHTML wipe) 时 CSS rule 留存.
    if (!document.getElementById("ogamex-bridge-light-style")) {
      const styleEl = document.createElement("style");
      styleEl.id = "ogamex-bridge-light-style";
      styleEl.textContent = "@keyframes ogamex-red-blink{0%,100%{opacity:1}50%{opacity:.25}}" +
        "[data-bridge-light].ogx-red{animation:ogamex-red-blink 1s ease-in-out infinite}";
      document.head.appendChild(styleEl);
    }
    panelExt.__ogamexBridgeLightTimer = setVisibleInterval(() => {
      const dot = panel.querySelector<HTMLElement>("[data-bridge-light]");
      if (!dot) return;
      const bs2 = (window as Window & { __ogamexBridgeStatus?: { transport: "ws" | "http"; status: string } }).__ogamexBridgeStatus;
      let c = "#c43d3d", title = "Bridge: 离线 (both down)";
      if (bs2 && bs2.status === "open") {
        if (bs2.transport === "ws") { c = "#4ac44a"; title = "Bridge: WS (real-time push)"; }
        else { c = "#e0c020"; title = "Bridge: HTTP long-poll (~30s push latency)"; }
      } else if (bs2 && (bs2.status === "connecting" || bs2.status === "reconnecting")) {
        c = "#e0c020"; title = `Bridge: ${bs2.transport} ${bs2.status}`;
      }
      const isRed = c === "#c43d3d";
      dot.style.background = c;
      dot.style.boxShadow = isRed ? `0 0 10px ${c}, 0 0 16px ${c}` : `0 0 6px ${c}`;
      dot.classList.toggle("ogx-red", isRed);
      dot.title = title;
    }, 2000);
    // Wire discovery Start button.
    const startBtn = panel.querySelector<HTMLElement>("[data-action=\"discovery-start\"]");
    if (startBtn) {
      startBtn.addEventListener("click", async () => {
        const sel = panel!.querySelector<HTMLSelectElement>("[data-action=\"discovery-planet\"]");
        const rng = panel!.querySelector<HTMLInputElement>("[data-action=\"discovery-range\"]");
        if (!sel?.value) return;
        const opt = sel.options[sel.selectedIndex];
        const galaxy = parseInt(opt?.getAttribute("data-galaxy") ?? "0", 10);
        const system = parseInt(opt?.getAttribute("data-system") ?? "0", 10);
        const range = parseInt(rng?.value ?? "10", 10);
        startBtn.textContent = "Creating...";
        try {
          const r = await fetchFn(`${baseUrl}/ogamex/v1/discovery/create`, {
            method: "POST", headers: authHeadersGlobal({ "Content-Type": "application/json" }),
            body: JSON.stringify({ source_planet: sel.value, galaxy, base_system: system, range }),
          });
          const j = await r.json() as { ok?: boolean; goal_id?: string; reason?: string };
          if (!j.ok) {
            console.warn("[panel/discovery] create failed:", j.reason);
            startBtn.textContent = `Failed: ${j.reason}`;
            setTimeout(() => { startBtn.textContent = "Start Discovery"; }, 3000);
            return;
          }
          await refresh();
        } catch (e) {
          console.warn("[panel/discovery] fetch error:", e);
          startBtn.textContent = "Network error";
        }
      });
    }
    // Wire discovery Stop = cancel the active goal. Lives in the section
    // header now — stopPropagation prevents click bubbling to the
    // section-toggle collapse handler.
    const stopBtn = panel.querySelector<HTMLElement>("[data-action=\"discovery-stop\"]");
    if (stopBtn) {
      stopBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const gid = stopBtn.getAttribute("data-goal-id") ?? "";
        if (!gid) return;
        await fetchFn(`${baseUrl}/ogamex/v1/goals/${encodeURIComponent(gid)}/cancel`, { method: "POST", headers: authHeadersGlobal() });
        await refresh();
      });
    }
    // Wire per-feature settings ⚙️ buttons (operator 2026-05-29).
    // Each section header carries `data-settings="<feature>"`; click opens
    // the matching modal. M1 = emergency only; M2/M3/M4 to follow.
    for (const btn of panel.querySelectorAll<HTMLElement>('[data-settings]')) {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const feature = btn.getAttribute("data-settings") ?? "";
        if (feature === "emergency") openEmergencySettings(doc);
        else if (feature === "expedition") openExpeditionSettings(doc, baseUrl, fetchFn);
        else if (feature === "discovery") openDiscoverySettings(doc, baseUrl, fetchFn);
        else if (feature === "goals") openGoalsSettings(doc, baseUrl, fetchFn);
        else if (feature === "transport") openTransportSettings(doc, baseUrl, fetchFn);
      });
    }
    // Wire spy-triggers-save toggle (emergency section).
    for (const btn of panel.querySelectorAll<HTMLElement>("[data-spy-save-toggle]")) {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        let cur = "on";
        try { cur = window.localStorage.getItem("OGAMEX_SPY_TRIGGERS_SAVE") ?? "on"; } catch { /* */ }
        const next = cur === "off" ? "on" : "off";
        try { window.localStorage.setItem("OGAMEX_SPY_TRIGGERS_SAVE", next); } catch { /* */ }
        (window as Window & { __ogamexSpyTriggersSave?: boolean }).__ogamexSpyTriggersSave = next === "on";
        if (lastGoals) render(lastGoals);
      });
    }
    // Wire cargo calculator handlers.
    const cargoRerender = (): void => { if (lastGoals) render(lastGoals); };
    const cargoSel = panel.querySelector<HTMLSelectElement>('[data-action="cargo-planet"]');
    if (cargoSel) cargoSel.addEventListener("change", () => {
      cargoState.planetId = cargoSel.value;
      cargoState.autoFollow = false;  // manual override → stop auto-follow
      saveJSON("ogamex.panel.cargo.planet", cargoState.planetId);
      saveJSON("ogamex.panel.cargo.autoFollow", false);
      cargoRerender();
    });
    const autoBtn = panel.querySelector<HTMLElement>('[data-action="cargo-auto"]');
    if (autoBtn) autoBtn.addEventListener("click", () => {
      cargoState.autoFollow = !cargoState.autoFollow;
      saveJSON("ogamex.panel.cargo.autoFollow", cargoState.autoFollow);
      cargoRerender();
    });
    panel.querySelectorAll<HTMLInputElement>('[data-action="cargo-ship"]').forEach((r) => {
      r.addEventListener("change", () => {
        if (r.checked) {
          cargoState.ship = r.value as "smallCargo" | "largeCargo";
          saveJSON("ogamex.panel.cargo.ship", cargoState.ship);
          cargoRerender();
        }
      });
    });
    for (const key of ["m", "c", "d"] as const) {
      const cb = panel.querySelector<HTMLInputElement>(`[data-action="cargo-${key}"]`);
      if (cb) cb.addEventListener("change", () => {
        cargoState.use[key] = cb.checked;
        saveJSON("ogamex.panel.cargo.use", cargoState.use);
        cargoRerender();
      });
    }
    const fillBtn = panel.querySelector<HTMLElement>('[data-action="cargo-fill"]');
    if (fillBtn) fillBtn.addEventListener("click", async () => {
      const needSpan = panel!.querySelector<HTMLElement>("[data-cargo-need]");
      const n = parseInt((needSpan?.textContent ?? "").replace(/[^0-9]/g, ""), 10) || 0;
      const ok = panel!.querySelector<HTMLElement>("[data-cargo-copied]");
      if (n <= 0) {
        if (ok) { ok.textContent = "✗ N=0"; ok.style.color = "#ff8080"; ok.style.display = "inline"; setTimeout(() => { ok.style.display = "none"; ok.style.color = "#7cfc00"; }, 1500); }
        return;
      }
      // Operator 2026-05-26: "改行爲爲部署這些船到本星球的月球". 直接 ajax
      // sendFleet mission=4 deploy from current planet → same-coord moon.
      // Helper exposed by wire_runtime.ts __ogamexDeployToMoon.
      const deployFn = (window as Window & {
        __ogamexDeployToMoon?: (ship: string, n: number) => Promise<{ ok: boolean; message: string }>;
      }).__ogamexDeployToMoon;
      if (typeof deployFn !== "function") {
        if (ok) { ok.textContent = "✗ deploy helper missing"; ok.style.color = "#ff8080"; ok.style.display = "inline"; }
        return;
      }
      if (ok) { ok.textContent = "⏳ deploying…"; ok.style.color = "#bdb76b"; ok.style.display = "inline"; }
      const res = await deployFn(cargoState.ship, n);
      if (ok) {
        ok.textContent = res.ok ? `✓ deployed (${res.message})` : `✗ ${res.message.slice(0, 60)}`;
        ok.style.color = res.ok ? "#7cfc00" : "#ff8080";
        setTimeout(() => { ok.style.display = "none"; ok.style.color = "#7cfc00"; }, res.ok ? 3000 : 6000);
      }
    });

    // Wire section collapse toggles.
    for (const el of panel.querySelectorAll<HTMLElement>("[data-section-toggle]")) {
      el.addEventListener("click", (e) => {
        // Don't toggle collapse if click landed on an action button
        // hosted inside the header (pause-daemon, discovery-stop, etc).
        const tVal = e.target as HTMLElement;
        if (tVal.closest("[data-pause-daemon]") || tVal.closest("[data-action]")) return;
        const name = el.getAttribute("data-section-toggle");
        if (!name) return;
        setSectionCollapsed(name, !sectionCollapsed[name]);
        if (lastGoals) render(lastGoals);
      });
    }
    // Wire pause/resume daemon toggles (emergency / expedition sections).
    for (const btn of panel.querySelectorAll<HTMLElement>("[data-pause-daemon]")) {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const daemon = btn.getAttribute("data-pause-daemon");
        if (!daemon) return;
        const wasPaused = loadJSON<boolean>(`ogamex.${daemon}.paused`, false);
        const next = !wasPaused;
        const action = next ? "pause" : "resume";
        // Optimistic UI: flip immediately
        saveJSON(`ogamex.${daemon}.paused`, next);
        btn.textContent = next ? "▶" : "⏸";
        btn.title = next ? "Resume daemon" : "Pause daemon";
        // Operator 2026-05-26: emergency (FS) 是 frontend FSM, sidecar 沒
        // /ogamex/v1/emergency/pause 端點 → 404. localStorage toggle 即可,
        // orchestrator handleThreat 讀這個 flag 決定是否 skip.
        if (daemon === "emergency") {
          console.info(`[panel] emergency ${action} — localStorage flag set, orchestrator will honor`);
          return;
        }
        try {
          // Operator 2026-05-26: "遠征 stop 按鈕無效" — sidecar pause/resume
          // 端點在 auth-required block, panel POST 沒帶 bearer → 401 拒絕.
          // Fix: 帶 bearer token (same as bridge). 同時 sidecar 那邊 endpoint
          // 也移到 public block (雙保險).
          const headers: Record<string, string> = { "Content-Type": "application/json" };
          // Try multi-source token (operator's bridge token, same one bridge uses):
          // 1. opts.bridgeToken (injected by main.ts via readConfig — GM_getValue+localStorage)
          // 2. localStorage fallback (sandbox may have isolated localStorage)
          let tok: string | null = opts.bridgeToken ?? null;
          if (!tok) {
            try { tok = (typeof window !== "undefined" ? window.localStorage.getItem("OGAMEX_BRIDGE_TOKEN") : null); }
            catch { /* */ }
          }
          if (tok) headers["Authorization"] = `Bearer ${tok}`;
          else console.warn(`[panel] pause-daemon: no bridge token available — sidecar may reject 401`);
          const res = await fetchFn(`${baseUrl}/ogamex/v1/${daemon}/${action}`, { method: "POST", headers });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
        } catch (err) {
          btn.textContent = wasPaused ? "▶" : "⏸";
          btn.title = "ERR: " + (err as Error).message;
          saveJSON(`ogamex.${daemon}.paused`, wasPaused);
          console.warn(`[panel] pause/${action} ${daemon} failed:`, err);
        }
      });
    }
    // Wire up action buttons + close. We use one attribute per action so the
    // selector is unambiguous (avoids collisions between data-action="close"
    // and a goal-id-bearing button).
    const wireAction = (attr: string, action: "cancel" | "pause" | "resume" | "set-main" | "unset-main"): void => {
      for (const btn of panel!.querySelectorAll<HTMLElement>(`[${attr}]`)) {
        btn.addEventListener("click", () => {
          const id = btn.getAttribute(attr);
          if (!id) return;
          // Optimistic UI: for cancel/pause, immediately hide/dim the row so
          // operator gets instant feedback. POST runs in background; refresh
          // reconciles. For resume/set-main/unset-main, also fire-and-forget
          // with a quick refresh.
          if (action === "cancel" && lastGoals) {
            lastGoals = lastGoals.filter((g) => g.id !== id);
            render(lastGoals);
          } else if (action === "pause" && lastGoals) {
            lastGoals = lastGoals.map((g) => g.id === id ? { ...g, status: "blocked", reason: "PAUSED (pending)" } : g);
            render(lastGoals);
          } else {
            btn.textContent = "...";
          }
          // Background POST — don't block UI.
          void actGoal(id, action).then(() => refresh()).catch((e: Error) => {
            // Restore on failure
            btn.textContent = (btn.textContent ?? "") + " ERR";
            btn.title = e.message;
            void refresh();
          });
        });
      }
    };
    wireAction("data-action-cancel", "cancel");
    wireAction("data-action-pause", "pause");
    wireAction("data-action-resume", "resume");
    wireAction("data-action-set-main", "set-main");
    wireAction("data-action-unset-main", "unset-main");
    // v0.0.487 accordion — click goal row header toggles expansion (accordion:
    // only one open at a time). Buttons inside the header carry
    // data-stop-toggle to prevent bubbling so Pause/Cancel don't trigger
    // toggle. Skip if click originated on an input/button.
    for (const el of panel.querySelectorAll<HTMLElement>("[data-action-toggle-expand]")) {
      el.addEventListener("click", (ev) => {
        const tgt = ev.target as HTMLElement;
        if (tgt.closest("[data-stop-toggle]") || tgt.closest("button") || tgt.closest("input") || tgt.closest("select")) return;
        const gid = el.getAttribute("data-action-toggle-expand");
        if (!gid) return;
        setExpandedGoalId(expandedGoalId === gid ? null : gid);
        if (lastGoals) render(lastGoals);
      });
    }
    // v0.0.449: shortage-chip → 運輸 button. Opens transport modal with
    // target+cargo prefilled. targetCoord is resolved to planet id via
    // store lookup (goal.planet is the coord string post-idToCoords).
    for (const btn of panel.querySelectorAll<HTMLElement>("[data-action-fill-shortage]")) {
      btn.addEventListener("click", () => {
        const targetCoord = btn.getAttribute("data-fill-target") ?? "";
        const targetBuilding = btn.getAttribute("data-fill-building") ?? "";
        const m = parseInt(btn.getAttribute("data-fill-m") ?? "0", 10);
        const c = parseInt(btn.getAttribute("data-fill-c") ?? "0", 10);
        const d = parseInt(btn.getAttribute("data-fill-d") ?? "0", 10);
        const store = (window as Window & { __ogamexStore?: { state?: { planets?: Record<string, { id: string; type?: string; coords?: number[] }> } } }).__ogamexStore;
        const planets = Object.values(store?.state?.planets ?? {});
        const matches = planets.filter((p): p is { id: string; type?: string; coords?: number[] } => !!p && Array.isArray(p.coords) && p.coords.join(":") === targetCoord);
        // v0.0.454: moon-only buildings → prefer the moon at this coord so
        // the "→ 運輸" shortcut on a moon goal (lunarBase / jumpgate /
        // sensorPhalanx shortage) targets the moon, not the same-coord planet.
        const MOON_ONLY = new Set(["lunarBase","sensorPhalanx","jumpgate","moonBase","moon_base","lunar_base","sensor_phalanx","jump_gate"]);
        const wantMoon = MOON_ONLY.has(targetBuilding);
        const targetBody = (wantMoon ? matches.find((p) => p?.type === "moon") : matches.find((p) => p?.type === "planet"))
          ?? matches.find((p) => p?.type === "planet")
          ?? matches[0];
        openTransportSettings(doc, baseUrl, fetchFn, {
          ...(targetBody?.id ? { targetPlanetId: targetBody.id } : {}),
          cargo: { m, c, d },
        });
      });
    }
    // Prereq tree toggles — flip per-node collapse state + re-render the
    // current goals snapshot (no refetch).
    for (const el of panel.querySelectorAll<HTMLElement>("[data-tree-toggle]")) {
      el.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const key = el.getAttribute("data-tree-toggle");
        if (!key) return;
        // v0.0.526 — toggle in treeExpanded (預設折疊語義)
        if (treeExpanded.has(key)) treeExpanded.delete(key);
        else treeExpanded.add(key);
        if (lastGoals) render(lastGoals);
      });
    }
    const closeBtn = panel.querySelector<HTMLElement>("[data-action=\"close\"]");
    closeBtn?.addEventListener("click", () => stop());

    // v0.0.937 — owner 2026-06-07 "取消TM 标题栏的 折叠和审计，删除tm里对应的代码":
    // audit (📋) + collapse (▸/▾) 按钮 + handler 都删, openAuditModal 死代码同步删.

    // v0.0.765 — operator "暂停所有 TM 动作" global pause toggle.
    const globalPauseBtnEl = panel.querySelector<HTMLElement>("[data-action=\"global-pause-toggle\"]");
    globalPauseBtnEl?.addEventListener("click", (e) => {
      e.stopPropagation();
      const cur = window.localStorage.getItem("ogamex.global.paused") === "true";
      const next = !cur;
      const v = next ? "true" : "false";
      try { window.localStorage.setItem("ogamex.global.paused", v); } catch { /* */ }
      // sync to PG so flagship/sidecar also see change
      try {
        const baseUrl = (window as Window & { __OGAMEX_BRIDGE_URL_RUNTIME?: string }).__OGAMEX_BRIDGE_URL_RUNTIME
          ?? "https://ogame.anyfq.com";
        const tok = window.localStorage.getItem("OGAMEX_BRIDGE_TOKEN") ?? "";
        if (tok) {
          void fetchFn(`${baseUrl}/ogamex/v1/section-settings`, {
            method: "POST",
            headers: { "content-type": "application/json", "authorization": `Bearer ${tok}` },
            body: JSON.stringify({ "ogamex.global.paused": v }),
          }).catch(() => { /* */ });
        }
      } catch { /* */ }
      // re-render header
      if (lastGoals) render(lastGoals);
    });

    // v0.0.938 — owner "TM 删错折叠了, 删的是📚 那个": tree-toggle-all
    // 按钮 + handler 删除. tree 展开通过 force-expand 当前任务路径 + 用户点
    // 单 chevron 控制, 不需要全局 toggle.

    // Operator 2026-05-29: Update runtime button. Hidden by default; the
    // poll loop below (every 60s) sets window.__ogamexLatestVersion and
    // re-renders if a newer version is available. Click opens the
    // downloadURL the sidecar reported — TM intercepts .user.js and prompts.
    const updateBtnEl = panel.querySelector<HTMLElement>("[data-action=\"update-runtime\"]");
    updateBtnEl?.addEventListener("click", () => {
      const url = ((typeof window !== "undefined" ? window : globalThis) as { __ogamexDownloadURL?: string }).__ogamexDownloadURL;
      if (!url) {
        console.warn("[panel/update] no downloadURL exposed by sidecar — cannot trigger install");
        return;
      }
      try { window.open(url, "_blank"); } catch { /* */ }
    });

    // Collapse toggle: flip collapsed state + persist + re-render to refresh
    // chevron + body visibility.
    const collapseBtn = panel.querySelector<HTMLElement>("[data-action=\"collapse\"]");
    collapseBtn?.addEventListener("click", () => {
      collapsed = !collapsed;
      saveJSON(LS_COLLAPSED_KEY, collapsed);
      const bodyEl = panel!.querySelector<HTMLElement>("[data-ogamex-body=\"1\"]");
      if (bodyEl) bodyEl.style.display = collapsed ? "none" : "block";
      collapseBtn!.textContent = collapsed ? "▸" : "▾";
      collapseBtn!.title = collapsed ? "Expand" : "Collapse";
    });

    // Drag handle: mousedown on header → track movement → write left/top on
    // mouseup + persist. Prevents drag-clicks from interpreting as button
    // clicks via the buttons' explicit stopPropagation on mousedown above
    // is NOT needed because clicks on action buttons don't fall through to
    // the drag handle (target check below).
    const dragHandle = panel.querySelector<HTMLElement>("[data-ogamex-drag=\"1\"]");
    if (dragHandle) {
      let dragging = false, didDrag = false, startX = 0, startY = 0, startLeft = 0, startTop = 0;
      dragHandle.addEventListener("mousedown", (e) => {
        const me = e as MouseEvent;
        // Ignore drag if mousedown lands on a button inside the header.
        if ((me.target as HTMLElement).closest("button")) return;
        dragging = true;
        didDrag = false;
        startX = me.clientX; startY = me.clientY;
        const r = panel!.getBoundingClientRect();
        startLeft = r.left; startTop = r.top;
        me.preventDefault();
      });
      const onMove = (e: MouseEvent): void => {
        if (!dragging) return;
        const dx = e.clientX - startX, dy = e.clientY - startY;
        // Only treat as actual drag if moved > 4px — otherwise click-toggle.
        if (Math.abs(dx) > 4 || Math.abs(dy) > 4) didDrag = true;
        const newLeft = Math.max(0, Math.min(window.innerWidth  - 50, startLeft + dx));
        const newTop  = Math.max(0, Math.min(window.innerHeight - 30, startTop  + dy));
        panel!.style.left = `${newLeft}px`;
        panel!.style.top  = `${newTop}px`;
        panel!.style.right = "auto";
      };
      const onUp = (): void => {
        if (!dragging) return;
        dragging = false;
        if (didDrag) {
          // Real drag — persist position.
          const r = panel!.getBoundingClientRect();
          saveJSON(LS_POS_KEY, { left: r.left, top: r.top });
        } else {
          // Click on header (no drag) → toggle collapse, same as ▾ button.
          collapsed = !collapsed;
          saveJSON(LS_COLLAPSED_KEY, collapsed);
          const bodyEl = panel!.querySelector<HTMLElement>("[data-ogamex-body=\"1\"]");
          if (bodyEl) bodyEl.style.display = collapsed ? "none" : "block";
          const cb = panel!.querySelector<HTMLElement>("[data-action=\"collapse\"]");
          if (cb) { cb.textContent = collapsed ? "▸" : "▾"; cb.title = collapsed ? "Expand" : "Collapse"; }
        }
      };
      doc.addEventListener("mousemove", onMove);
      doc.addEventListener("mouseup", onUp);
    }
  }

  // Track event IDs already alerted — used only to detect NEW arrivals.
  // Continuous alarm runs until /v1/emergency reports count=0 (danger cleared).
  const alertedIds = new Set<string>();

  // Shared AudioContext. Recreating per-beep cost us: each new instance
  // inherited the suspended state from autoplay policy, so the first
  // tone after page reload was silent. Single ctx, resume() before use.
  // Operator 2026-05-24: "爲啥沒聽到聲音報警".
  let sharedAudioCtx: AudioContext | null = null;
  function getAudioCtx(): AudioContext | null {
    if (sharedAudioCtx) return sharedAudioCtx;
    try {
      const w = doc.defaultView as Window & { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
      const Ctor = w.AudioContext ?? w.webkitAudioContext;
      if (!Ctor) {
        console.warn("[panel/alarm] no AudioContext available — browser too old?");
        return null;
      }
      sharedAudioCtx = new Ctor();
      console.log(`[panel/alarm] AudioContext created, state=${sharedAudioCtx.state}`);
      return sharedAudioCtx;
    } catch (e) {
      console.warn("[panel/alarm] AudioContext init failed:", e);
      return null;
    }
  }
  // Pre-warm on first user interaction with the page. Chrome's autoplay
  // policy keeps the context suspended until a user gesture resumes it;
  // doing this on a hidden listener means the alarm beep at hostile time
  // will hit a running context, no silent first-tone.
  let prewarmDone = false;
  const prewarmHandler = (): void => {
    if (prewarmDone) return;
    prewarmDone = true;
    const ctx = getAudioCtx();
    if (ctx && ctx.state === "suspended") {
      void ctx.resume().then(() => console.log("[panel/alarm] AudioContext resumed by user gesture"));
    }
  };
  doc.addEventListener("click", prewarmHandler, true);
  doc.addEventListener("keydown", prewarmHandler, true);

  function playBeep(severity: "spy" | "attack"): void {
    const ctx = getAudioCtx();
    if (!ctx) return;
    // If still suspended (no user gesture yet), kick resume — best effort.
    if (ctx.state === "suspended") {
      void ctx.resume();
    }
    console.log(`[panel/alarm] 🔊 playBeep severity=${severity} ctxState=${ctx.state}`);
    try {
      const tones = severity === "attack" ? [880, 0, 880, 0, 880] : [660];
      const stepMs = severity === "attack" ? 130 : 600;
      let tVal = ctx.currentTime;
      for (const freq of tones) {
        if (freq === 0) { tVal += stepMs / 1000; continue; }
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "square";
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, tVal);
        gain.gain.exponentialRampToValueAtTime(0.35, tVal + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, tVal + (stepMs - 20) / 1000);
        osc.connect(gain).connect(ctx.destination);
        osc.start(tVal);
        osc.stop(tVal + stepMs / 1000);
        tVal += stepMs / 1000;
      }
    } catch (e) {
      console.warn("[panel/alarm] playBeep threw:", e);
    }
  }

  // Persistent-alarm loop: while hostile present, replay beep at fixed
  // interval AND keep panel flashing. Cleared when danger gone.
  let alarmIntervalId: ReturnType<typeof setInterval> | null = null;
  let currentAlarmSeverity: "spy" | "attack" | null = null;

  function applyFlash(severity: "spy" | "attack"): void {
    const panel = doc.getElementById("ogamex-goals-panel");
    if (!panel) return;
    const color = severity === "attack" ? "#ff2020" : "#ffaa20";
    panel.style.boxShadow = `0 0 24px 6px ${color}, 0 0 4px 1px ${color} inset`;
    panel.style.borderColor = color;
  }
  function clearFlash(): void {
    const panel = doc.getElementById("ogamex-goals-panel");
    if (!panel) return;
    panel.style.boxShadow = "";
    panel.style.borderColor = "";
  }

  function startAlarm(severity: "spy" | "attack"): void {
    // If escalating from spy → attack, switch immediately.
    if (alarmIntervalId !== null && currentAlarmSeverity === severity) return;
    console.warn(`[panel/alarm] 🚨 startAlarm severity=${severity} (panel mounted=${!!doc.getElementById("ogamex-goals-panel")})`);
    stopAlarm();
    currentAlarmSeverity = severity;
    applyFlash(severity);
    playBeep(severity);
    // Re-beep every 3s (attack) / 6s (spy) until cleared.
    const beepIntervalMs = severity === "attack" ? 3000 : 6000;
    alarmIntervalId = setInterval(() => {
      if (currentAlarmSeverity === null) return;
      applyFlash(currentAlarmSeverity);
      playBeep(currentAlarmSeverity);
    }, beepIntervalMs);
  }
  function stopAlarm(): void {
    if (alarmIntervalId !== null) {
      clearInterval(alarmIntervalId);
      alarmIntervalId = null;
    }
    currentAlarmSeverity = null;
    clearFlash();
  }

  function evaluateAlerts(em: EmergencyPayload | null): void {
    if (!em || !Array.isArray(em.hostile) || em.hostile.length === 0) {
      // Danger cleared → silence + clear visuals.
      if (alarmIntervalId !== null) stopAlarm();
      return;
    }
    // Track-only — detection of NEW IDs is for telemetry; alarm is driven
    // by CURRENT-tick hostile presence, not by new arrivals.
    for (const h of em.hostile) alertedIds.add(h.id);
    // Severity = highest of currently-active. Attack wins.
    const hasAttack = em.hostile.some((h) => h.type === "attack");
    const severity: "spy" | "attack" = hasAttack ? "attack" : "spy";
    // Start (or escalate) alarm. If same severity already running, no-op.
    if (currentAlarmSeverity !== severity) startAlarm(severity);
  }

  async function refresh(): Promise<void> {
    // Skip re-render only while pointer is on the panel (so clicks /
    // hovers on tree nodes don't get rebuilt out from under the user).
    const skipRender = panelHovered;
    try {
      const [goals, emergency, expedition] = await Promise.all([
        fetchGoals(),
        fetchEmergency(),
        fetchExpedition(),
      ]);
      lastGoals = goals;
      lastEmergency = emergency;
      lastExpedition = expedition;
      evaluateAlerts(emergency);
      if (!skipRender) render(goals);
    } catch (e) {
      if (!skipRender) render([], (e as Error).message);
    }
  }

  // v0.0.991 — owner "idle tab JS 心跳 可以取消": hidden tab 时 timer 清掉
  // (self-chained setTimeout 不再续), visibility 回来时 catch-up refresh + 重续.
  // 用户看不到 panel 期间 0 fetch/render.
  function schedule(): void {
    if (stopped || document.hidden) return;
    timer = setTimeout(async () => {
      await refresh();
      schedule();
    }, pollMs);
  }
  document.addEventListener("visibilitychange", () => {
    if (stopped) return;
    if (document.hidden) {
      if (timer) { clearTimeout(timer); timer = null; }
    } else if (timer === null) {
      void refresh().then(schedule);
    }
  });

  // 1Hz ticker — updates jumpgate mm:ss countdowns in place without full
  // panel re-render. Reads each .jg-cd span's snapshot value + harvested_at
  // and recomputes remaining seconds. Hides span when remaining hits 0.
  // v0.0.991 — owner "idle tab JS 心跳 可以取消": setVisibleInterval, hidden
  // tab 时 JG mm:ss 倒计时停 (用户看不到无意义), 可见时 catch-up tick 立即重算
  // 跳过的 elapsed 秒数 (snapshot+at 是 wall-clock based, 不会显示错误).
  const jgTickerHandle = setVisibleInterval(() => {
    if (!panel) return;
    const spans = panel.querySelectorAll<HTMLElement>(".jg-cd");
    if (spans.length === 0) return;
    const now = Date.now();
    spans.forEach((sp) => {
      const snap = parseInt(sp.dataset["snap"] ?? "0", 10);
      const at = parseInt(sp.dataset["at"] ?? "0", 10);
      const elapsed = Math.floor((now - at) / 1000);
      const remain = Math.max(0, snap - elapsed);
      if (remain === 0) {
        // v0.0.517 — operator 2026-05-31 "不要顯示 ready": cooldown 到 0 →
        // 隱藏該 cell (operator 不想看 ready 行)。
        const row = sp.closest("div");
        if (row) (row as HTMLElement).style.display = "none";
        return;
      }
      const mm = Math.floor(remain / 60);
      const ss = remain % 60;
      sp.textContent = `${mm}:${ss.toString().padStart(2, "0")}`;
    });
  }, 1000);

  function stop(): void {
    stopped = true;
    if (timer) clearTimeout(timer);
    jgTickerHandle.stop();
    if (updateCheckTimer) clearInterval(updateCheckTimer);
    stopAlarm();
    panel?.remove();
  }

  // First render + start poll loop.
  void refresh().then(schedule);

  return { refresh, stop };
}

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
