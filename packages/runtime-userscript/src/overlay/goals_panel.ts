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
  const bodyHTML = `
    <div style="color:#7080a0; font-size:11px; padding-bottom:6px;">紧急任务 (Fleet Save) — attack/spy 触发自动起飞 + 召回</div>
    ${renderToggleRow("整体启用", !paused, "em-paused", "OFF = 全局暂停 FS 自动起飞 (手动操作不受影响)")}
    ${renderToggleRow("侦察触发 FS", spyOn, "em-spy", "ON = spy event 也走 FS 链路 (默认开); OFF = 仅 attack 触发")}
    <div style="color:#5a7090; font-size:10px; padding-top:10px;">变更立即生效, 无需保存.</div>
  `;
  openSettingsModal(doc, "emergency", "🚨 紧急任务设置", bodyHTML, (m) => {
    const reflect = (sel: string, isOn: boolean): void => {
      const btn = m.querySelector<HTMLElement>(sel);
      if (!btn) return;
      btn.textContent = isOn ? "ON" : "OFF";
      btn.setAttribute("style", `padding:2px 10px; border-radius:3px; cursor:pointer; font-size:11px; font-weight:bold;${isOn
        ? "background:#205a20; color:#fff; border:1px solid #408a40;"
        : "background:#5a2020; color:#fff; border:1px solid #8a4040;"}`);
    };
    m.querySelector<HTMLElement>("[data-em-paused]")?.addEventListener("click", () => {
      const next = !(lsGet("ogamex.emergency.paused") === "true");  // toggle the paused-flag → enabled-flag
      lsSet("ogamex.emergency.paused", next ? "false" : "true");
      reflect("[data-em-paused]", next);
    });
    m.querySelector<HTMLElement>("[data-em-spy]")?.addEventListener("click", () => {
      const cur = lsGet("OGAMEX_SPY_TRIGGERS_SAVE") !== "off";
      const next = !cur;
      lsSet("OGAMEX_SPY_TRIGGERS_SAVE", next ? "on" : "off");
      (window as Window & { __ogamexSpyTriggersSave?: boolean }).__ogamexSpyTriggersSave = next;
      reflect("[data-em-spy]", next);
    });
  });
}

// M2 — expedition settings modal. Reads the on-disk config via sidecar
// `GET /v1/expedition/config` and writes back via POST. Now split into two
// tabs (operator 2026-05-29: "改成两个 tab"): "发船星球" (per-planet
// checkboxes for opt-in source pool) and "舰队模板" (per-ship-type number
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
    { key: "smallCargo",     label: "小型運輸艦 (SC)" },
    { key: "largeCargo",     label: "大型運輸艦 (LC)" },
    { key: "lightFighter",   label: "輕型戰鬥機 (LF)" },
    { key: "heavyFighter",   label: "重型戰鬥機 (HF)" },
    { key: "cruiser",        label: "巡洋艦 (Cr)" },
    { key: "battleship",     label: "戰鬥艦 (BS)" },
    { key: "colonyShip",     label: "殖民船 (CS)" },
    { key: "recycler",       label: "回收船 (RC)" },
    { key: "espionageProbe", label: "間諜衛星 (EP)" },
    { key: "bomber",         label: "轟炸機 (Bom)" },
    { key: "destroyer",      label: "驅逐艦 (Des)" },
    { key: "deathstar",      label: "死星 (DS)" },
    { key: "battlecruiser",  label: "戰巡艦 (BC)" },
    { key: "reaper",         label: "惡魔飛船 (RIP)" },
    { key: "explorer",       label: "探路者 (PF)" },
  ];
  const placeholder = `<div style="color:#7080a0; padding:8px 0;">loading expedition config…</div>`;
  openSettingsModal(doc, "expedition", "🛸 远征任务设置", placeholder, async (m) => {
    const body = m.querySelector<HTMLElement>("div[role='dialog'] > div:nth-of-type(2)");
    if (!body) return;
    let initial: { template?: Record<string, number>; paused?: boolean; enabled?: boolean; enabled_planets?: string[]; auto_build_ships?: boolean } = {};
    try {
      const r = await fetchFn(`${baseUrl}/ogamex/v1/expedition/config`, { method: "GET" });
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
      return `<label style="${cellStyle} cursor:pointer;">
        <input data-exp-planet="${escapeHtml(p.id)}" type="checkbox" ${checked ? "checked" : ""} style="vertical-align:middle;"/>
        <span>${icon} ${escapeHtml(p.name ?? (p.type === "moon" ? "月球" : "殖民"))}</span>
      </label>`;
    };
    const planetRows = sortedCoordKeys.length === 0
      ? `<div style="color:#7080a0; padding:8px 0; font-size:11px;">(无 planet — state 未就绪, 刷新 ogame 页面)</div>`
      : `<div style="padding:4px 0 6px; display:flex; gap:8px; font-size:10px; color:#7080a0; border-bottom:1px solid #2a3a52;">
          <span style="width:78px;">坐标</span>
          <span style="flex:1;">🌍 行星</span>
          <span style="flex:1;">🌙 月球</span>
        </div>` + sortedCoordKeys.map((k) => {
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
      <div style="color:#7080a0; font-size:11px; padding-bottom:6px;">远征任务 — 勾选发船星球 + 设置舰队模板</div>
      ${renderToggleRow("整体启用", !paused, "exp-paused", "OFF = daemon 跳过本轮 tick (现有 fleet 不受影响)")}
      <div style="padding-top:10px; display:flex; gap:0; border-bottom:1px solid #2a3a52;">
        ${tabBtn("planets", "发船星球", true)}
        ${tabBtn("template", "舰队模板", false)}
      </div>
      <div data-exp-pane="planets" style="display:block; padding-top:8px;">
        <div style="display:flex; justify-content:space-between; padding:4px 0; font-size:10px;">
          <span style="color:#7080a0;">勾选 = 加入 round-robin 发船池</span>
          <span>
            <button data-exp-planet-all="1" style="background:transparent; color:#7cfc00; border:none; cursor:pointer; font-size:10px; padding:0 4px;">全选</button>
            <button data-exp-planet-none="1" style="background:transparent; color:#ff9b9b; border:none; cursor:pointer; font-size:10px; padding:0 4px;">全清</button>
          </span>
        </div>
        ${planetRows}
      </div>
      <div data-exp-pane="template" style="display:none; padding-top:8px;">
        <!-- Operator 2026-05-29: 顶部 chips summary 显示当前舰队组成,
             跟着 input 变化实时更新. 无船时显 placeholder. -->
        <div style="padding:6px 8px; background:#0a1018; border:1px solid #2a3a52; border-radius:4px; margin-bottom:8px;">
          <div style="color:#7080a0; font-size:10px; padding-bottom:4px;">当前舰队组成</div>
          <div data-exp-fleet-summary style="display:flex; flex-wrap:wrap; gap:6px; min-height:18px;"></div>
          <div data-exp-fleet-total style="color:#7080a0; font-size:10px; padding-top:6px; text-align:right;"></div>
        </div>
        ${renderToggleRow("船不够自动造船", initial.auto_build_ships === true, "exp-autobuild", "ON = 船数不足的星球自动创建 build_ships 任务 (会按 priority 8 占用 shipyard 资源)")}
        <div style="color:#7080a0; font-size:10px; padding-bottom:4px;">每次派遣的船数 (0 = 不派此类船 · 点击输入框=全选)</div>
        <!-- Operator 2026-05-29: 改成两列 — grid 自动按行填充, 高度对半 -->
        <div style="display:grid; grid-template-columns:1fr 1fr; column-gap:14px;">${shipRows}</div>
      </div>
      <div style="display:flex; justify-content:flex-end; gap:8px; padding-top:12px;">
        <span data-exp-status style="color:#7080a0; font-size:10px; align-self:center;"></span>
        <button data-exp-save="1" style="background:#205a20; color:#fff; border:1px solid #408a40; padding:4px 14px; border-radius:3px; cursor:pointer; font-size:11px;">保存</button>
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
        ? `<span style="color:#5a7090; font-size:11px; font-style:italic;">(空 — 至少需 1 艘船才能派遣)</span>`
        : chips.join("");
      total.textContent = totalShips > 0 ? `共 ${fmtNum(totalShips)} 艘` : "";
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
    // 全选 / 全清 helpers.
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
        await fetchFn(`${baseUrl}/ogamex/v1/expedition/${liveExpPaused ? "pause" : "resume"}`, { method: "POST" });
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
          headers: { "Content-Type": "application/json" },
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
  openSettingsModal(doc, "discovery", "🧬 发现任务设置", placeholder, async (m) => {
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
    // Status block (when goal is active). Operator 2026-05-29: 来源星球
    // 显示坐标 (+ name), 不要 internal planet id.
    let statusHTML = "";
    if (activeGoal) {
      const tgt = activeGoal.target ?? {};
      const completedCount = Array.isArray(tgt.completed) ? tgt.completed.length : 0;
      const total = ((tgt.range ?? 10) * 2 + 1) * 15;
      const pct = total > 0 ? Math.floor((completedCount / total) * 100) : 0;
      const srcId = String(tgt.source_planet ?? activeGoal.planet ?? "");
      const srcPlanet = srcId ? (storeRef?.state?.planets?.[srcId] ?? null) : null;
      const srcDisplay = srcPlanet?.coords
        ? `${srcPlanet.name ?? "殖民"} [${srcPlanet.coords.join(":")}]`
        : (srcId || "?");
      statusHTML = `<div style="padding:8px 10px; background:#0a1018; border:1px solid #2a3a52; border-radius:4px; margin-bottom:10px;">
        <div style="color:#7080a0; font-size:10px; padding-bottom:4px;">当前活跃发现任务</div>
        <div style="color:#d0d8e0; font-size:11px;">
          <div>★ 来源星球: <span style="color:#c080ff;">${escapeHtml(srcDisplay)}</span></div>
          <div>★ 中心系统: <span style="color:#c080ff;">${escapeHtml(String(tgt.galaxy ?? "?"))}:${escapeHtml(String(tgt.base_system ?? "?"))}</span> · 半径 ${escapeHtml(String(tgt.range ?? 10))}</div>
          <div>★ 进度: ${completedCount} / ${total} (${pct}%)</div>
          <div>★ 当前步骤: ${escapeHtml(String(activeGoal.current_step ?? "—"))}</div>
        </div>
        <div style="display:flex; justify-content:flex-end; padding-top:8px;">
          <button data-disc-stop="1" data-disc-goal-id="${escapeHtml(activeGoal.id)}" style="background:#5a2020; color:#fff; border:1px solid #8a4040; padding:3px 12px; border-radius:3px; cursor:pointer; font-size:11px;">停止当前任务</button>
        </div>
      </div>`;
    }
    const planetOpts = planets.map((p) => {
      const cs = (p.coords ?? []).join(":");
      return `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name ?? "殖民")} [${escapeHtml(cs)}]</option>`;
    }).join("");
    body.innerHTML = `
      <div style="color:#7080a0; font-size:11px; padding-bottom:6px;">物种发现 — 探路者扫描系统物种, 1 个 active goal at a time</div>
      ${statusHTML}
      <div style="padding:8px 10px; background:#0a1018; border:1px solid #2a3a52; border-radius:4px;">
        <div style="color:#7080a0; font-size:10px; padding-bottom:6px;">${activeGoal ? "替换当前任务 (先 Stop 再 Start, 或直接 Start — 旧 goal 会被替换)" : "创建新发现任务"}</div>
        <div style="display:flex; gap:8px; align-items:center; padding:6px 0;">
          <span style="color:#d0d8e0; font-size:11px; width:80px;">来源星球</span>
          <select data-disc-planet style="${inputStyle} flex:1;">${planetOpts || `<option value="">(无 planet)</option>`}</select>
        </div>
        <div style="display:flex; gap:8px; align-items:center; padding:6px 0;">
          <span style="color:#d0d8e0; font-size:11px; width:80px;">扫描半径</span>
          <input data-disc-range type="number" min="1" max="20" value="${escapeHtml(String(activeGoal?.target?.range ?? 10))}" onclick="this.select()" style="${inputStyle} width:80px;"/>
          <span style="color:#7080a0; font-size:10px;">中心 ± N 系统 (1-20), 每个系统扫 15 位置</span>
        </div>
        <div style="display:flex; justify-content:flex-end; gap:8px; padding-top:8px;">
          <span data-disc-status style="color:#7080a0; font-size:10px; align-self:center;"></span>
          <button data-disc-start="1" style="background:#205a20; color:#fff; border:1px solid #408a40; padding:4px 14px; border-radius:3px; cursor:pointer; font-size:11px;">Start Discovery</button>
        </div>
      </div>
    `;
    // Wire Stop button.
    m.querySelector<HTMLElement>("[data-disc-stop]")?.addEventListener("click", async (e) => {
      const btn = e.currentTarget as HTMLElement;
      const gid = btn.getAttribute("data-disc-goal-id") ?? "";
      if (!gid) return;
      btn.textContent = "stopping…";
      try {
        await fetchFn(`${baseUrl}/ogamex/v1/goals/${encodeURIComponent(gid)}/cancel`, { method: "POST" });
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
        if (status) { status.textContent = "× 请选择来源星球"; status.style.color = "#ff6b6b"; }
        return;
      }
      const planet = planets.find((p) => p.id === pid);
      const coords = planet?.coords ?? [];
      const galaxy = coords[0] ?? 0;
      const baseSystem = coords[1] ?? 0;
      if (status) { status.textContent = "creating…"; status.style.color = "#7080a0"; }
      try {
        const r = await fetchFn(`${baseUrl}/ogamex/v1/discovery/create`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ source_planet: pid, galaxy, base_system: baseSystem, range }),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
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
    { value: "build",             label: "build · 建造",           planetReq: true,  targetPlaceholder: `{"building":"metalMine","level":42}` },
    { value: "research",          label: "research · 科研",         planetReq: true,  targetPlaceholder: `{"tech":"astrophysics","level":18}` },
    { value: "build_universal",   label: "build_universal · 全部统一建", planetReq: false, targetPlaceholder: `{"building":"shipyard","level":12}` },
    { value: "build_ships",       label: "build_ships · 造舰",      planetReq: true,  targetPlaceholder: `{"ship":"largeCargo","amount":500}` },
    { value: "build_defense",     label: "build_defense · 造防",    planetReq: true,  targetPlaceholder: `{"defense":"rocketLauncher","amount":1000}` },
    { value: "colonize",          label: "colonize · 殖民",         planetReq: true,  targetPlaceholder: `{"target_coords":"3:280:7"}` },
    { value: "lifeform_building", label: "lifeform_building · 生命形式建筑", planetReq: true,  targetPlaceholder: `{"building":"residentialSector","level":40}` },
    { value: "lifeform_research", label: "lifeform_research · 生命形式科研", planetReq: true,  targetPlaceholder: `{"tech":"intergalacticEnvoys","level":10}` },
    { value: "lifeform_level_to", label: "lifeform_level_to · 生命形式等级", planetReq: true,  targetPlaceholder: `{"level":3}` },
    { value: "pick_lifeform",     label: "pick_lifeform · 选生命形式", planetReq: true,  targetPlaceholder: `{"species":"kaelesh"}` },
    { value: "terraformer_to",    label: "terraformer_to · 地形改造", planetReq: true,  targetPlaceholder: `{"level":8}` },
    { value: "expedition",        label: "expedition · 远征",       planetReq: false, targetPlaceholder: `{"source_planet":"<id>","ships":{"largeCargo":1600,"explorer":1000}}` },
    { value: "deploy",            label: "deploy · 部署",           planetReq: true,  targetPlaceholder: `{"target_coords":"4:241:8","target_type":"moon","ships":{"largeCargo":100}}` },
    { value: "transport",         label: "transport · 运输",        planetReq: true,  targetPlaceholder: `{"target_coords":"4:241:8","ships":{"largeCargo":100},"cargo":{"m":1000000,"c":0,"d":0}}` },
  ];
  const placeholder = `<div style="color:#7080a0; padding:8px 0;">loading planet list…</div>`;
  openSettingsModal(doc, "goals", "🪐 普通任务设置", placeholder, async (m) => {
    const body = m.querySelector<HTMLElement>("div[role='dialog'] > div:nth-of-type(2)");
    if (!body) return;
    interface StorePlanet { id: string; type?: string; coords?: number[]; name?: string }
    const storeRef = (window as Window & { __ogamexStore?: { state?: { planets?: Record<string, StorePlanet> } } }).__ogamexStore;
    // Operator 2026-05-29: "星球选择改成两列 星球在第一列，月球在第二列".
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
    // v0.0.582 — operator 2026-06-01: tab mode. 6 tabs:
    //   1. 星球建筑 — build (planet), build_universal, terraformer_to
    //   2. 月球建筑 — build (moon-only buildings: jumpgate, sensorPhalanx, lunarBase, moonShield)
    //   3. 生命形态建筑 — lifeform_building, pick_lifeform, lifeform_level_to
    //   4. 普通研究 — research
    //   5. 生命形态研究 — lifeform_research
    //   6. 舰队任务 — colonize, expedition, deploy, transport, build_ships, build_defense
    // Tab switch filters goal type select options + dims planet/moon rows
    // that don't match the tab's body kind.
    type TabId = "planet-build" | "moon-build" | "lf-build" | "research" | "lf-research" | "fleet";
    const TAB_DEFS: Array<{ id: TabId; label: string; goalTypes: string[]; bodyFilter: "planet" | "moon" | "any" }> = [
      { id: "planet-build", label: "🌍 星球建筑", goalTypes: ["build", "build_universal", "terraformer_to"], bodyFilter: "planet" },
      { id: "moon-build",   label: "🌙 月球建筑", goalTypes: ["build"],                                       bodyFilter: "moon"   },
      { id: "lf-build",     label: "🧬 生命建筑", goalTypes: ["lifeform_building", "pick_lifeform", "lifeform_level_to"], bodyFilter: "planet" },
      { id: "research",     label: "🔬 普通研究", goalTypes: ["research"],                                    bodyFilter: "planet" },
      { id: "lf-research",  label: "⚗️ 生命研究", goalTypes: ["lifeform_research"],                            bodyFilter: "planet" },
      { id: "fleet",        label: "🚀 舰队任务", goalTypes: ["colonize", "expedition", "deploy", "transport", "build_ships", "build_defense"], bodyFilter: "any" },
    ];
    const presetByValue = new Map(GOAL_PRESETS.map((g) => [g.value, g] as const));
    const renderTabBar = (): string => TAB_DEFS.map((t) =>
      `<button data-tab-btn="${t.id}" style="background:#0a1018; color:#7080a0; border:1px solid #2a3a52; border-bottom:none; padding:6px 10px; font-size:11px; cursor:pointer; border-top-left-radius:4px; border-top-right-radius:4px;">${escapeHtml(t.label)}</button>`,
    ).join("");
    const inputStyle = "background:#0a1018; color:#e0e8f0; border:1px solid #2a3a52; border-radius:3px; padding:3px 6px; font-size:11px;";
    // v0.0.583 — operator 2026-06-01: "星球建筑 tab" 独立 form (去掉 NL,
    // 只列 planet, 占用灰显, 建筑 radio + level input + 实时描述). Other 5
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
      metalMine: "金属矿", crystalMine: "晶体矿", deuteriumSynth: "重氢合成器",
      solarPlant: "太阳能", fusionReactor: "核聚变",
      metalStorage: "金属仓库", crystalStorage: "晶体仓库", deuteriumTank: "重氢罐",
      roboticsFactory: "机械工厂", shipyard: "船坞", researchLab: "实验室", naniteFactory: "纳米工厂",
      terraformer: "地形改造",
    };
    // v0.0.584 — operator 2026-06-01 "都是灰色是不对的, 多数星球上没有建造任务":
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
      <div style="color:#7080a0; font-size:11px; padding-bottom:6px;">普通任务 — 选 tab 创建任务. 已有 active goals 在主面板 Goals section 显示</div>
      <div data-tab-bar style="display:flex; gap:2px; margin-bottom:0;">${renderTabBar()}</div>
      <!-- v0.0.583 — 星球建筑独立 pane / v0.0.584 — 2-col + ogame-real-occupancy -->
      <div data-pane="planet-build" style="padding:8px 10px; background:#0a1018; border:1px solid #2a3a52; border-top:none; border-radius:0 4px 4px 4px;">
        <div style="padding:6px 0;">
          <div style="color:#d0d8e0; font-size:11px; padding-bottom:4px;">星球 (单选, 正在建造的星球灰显不可选)</div>
          <div style="border:1px solid #2a3a52; border-radius:3px; max-height:240px; overflow-y:auto; background:#06090f;">
            <div style="padding:4px 8px; display:flex; gap:16px; border-bottom:1px solid #1a2030;">
              <label data-pb-all-wrap style="flex:1; display:flex; align-items:center; gap:6px; cursor:pointer; color:#d0d8e0; font-size:11px;">
                <input data-pb-planet type="radio" name="pb-planet-radio" value="all-planets" style="vertical-align:middle;"/>
                <span>🌍 所有星球</span>
              </label>
              <label data-pb-idle-wrap style="flex:1; display:flex; align-items:center; gap:6px; cursor:pointer; color:#d0d8e0; font-size:11px;">
                <input data-pb-planet type="radio" name="pb-planet-radio" value="idle-planets" style="vertical-align:middle;"/>
                <span>🌍 空闲星球</span>
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
                const tip = occ ? `title="ogame 在建中, ${eta}min 后完成"` : "";
                const dim = occ ? "opacity:0.4; cursor:not-allowed;" : "cursor:pointer;";
                const occSuffix = occ ? ` <span style=\"color:#a06060; font-size:10px;\">[${eta}m]</span>` : "";
                return `<div style="padding:4px 8px; display:flex; gap:6px; align-items:center; border-bottom:1px solid #1a2030;">
                  <span style="width:60px; color:#7080a0; font-size:11px;">[${escapeHtml(k)}]</span>
                  <label style="flex:1; display:flex; align-items:center; gap:4px; color:#d0d8e0; font-size:11px; ${dim}" ${tip}>
                    <input data-pb-planet type="radio" name="pb-planet-radio" value="${escapeHtml(p.id)}" ${occ ? "disabled" : ""} style="vertical-align:middle;"/>
                    <span>🌍 ${escapeHtml(p.name ?? "殖民")}${occSuffix}</span>
                  </label>
                </div>`;
              }).join("")}
            </div>
          </div>
        </div>
        <div style="padding:6px 0;">
          <div style="color:#d0d8e0; font-size:11px; padding-bottom:4px;">建筑 (单选)</div>
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
          <span style="color:#d0d8e0; font-size:11px; width:80px;">目标级别</span>
          <input data-pb-level type="number" min="1" max="50" value="" placeholder="例: 7" onclick="this.select()" style="${inputStyle} width:100px;"/>
          <span style="color:#7080a0; font-size:10px;">支持 1-50</span>
        </div>
        <div style="padding:6px 0; min-height:22px;">
          <span data-pb-desc style="color:#7cfc00; font-size:11px;"></span>
        </div>
        <div style="display:flex; gap:8px; align-items:center; padding:6px 0;">
          <span style="color:#d0d8e0; font-size:11px; width:80px;">优先级</span>
          <input data-pb-priority type="number" min="1" max="20" value="5" onclick="this.select()" style="${inputStyle} width:80px;"/>
          <span style="color:#7080a0; font-size:10px;">默认 5; 越大越优先</span>
        </div>
        <div style="display:flex; justify-content:flex-end; gap:8px; padding-top:8px;">
          <span data-pb-status style="color:#7080a0; font-size:10px; align-self:center;"></span>
          <button data-pb-create style="background:#205a20; color:#fff; border:1px solid #408a40; padding:4px 14px; border-radius:3px; cursor:pointer; font-size:11px;">创建任务</button>
        </div>
      </div>
      <!-- v0.0.589 — 月球建筑独立 pane (类似 planet-build, 仅月球 + 月球建筑) -->
      <div data-pane="moon-build" style="display:none; padding:8px 10px; background:#0a1018; border:1px solid #2a3a52; border-top:none; border-radius:0 4px 4px 4px;">
        <div style="padding:6px 0;">
          <div style="color:#d0d8e0; font-size:11px; padding-bottom:4px;">月球 (单选, 正在建造的月球灰显不可选)</div>
          <div style="border:1px solid #2a3a52; border-radius:3px; max-height:240px; overflow-y:auto; background:#06090f;">
            <div style="padding:4px 8px; display:flex; gap:16px; border-bottom:1px solid #1a2030;">
              <label style="flex:1; display:flex; align-items:center; gap:6px; cursor:pointer; color:#d0d8e0; font-size:11px;">
                <input data-mb-moon type="radio" name="mb-moon-radio" value="all-moons" style="vertical-align:middle;"/>
                <span>🌙 所有月球</span>
              </label>
              <label style="flex:1; display:flex; align-items:center; gap:6px; cursor:pointer; color:#d0d8e0; font-size:11px;">
                <input data-mb-moon type="radio" name="mb-moon-radio" value="idle-moons" style="vertical-align:middle;"/>
                <span>🌙 空闲月球</span>
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
                const tip = occ ? `title="ogame 在建中, ${eta}min 后完成"` : "";
                const dim = occ ? "opacity:0.4; cursor:not-allowed;" : "cursor:pointer;";
                const occSuffix = occ ? ` <span style=\"color:#a06060; font-size:10px;\">[${eta}m]</span>` : "";
                return `<div style="padding:4px 8px; display:flex; gap:6px; align-items:center; border-bottom:1px solid #1a2030;">
                  <span style="width:60px; color:#7080a0; font-size:11px;">[${escapeHtml(k)}]</span>
                  <label style="flex:1; display:flex; align-items:center; gap:4px; color:#d0d8e0; font-size:11px; ${dim}" ${tip}>
                    <input data-mb-moon type="radio" name="mb-moon-radio" value="${escapeHtml(mb.id)}" ${occ ? "disabled" : ""} style="vertical-align:middle;"/>
                    <span>🌙 ${escapeHtml(mb.name ?? "月球")}${occSuffix}</span>
                  </label>
                </div>`;
              }).join("")}
            </div>
          </div>
        </div>
        <div style="padding:6px 0;">
          <div style="color:#d0d8e0; font-size:11px; padding-bottom:4px;">建筑 (单选)</div>
          <div style="border:1px solid #2a3a52; border-radius:3px; padding:6px 8px; background:#06090f; display:grid; grid-template-columns:repeat(3, 1fr); gap:4px 8px;">
            <label style="display:flex; align-items:center; gap:6px; cursor:pointer; color:#d0d8e0; font-size:11px;"><input data-mb-building type="radio" name="mb-building-radio" value="lunarBase" style="vertical-align:middle;"/><span>月球基地</span></label>
            <label style="display:flex; align-items:center; gap:6px; cursor:pointer; color:#d0d8e0; font-size:11px;"><input data-mb-building type="radio" name="mb-building-radio" value="sensorPhalanx" style="vertical-align:middle;"/><span>传感器</span></label>
            <label style="display:flex; align-items:center; gap:6px; cursor:pointer; color:#d0d8e0; font-size:11px;"><input data-mb-building type="radio" name="mb-building-radio" value="jumpgate" style="vertical-align:middle;"/><span>跳跃门</span></label>
            <!-- v0.0.592 — operator 2026-06-01 "月球缺机器人工厂和造船厂, 和星球分开": ogame moon has its own independent roboticsFactory / shipyard counters from the planet sibling. Adding to moon-build options. -->
            <label style="display:flex; align-items:center; gap:6px; cursor:pointer; color:#d0d8e0; font-size:11px;"><input data-mb-building type="radio" name="mb-building-radio" value="roboticsFactory" style="vertical-align:middle;"/><span>机械工厂</span></label>
            <label style="display:flex; align-items:center; gap:6px; cursor:pointer; color:#d0d8e0; font-size:11px;"><input data-mb-building type="radio" name="mb-building-radio" value="shipyard" style="vertical-align:middle;"/><span>船坞</span></label>
          </div>
        </div>
        <div style="display:flex; gap:8px; align-items:center; padding:6px 0;">
          <span style="color:#d0d8e0; font-size:11px; width:80px;">目标级别</span>
          <input data-mb-level type="number" min="1" max="50" value="" placeholder="例: 2" onclick="this.select()" style="${inputStyle} width:100px;"/>
          <span style="color:#7080a0; font-size:10px;">支持 1-50</span>
        </div>
        <div style="padding:6px 0; min-height:22px;">
          <span data-mb-desc style="color:#7cfc00; font-size:11px;"></span>
        </div>
        <div style="display:flex; gap:8px; align-items:center; padding:6px 0;">
          <span style="color:#d0d8e0; font-size:11px; width:80px;">优先级</span>
          <input data-mb-priority type="number" min="1" max="20" value="5" onclick="this.select()" style="${inputStyle} width:80px;"/>
          <span style="color:#7080a0; font-size:10px;">默认 5; 越大越优先</span>
        </div>
        <div style="display:flex; justify-content:flex-end; gap:8px; padding-top:8px;">
          <span data-mb-status style="color:#7080a0; font-size:10px; align-self:center;"></span>
          <button data-mb-create style="background:#205a20; color:#fff; border:1px solid #408a40; padding:4px 14px; border-radius:3px; cursor:pointer; font-size:11px;">创建任务</button>
        </div>
      </div>
      <!-- Shared pane (used by 4 non-planet/moon-build tabs) -->
      <div data-pane="shared" style="display:none;">
      <!-- Operator 2026-05-29: 自然语言入口 — Gemini 解析 → 填表单 -->
      <div style="padding:8px 10px; background:#0a1018; border:1px solid #2a3a52; border-radius:4px; margin-bottom:8px;">
        <div style="color:#d0d8e0; font-size:11px; padding-bottom:4px;">自然语言描述 <span style="color:#7080a0; font-size:10px;">(可选 — 让 AI 解析填表单)</span></div>
        <textarea data-goal-nl rows="2" placeholder="例: 在 3:279:7 建金属矿到 42 级 / 母星出引力 6 / 在 4:241:8 造 500 大型运输舰" style="${inputStyle} width:100%; box-sizing:border-box; resize:vertical;"></textarea>
        <div style="display:flex; justify-content:flex-end; gap:8px; padding-top:6px;">
          <span data-goal-nl-status style="color:#7080a0; font-size:10px; align-self:center;"></span>
          <button data-goal-nl-parse="1" style="background:#3a3a5a; color:#fff; border:1px solid #6a6a8a; padding:3px 12px; border-radius:3px; cursor:pointer; font-size:11px;">🤖 解析填表单</button>
        </div>
      </div>
      <div style="padding:8px 10px; background:#0a1018; border:1px solid #2a3a52; border-top:none; border-radius:0 4px 4px 4px;">
        <div style="display:flex; gap:8px; align-items:center; padding:6px 0;">
          <span style="color:#d0d8e0; font-size:11px; width:80px;">任务类型</span>
          <select data-goal-type style="${inputStyle} flex:1;"></select>
        </div>
        <div style="padding:6px 0;">
          <div style="color:#d0d8e0; font-size:11px; padding-bottom:4px;">星球 (单选)</div>
          <div style="border:1px solid #2a3a52; border-radius:3px; max-height:180px; overflow-y:auto; background:#06090f;">
            <div style="padding:4px 8px; display:flex; gap:8px; font-size:10px; color:#7080a0; border-bottom:1px solid #2a3a52; background:#0a1018; position:sticky; top:0;">
              <span style="width:72px;">坐标</span>
              <span style="flex:1;">🌍 行星</span>
              <span style="flex:1;">🌙 月球</span>
            </div>
            <div style="padding:4px 8px; display:flex; gap:8px; align-items:center; border-bottom:1px solid #1a2030;">
              <span style="width:72px; color:#7080a0; font-size:11px;">—</span>
              <label style="flex:1; display:flex; align-items:center; gap:6px; cursor:pointer; color:#d0d8e0; font-size:11px;">
                <input data-goal-planet type="radio" name="goal-planet-radio" value="all-planets" checked style="vertical-align:middle;"/>
                <span>🌍 所有星球 (扇出每个星球各建一个)</span>
              </label>
              <label style="flex:1; display:flex; align-items:center; gap:6px; cursor:pointer; color:#d0d8e0; font-size:11px;">
                <input data-goal-planet type="radio" name="goal-planet-radio" value="all-moons" style="vertical-align:middle;"/>
                <span>🌙 所有月球 (扇出每个月球各建一个)</span>
              </label>
            </div>
            ${sortedCoordKeys.map((k) => {
              const { planet, moon } = groupedByCoord.get(k)!;
              const cellPlanet = planet
                ? `<label class="tab-cell-planet" style="flex:1; display:flex; align-items:center; gap:6px; cursor:pointer; color:#d0d8e0; font-size:11px;">
                    <input data-goal-planet type="radio" name="goal-planet-radio" value="${escapeHtml(planet.id)}" style="vertical-align:middle;"/>
                    <span>🌍 ${escapeHtml(planet.name ?? "殖民")}</span>
                  </label>`
                : `<span class="tab-cell-planet" style="flex:1; color:#3a4658; font-size:11px; font-style:italic;">—</span>`;
              const cellMoon = moon
                ? `<label class="tab-cell-moon" style="flex:1; display:flex; align-items:center; gap:6px; cursor:pointer; color:#d0d8e0; font-size:11px;">
                    <input data-goal-planet type="radio" name="goal-planet-radio" value="${escapeHtml(moon.id)}" style="vertical-align:middle;"/>
                    <span>🌙 ${escapeHtml(moon.name ?? "月球")}</span>
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
          <span style="color:#d0d8e0; font-size:11px; width:80px;">优先级</span>
          <input data-goal-priority type="number" min="1" max="20" value="5" onclick="this.select()" style="${inputStyle} width:80px;"/>
          <span style="color:#7080a0; font-size:10px;">默认 5; 越大越优先</span>
        </div>
        <div style="display:flex; justify-content:flex-end; gap:8px; padding-top:8px;">
          <span data-goal-status style="color:#7080a0; font-size:10px; align-self:center;"></span>
          <button data-goal-create="1" style="background:#205a20; color:#fff; border:1px solid #408a40; padding:4px 14px; border-radius:3px; cursor:pointer; font-size:11px;">创建任务</button>
        </div>
      </div>
      </div><!-- /data-pane="shared" -->
    `;
    // Sync textarea placeholder with selected type.
    const typeSel = m.querySelector<HTMLSelectElement>("[data-goal-type]");
    const targetTa = m.querySelector<HTMLTextAreaElement>("[data-goal-target]");
    const targetHint = m.querySelector<HTMLElement>("[data-goal-target-hint]");
    const refreshPreset = (): void => {
      const t = typeSel?.value ?? "";
      const preset = presetByValue.get(t);
      if (!preset || !targetTa || !targetHint) return;
      targetTa.value = preset.targetPlaceholder;
      targetHint.textContent = preset.planetReq ? "需要选 planet — 该类型必须指定 source" : "可不选 planet — planner 会默认或读 target 内字段";
    };
    typeSel?.addEventListener("change", refreshPreset);

    // v0.0.582 — tab switching. Activate "planet-build" by default.
    const planetBuildPane = m.querySelector<HTMLElement>('[data-pane="planet-build"]');
    const moonBuildPane = m.querySelector<HTMLElement>('[data-pane="moon-build"]');
    const sharedPane = m.querySelector<HTMLElement>('[data-pane="shared"]');
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
      // v0.0.583 — pane switch: planet-build / moon-build have dedicated
      // forms; the other 4 tabs share the legacy form.
      if (planetBuildPane) planetBuildPane.style.display = tabId === "planet-build" ? "" : "none";
      if (moonBuildPane) moonBuildPane.style.display = tabId === "moon-build" ? "" : "none";
      if (sharedPane) sharedPane.style.display = (tabId === "planet-build" || tabId === "moon-build") ? "none" : "";
      if (tabId === "planet-build" || tabId === "moon-build") return; // skip shared-form filtering below
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
    // v0.0.590 — operator 2026-06-01 "有月球不能选, 所有月球就不能选, 星球
    // 页面也是": if ANY body is occupied, the "所有" radio doesn't make sense
    // (literally cannot include them). Disable + gray it out, force operator
    // to pick "空闲" or a single body. "空闲" remains available always.
    // v0.0.590-591 — "有占用 ⇒ disable 所有", "无空闲 ⇒ disable 空闲".
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
    if (anyPlanetOccupied) dimRadio(pbAllPlanetsRadio, "有星球被占用, 不能选 '所有星球' (改选 '空闲星球' 或单个)");
    if (!anyPlanetIdle) dimRadio(pbIdlePlanetsRadio, "无空闲星球, 不能选 '空闲星球'");
    const refreshPbDesc = (): void => {
      if (!pbDescEl) return;
      const planetRadio = pbPlanetRadios().find((r) => r.checked);
      const buildingRadio = pbBuildingRadios().find((r) => r.checked);
      const lvl = parseInt(pbLevelInput?.value ?? "", 10);
      if (!planetRadio || !buildingRadio || !lvl) {
        pbDescEl.textContent = "（选星球 + 建筑 + 级别后显示）";
        pbDescEl.style.color = "#5a7090";
        return;
      }
      const bLabel = PLANET_BUILDING_LABEL[buildingRadio.value] ?? buildingRadio.value;
      if (planetRadio.value === "all-planets") {
        pbDescEl.textContent = `目标在 所有星球 建造 ${bLabel} ${lvl} 级`;
      } else if (planetRadio.value === "idle-planets") {
        pbDescEl.textContent = `目标在 所有空闲星球 建造 ${bLabel} ${lvl} 级`;
      } else {
        const coord = planetCoordById.get(planetRadio.value) ?? "?";
        pbDescEl.textContent = `目标在 ${coord} 建造 ${bLabel} ${lvl} 级`;
      }
      pbDescEl.style.color = "#7cfc00";
    };
    for (const r of pbPlanetRadios()) r.addEventListener("change", refreshPbDesc);
    for (const r of pbBuildingRadios()) r.addEventListener("change", refreshPbDesc);
    pbLevelInput?.addEventListener("input", refreshPbDesc);
    refreshPbDesc();
    pbCreateBtn?.addEventListener("click", async () => {
      if (!pbStatusEl) return;
      const planetRadio = pbPlanetRadios().find((r) => r.checked);
      const buildingRadio = pbBuildingRadios().find((r) => r.checked);
      const lvl = parseInt(pbLevelInput?.value ?? "", 10);
      const pri = parseInt(pbPriorityInput?.value ?? "5", 10) || 5;
      if (!planetRadio) { pbStatusEl.textContent = "请选星球"; pbStatusEl.style.color = "#a06060"; return; }
      if (!buildingRadio) { pbStatusEl.textContent = "请选建筑"; pbStatusEl.style.color = "#a06060"; return; }
      if (!lvl || lvl < 1 || lvl > 50) { pbStatusEl.textContent = "级别须 1-50"; pbStatusEl.style.color = "#a06060"; return; }
      pbStatusEl.textContent = "创建中…"; pbStatusEl.style.color = "#7080a0";
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
            headers: { "Content-Type": "application/json" },
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
        pbStatusEl.textContent = `✓ 已创建 ${okCount} 个任务`;
        pbStatusEl.style.color = "#7cfc00";
      } else {
        pbStatusEl.textContent = `部分失败: ${okCount} ok / ${errs.length} err — ${errs[0]}`;
        pbStatusEl.style.color = "#a06060";
      }
    });

    // v0.0.589 — moon-build pane wiring (mirrors planet-build).
    const MOON_BUILDING_LABEL: Record<string, string> = {
      lunarBase: "月球基地", sensorPhalanx: "传感器", jumpgate: "跳跃门",
      roboticsFactory: "机械工厂", shipyard: "船坞",
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
    if (anyMoonOccupied) dimRadio(mbAllMoonsRadio, "有月球被占用, 不能选 '所有月球' (改选 '空闲月球' 或单个)");
    if (!anyMoonIdle) dimRadio(mbIdleMoonsRadio, "无空闲月球, 不能选 '空闲月球'");
    const refreshMbDesc = (): void => {
      if (!mbDescEl) return;
      const moonRadio = mbMoonRadios().find((r) => r.checked);
      const buildingRadio = mbBuildingRadios().find((r) => r.checked);
      const lvl = parseInt(mbLevelInput?.value ?? "", 10);
      if (!moonRadio || !buildingRadio || !lvl) {
        mbDescEl.textContent = "（选月球 + 建筑 + 级别后显示）";
        mbDescEl.style.color = "#5a7090";
        return;
      }
      const bLabel = MOON_BUILDING_LABEL[buildingRadio.value] ?? buildingRadio.value;
      if (moonRadio.value === "all-moons") {
        mbDescEl.textContent = `目标在 所有月球 建造 ${bLabel} ${lvl} 级`;
      } else if (moonRadio.value === "idle-moons") {
        mbDescEl.textContent = `目标在 所有空闲月球 建造 ${bLabel} ${lvl} 级`;
      } else {
        const coord = moonCoordById.get(moonRadio.value) ?? "?";
        mbDescEl.textContent = `目标在 ${coord}(月球) 建造 ${bLabel} ${lvl} 级`;
      }
      mbDescEl.style.color = "#7cfc00";
    };
    for (const r of mbMoonRadios()) r.addEventListener("change", refreshMbDesc);
    for (const r of mbBuildingRadios()) r.addEventListener("change", refreshMbDesc);
    mbLevelInput?.addEventListener("input", refreshMbDesc);
    refreshMbDesc();
    mbCreateBtn?.addEventListener("click", async () => {
      if (!mbStatusEl) return;
      const moonRadio = mbMoonRadios().find((r) => r.checked);
      const buildingRadio = mbBuildingRadios().find((r) => r.checked);
      const lvl = parseInt(mbLevelInput?.value ?? "", 10);
      const pri = parseInt(mbPriorityInput?.value ?? "5", 10) || 5;
      if (!moonRadio) { mbStatusEl.textContent = "请选月球"; mbStatusEl.style.color = "#a06060"; return; }
      if (!buildingRadio) { mbStatusEl.textContent = "请选建筑"; mbStatusEl.style.color = "#a06060"; return; }
      if (!lvl || lvl < 1 || lvl > 50) { mbStatusEl.textContent = "级别须 1-50"; mbStatusEl.style.color = "#a06060"; return; }
      mbStatusEl.textContent = "创建中…"; mbStatusEl.style.color = "#7080a0";
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
            headers: { "Content-Type": "application/json" },
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
        mbStatusEl.textContent = `✓ 已创建 ${okCount} 个任务`;
        mbStatusEl.style.color = "#7cfc00";
      } else {
        mbStatusEl.textContent = `部分失败: ${okCount} ok / ${errs.length} err — ${errs[0]}`;
        mbStatusEl.style.color = "#a06060";
      }
    });

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
          const newPrefix = `在 ${coord} `;
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
        if (status) { status.textContent = "× 描述不能为空"; status.style.color = "#ff6b6b"; }
        return;
      }
      if (status) { status.textContent = "parsing…"; status.style.color = "#7080a0"; }
      try {
        const r = await fetchFn(`${baseUrl}/ogamex/v1/goals/parse`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
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
        if (status) { status.textContent = "✓ 已填入表单, 检查后点击创建任务"; status.style.color = "#7cfc00"; }
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
        if (!raw) throw new Error("target JSON 不能为空");
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("target 必须是 object");
        target = parsed;
      } catch (e) {
        if (status) { status.textContent = `× ${(e as Error).message}`; status.style.color = "#ff6b6b"; }
        return;
      }
      // v0.0.451: fanout — "all-planets" / "all-moons" iterates every
      // matching body and POSTs one goal per. Single-planet radio still
      // sends one POST. Operator 2026-05-29: "不指定 — 让 planner 默认"
      // 改成"所有星球",并加"所有月球"扇出。
      const planetIds: (string | undefined)[] = [];
      if (planetSel === "all-planets") {
        for (const k of sortedCoordKeys) {
          const p = groupedByCoord.get(k)?.planet;
          if (p) planetIds.push(p.id);
        }
        if (planetIds.length === 0) {
          if (status) { status.textContent = "× 没有 planet 可扇出"; status.style.color = "#ff6b6b"; }
          return;
        }
      } else if (planetSel === "all-moons") {
        for (const k of sortedCoordKeys) {
          const mn = groupedByCoord.get(k)?.moon;
          if (mn) planetIds.push(mn.id);
        }
        if (planetIds.length === 0) {
          if (status) { status.textContent = "× 没有 moon 可扇出"; status.style.color = "#ff6b6b"; }
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
            headers: { "Content-Type": "application/json" },
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
//   1. 选择运输舰的来源星球 (displays LC/SC counts on that planet),
//      checkbox "空船跳跃门可用时 是否使用跳跃门".
//   2. 资源所在星球 — pick planet, shows M/C/D, lets operator override
//      the amount to ship per resource, computes needed LC vs SC.
//   3. 目标星球.
//   4. 选 LC or SC → 自动填入数量 = ceil(total_res / ship_cap).
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
  openSettingsModal(doc, "transport", "🚚 运输设置", placeholder, async (m) => {
    const body = m.querySelector<HTMLElement>("div[role='dialog'] > div:nth-of-type(2)");
    if (!body) return;
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
    // Operator 2026-05-29: 所有星球选择框统一 2 列 grid (行星 | 月球).
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
    // v0.0.512 — operator 2026-05-31: 改成 type 切换 + 2 列 coord cells.
    // 头排 radio "🌍 星球 / 🌙 月球" 切类型, 下面 coord cells 2 列, 每 cell
    // 是 [G:S:P] + 选择 radio. 切换 type 时显示对应类型的 cells。
    // v0.0.519 — empire-wide moon count, drives type-toggle moon disable.
    const hasAnyMoon = sortedCoordKeys.some(k => !!groupedByCoord.get(k)?.moon);
    const planetSelectHtml = (radioName: string, includeUnset = false): string => {
      const moonAttrs = hasAnyMoon
        ? `data-tr-type-toggle="${radioName}"`
        : `data-tr-type-toggle="${radioName}" disabled`;
      const moonLabelStyle = hasAnyMoon ? "cursor:pointer;" : "cursor:not-allowed; opacity:0.4;";
      const typeRadio = `<div style="padding:6px 8px; display:flex; gap:14px; font-size:11px; color:#d0d8e0; border-bottom:1px solid #2a3a52; background:#0a1018; position:sticky; top:0;">
        <label style="cursor:pointer;"><input type="radio" name="${radioName}-type" value="planet" checked data-tr-type-toggle="${radioName}" style="margin-right:4px; vertical-align:middle;"/>🌍 星球</label>
        <label style="${moonLabelStyle}" title="${hasAnyMoon ? "" : "empire 无任何月球, 不可选"}"><input type="radio" name="${radioName}-type" value="moon" ${moonAttrs} style="margin-right:4px; vertical-align:middle;"/>🌙 月球</label>
      </div>`;
      const unset = includeUnset
        ? `<div style="padding:4px 8px; border-bottom:1px solid #1a2030;">
            <label style="cursor:pointer; color:#7080a0; font-size:11px;">
              <input type="radio" name="${radioName}" value="" checked style="margin-right:6px; vertical-align:middle;"/>(不选 — 默认目标)
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
      <div style="color:#7080a0; font-size:11px; padding-bottom:6px;">三步选择: 舰船 → 资源 → 目标 (→ 停泊). JG 多跳链需选停泊星球.</div>
      ${sectionCard("① 舰船星球",
        `<div style="max-height:140px; overflow-y:auto; background:#06090f; border-radius:3px;">${planetSelectHtml("tr-source-radio")}</div>
        <div data-tr-source-info style="color:#7080a0; font-size:10px; padding-top:6px; min-height:14px;">(选择来源星球后显示船数)</div>
        <label style="display:flex; gap:6px; align-items:center; padding-top:6px; cursor:pointer; color:#d0d8e0; font-size:11px;">
          <input type="checkbox" data-tr-jg-enable checked/>
          <span>空船跳跃门可用时 → 使用跳跃门 (Phase 2 生效)</span>
        </label>`)}
      ${sectionCard("② 资源星球",
        `<label style="display:block; cursor:pointer; color:#d0d8e0; font-size:11px; padding-bottom:6px;">
          <input type="checkbox" data-tr-resource-sameas-ship checked style="margin-right:6px; vertical-align:middle;"/>同 ① 舰船星球
        </label>
        <div data-tr-resource-picker-wrap style="display:none; max-height:140px; overflow-y:auto; background:#06090f; border-radius:3px;">${planetSelectHtml("tr-resource-radio")}</div>
        <div data-tr-resource-info style="color:#7080a0; font-size:10px; padding-top:6px; min-height:14px;">(选择后显示当前资源)</div>`)}
      ${sectionCard("③ 目标星球",
        `<div style="max-height:140px; overflow-y:auto; background:#06090f; border-radius:3px;">${planetSelectHtml("tr-target-radio")}</div>`)}
      ${sectionCard("④ 停泊星球 <span style='color:#7080a0; font-weight:normal;'>(不选 = 停在目标 / 选另一处 = 卸完资源用 deploy 飞过去)</span>",
        `<div style="display:flex; gap:14px; flex-wrap:wrap; padding-bottom:6px; font-size:11px; color:#d0d8e0;">
          <label style="cursor:pointer;"><input type="radio" name="tr-stopover-shortcut" value="ship" data-tr-stopover-shortcut checked style="margin-right:4px; vertical-align:middle;"/>舰船星球</label>
          <label style="cursor:pointer;"><input type="radio" name="tr-stopover-shortcut" value="resource" data-tr-stopover-shortcut style="margin-right:4px; vertical-align:middle;"/>资源星球</label>
          <label style="cursor:pointer;"><input type="radio" name="tr-stopover-shortcut" value="target" data-tr-stopover-shortcut style="margin-right:4px; vertical-align:middle;"/>目标星球</label>
          <label style="cursor:pointer;"><input type="radio" name="tr-stopover-shortcut" value="other" data-tr-stopover-shortcut style="margin-right:4px; vertical-align:middle;"/>其他星球</label>
        </div>
        <div data-tr-stopover-picker-wrap style="display:none; max-height:140px; overflow-y:auto; background:#06090f; border-radius:3px;">${planetSelectHtml("tr-stopover-radio", true)}</div>`)}
      ${sectionCard("⑤ 选船类型 + 资源装载 + 数量",
        `<div style="display:flex; gap:12px; padding-bottom:6px;">
          <label style="cursor:pointer; color:#d0d8e0; font-size:11px;"><input type="radio" name="tr-ship" value="largeCargo" checked data-tr-ship/> 大运 LC (cap ${fmt(ltCap)})</label>
          <label style="cursor:pointer; color:#d0d8e0; font-size:11px;"><input type="radio" name="tr-ship" value="smallCargo" data-tr-ship/> 小运 SC (cap ${fmt(stCap)})</label>
        </div>
        <div style="display:flex; gap:10px; padding:4px 0; align-items:center; font-size:11px; flex-wrap:wrap;">
          <label style="display:flex; align-items:center; gap:3px; cursor:pointer; color:#d0d8e0;">
            <input type="checkbox" data-tr-cargo-enable="m" checked style="margin:0;"/>
            <span>金属 M</span>
            <input data-tr-cargo="m" type="number" min="0" step="1000" value="0" onclick="this.select()" style="${inputStyle} width:90px;"/>
          </label>
          <label style="display:flex; align-items:center; gap:3px; cursor:pointer; color:#d0d8e0;">
            <input type="checkbox" data-tr-cargo-enable="c" checked style="margin:0;"/>
            <span>晶体 C</span>
            <input data-tr-cargo="c" type="number" min="0" step="1000" value="0" onclick="this.select()" style="${inputStyle} width:90px;"/>
          </label>
          <label style="display:flex; align-items:center; gap:3px; cursor:pointer; color:#d0d8e0;">
            <input type="checkbox" data-tr-cargo-enable="d" checked style="margin:0;"/>
            <span>重氢 D</span>
            <input data-tr-cargo="d" type="number" min="0" step="1000" value="0" onclick="this.select()" style="${inputStyle} width:90px;"/>
          </label>
        </div>
        <div style="display:flex; gap:8px; align-items:center; padding-top:4px;">
          <span style="color:#d0d8e0; font-size:11px; width:60px;">数量</span>
          <input data-tr-ship-count type="number" min="0" step="1" value="0" onclick="this.select()" style="${inputStyle} width:100px;"/>
          <span data-tr-ship-need style="color:#7cfc00; font-size:10px;">(改 ②/④ 后自动算)</span>
        </div>`)}
      ${sectionCard("⑥ 跳跃门返程选项",
        `<label style="cursor:pointer; color:#d0d8e0; font-size:11px; display:block;">
          <input type="checkbox" data-tr-jg-take-all checked/>
          <span style="margin-left:4px;">用跳跃门往回走的时候带回月球上所有的船</span>
          <span style="color:#7080a0; font-size:10px; display:block; margin-left:20px; margin-top:2px;">勾选 = JG 那一段动态带走源月球当时所有 ships (LC/SC/其他)<br/>不勾选 = JG 只带配置的 ships, 其他留在月球</span>
        </label>`)}
      <div style="display:flex; justify-content:flex-end; gap:8px; padding-top:8px;">
        <span data-tr-status style="color:#7080a0; font-size:10px; align-self:center;"></span>
        <button data-tr-submit style="background:#205a20; color:#fff; border:1px solid #408a40; padding:4px 14px; border-radius:3px; cursor:pointer; font-size:11px;">创建运输任务</button>
      </div>
    `;
    // v0.0.518 — section ②/④ shortcut wiring (operator 2026-05-31).
    // ② 同 ① 舰船 checkbox (默认勾选, 折叠 picker; ship!=resource 时自动展开):
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
    // ④ stopover shortcut wiring: 舰船/资源/目标/其他 → 自动设 tr-stopover-radio
    // 到对应 body id; "其他" 才显 picker。
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
        sourceInfo.innerHTML = `<span style="color:#d0d8e0;">大运 LC × ${fmt(lt)} · 小运 SC × ${fmt(st)}</span>`;
      });
    }
    // Operator 2026-05-29: 默认来源 = 当前 ogame 所在 planet. Reads the
    // ogame-planet-id meta (which ogame keeps in sync with the active
    // session-cp). Falls back silently if meta missing or planet not in
    // the grid (e.g. operator on a moon row not exposed).
    const ogameCurrentPid = doc.querySelector<HTMLMetaElement>('meta[name="ogame-planet-id"]')?.content ?? "";
    if (ogameCurrentPid) {
      // v0.0.521 — operator 2026-05-31 "我在月球时默认舰船星球不对". 之前只
      // setChecked 但 type toggle 默认 "星球" mode, 月球 radio 在隐藏 section。
      // 现在: 先判断当前 body type, 把 type toggle 切到对应 mode, 再 set radio。
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
      // v0.0.518 — section ③ 目标默认也 = 当前星球 (operator 2026-05-31).
      const targetRadioDefault = m.querySelector<HTMLInputElement>(`input[name="tr-target-radio"][value="${ogameCurrentPid}"]`);
      if (targetRadioDefault) {
        targetRadioDefault.checked = true;
        targetRadioDefault.dispatchEvent(new Event("change", { bubbles: true }));
      }
      // v0.0.518 — section ② "同上" 默认勾选, 同步 resource = ship。
      const resCb = m.querySelector<HTMLInputElement>("[data-tr-resource-sameas-ship]");
      if (resCb?.checked) {
        const rr = m.querySelector<HTMLInputElement>(`input[name="tr-resource-radio"][value="${ogameCurrentPid}"]`);
        if (rr) {
          rr.checked = true;
          rr.dispatchEvent(new Event("change", { bubbles: true }));
        }
      }
      // v0.0.518 — section ④ shortcut 默认 "舰船星球", stopover = ship planet。
      const stopRadio = m.querySelector<HTMLInputElement>(`input[name="tr-stopover-radio"][value="${ogameCurrentPid}"]`);
      if (stopRadio) stopRadio.checked = true;
      // v0.0.521 — operator "显示当前资源部分默认显示舰船星球资源"
      // 同上模式下虽然 resource radio 已经 set + dispatched change, 但如果 resInfo
      // 元素查询发生在这之前就漏了。 这里直接强制更新一次。
      const resInfo2 = m.querySelector<HTMLElement>("[data-tr-resource-info]");
      const currentP = planetsMap[ogameCurrentPid];
      if (resInfo2 && currentP) {
        const m_v = currentP.resources?.m ?? 0;
        const c_v = currentP.resources?.c ?? 0;
        const d_v = currentP.resources?.d ?? 0;
        resInfo2.innerHTML = `<span style="color:#d0d8e0;">M ${fmt(m_v)} · C ${fmt(c_v)} · D ${fmt(d_v)}</span>`;
        // v0.0.523 — operator 2026-05-31 "资源没有自动填入输入框". 真因:
        // boot 时 dispatch change 比 resource radio listener 注册早, change 事件
        // 没人接 → cargo auto-fill 路径漏了。 这里直接强制把当前星球 bank
        // 写到 cargo input (curM === 0 时), 跟正常 change handler 行为对齐。
        const cmEl = m.querySelector<HTMLInputElement>('[data-tr-cargo="m"]');
        const ccEl = m.querySelector<HTMLInputElement>('[data-tr-cargo="c"]');
        const cdEl = m.querySelector<HTMLInputElement>('[data-tr-cargo="d"]');
        if (cmEl && (parseInt(cmEl.value || "0", 10) || 0) === 0) cmEl.value = String(m_v);
        if (ccEl && (parseInt(ccEl.value || "0", 10) || 0) === 0) ccEl.value = String(c_v);
        if (cdEl && (parseInt(cdEl.value || "0", 10) || 0) === 0) cdEl.value = String(d_v);
        // v0.0.530 — operator 2026-05-31 "第一次进入页面没有和资源联动".
        // 填完 cargo 后强制 updateShipCount, 不再等 input 事件。
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
      // v0.0.531 — 未勾选的资源视为 0
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
      if (countInput) countInput.value = String(needed);
      // v0.0.530 — operator 2026-05-31 "船不够显示红色". 比对 ① 舰船星球 的
      // 真实船数 (LC 或 SC) vs needed, 不够 → 数量输入框 + 旁边提示 红字。
      const sourceVal = m.querySelector<HTMLInputElement>('input[name="tr-source-radio"]:checked')?.value ?? "";
      const sourceP = sourceVal ? planetsMap[sourceVal] : null;
      const shipKey = ship === "smallCargo" ? "smallCargo" : "largeCargo";
      const haveShips = (sourceP?.ships as Record<string, number | undefined> | undefined)?.[shipKey] ?? 0;
      const isShort = needed > haveShips;
      if (countInput) {
        countInput.style.color = isShort ? "#ff6b6b" : "#e0e8f0";
        countInput.style.borderColor = isShort ? "#ff6b6b" : "#2a3a52";
      }
      const needSpan = m.querySelector<HTMLElement>("[data-tr-ship-need]");
      if (needSpan) {
        const shortNote = isShort ? ` <span style="color:#ff6b6b; font-weight:bold;">船不够 (有 ${fmt(haveShips)})</span>` : "";
        needSpan.innerHTML = `需 ${needed} 艘 · 总载 ${fmt(total)}${moonBufferD ? ` (含 +50K d 月球 buffer)` : ""} (cap ${fmt(cap)})${shortNote}`;
      }
    }
    for (const r of m.querySelectorAll<HTMLInputElement>('input[name="tr-resource-radio"]')) {
      r.addEventListener("change", () => {
        if (!r.checked || !resInfo) return;
        if (!r.value) { resInfo.textContent = "—"; return; }
        const p = planetsMap[r.value];
        const m_v = p?.resources?.m ?? 0;
        const c_v = p?.resources?.c ?? 0;
        const d_v = p?.resources?.d ?? 0;
        resInfo.innerHTML = `<span style="color:#d0d8e0;">M ${fmt(m_v)} · C ${fmt(c_v)} · D ${fmt(d_v)}</span>`;
        // v0.0.504 — operator 2026-05-30 "提交后数据不对". Original logic
        // auto-overwrote cargo with source planet bank on EVERY radio change,
        // clobbering user's careful prefill from "→ 运输" shortage button.
        // New rule: only auto-fill when cargo input is empty/0 (first time).
        // Operator's manual edit + shortage prefill ALWAYS preserved.
        const mi = m.querySelector<HTMLInputElement>('[data-tr-cargo="m"]');
        const ci = m.querySelector<HTMLInputElement>('[data-tr-cargo="c"]');
        const di = m.querySelector<HTMLInputElement>('[data-tr-cargo="d"]');
        const curM = parseInt(mi?.value || "0", 10) || 0;
        const curC = parseInt(ci?.value || "0", 10) || 0;
        const curD = parseInt(di?.value || "0", 10) || 0;
        if (mi && curM === 0) mi.value = String(m_v);
        if (ci && curC === 0) ci.value = String(c_v);
        if (di && curD === 0) di.value = String(d_v);
        updateShipCount();
      });
    }
    // v0.0.477: cargo overflow indicator (operator 2026-05-30 "如果填的资源
    // 大于星球有的资源，资源显示红字"). Each input compares against the
    // CURRENT resource-source planet's bank; if user-typed value exceeds,
    // paint the input text red. Reads from radio selection live.
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
        if (val > cap) {
          ci.style.color = "#ff6b6b";
          ci.style.borderColor = "#ff6b6b";
          ci.title = `超出: 源 ${key.toUpperCase()} 只有 ${fmt(cap)}, 你填了 ${fmt(val)}`;
        } else {
          // v0.0.504 — operator 2026-05-30: setting style.color="" wiped the
          // inline style attr color (#e0e8f0), letting browser default win
          // (usually dark on dark bg → 文字不可见). Restore explicit values.
          ci.style.color = "#e0e8f0";
          ci.style.borderColor = "#2a3a52";
          ci.title = "";
        }
      }
    };
    // Cargo amount inputs → recompute ship count + overflow colors live.
    for (const ci of m.querySelectorAll<HTMLInputElement>("[data-tr-cargo]")) {
      ci.addEventListener("input", () => { updateShipCount(); refreshCargoOverflowColors(); });
    }
    // v0.0.531 — operator 2026-05-31: cargo enable checkbox (M/C/D 各一个).
    // 默认勾选, 不勾时该资源不装船 (cargo 视为 0)。 同时灰禁对应 input。
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
    for (const sr of m.querySelectorAll<HTMLInputElement>('input[name="tr-ship"]')) {
      sr.addEventListener("change", updateShipCount);
    }
    // v0.0.504 — also recompute on target radio change (moon target adds
    // 500K d buffer → ship count needs to include it).
    for (const tr of m.querySelectorAll<HTMLInputElement>('input[name="tr-target-radio"]')) {
      tr.addEventListener("change", updateShipCount);
    }
    // Submit — POST /v1/goals/create with a transport goal.
    m.querySelector<HTMLElement>("[data-tr-submit]")?.addEventListener("click", async () => {
      const status = m.querySelector<HTMLElement>("[data-tr-status]");
      const source = m.querySelector<HTMLInputElement>('input[name="tr-source-radio"]:checked')?.value ?? "";
      const resourceSrc = m.querySelector<HTMLInputElement>('input[name="tr-resource-radio"]:checked')?.value ?? "";
      const target = m.querySelector<HTMLInputElement>('input[name="tr-target-radio"]:checked')?.value ?? "";
      const ship = m.querySelector<HTMLInputElement>('input[name="tr-ship"]:checked')?.value ?? "largeCargo";
      const shipCount = parseInt((m.querySelector<HTMLInputElement>("[data-tr-ship-count]")?.value ?? "0"), 10) || 0;
      // v0.0.531 — 未勾选的资源 cargo = 0
      const cargoM = cargoEnabled("m") ? (parseInt((m.querySelector<HTMLInputElement>('[data-tr-cargo="m"]')?.value ?? "0"), 10) || 0) : 0;
      const cargoC = cargoEnabled("c") ? (parseInt((m.querySelector<HTMLInputElement>('[data-tr-cargo="c"]')?.value ?? "0"), 10) || 0) : 0;
      const cargoD = cargoEnabled("d") ? (parseInt((m.querySelector<HTMLInputElement>('[data-tr-cargo="d"]')?.value ?? "0"), 10) || 0) : 0;
      if (!source) { if (status) { status.textContent = "× 选 ① 来源星球"; status.style.color = "#ff6b6b"; } return; }
      if (!target) { if (status) { status.textContent = "× 选 ③ 目标星球"; status.style.color = "#ff6b6b"; } return; }
      if (shipCount <= 0) { if (status) { status.textContent = "× 数量必须 > 0"; status.style.color = "#ff6b6b"; } return; }
      const targetPlanet = planetsMap[target];
      const targetCoords = (targetPlanet?.coords ?? []).join(":");
      const jgEnabled = (m.querySelector<HTMLInputElement>("[data-tr-jg-enable]")?.checked) ?? false;
      // v0.0.468: operator-controlled take_all per chain (operator 2026-05-30
      // "默认勾选"). Modal checkbox → checked=true means JG hop legs do dynamic
      // ship sweep on dispatch; unchecked means JG hop carries only configured
      // ships count. Default checked.
      const jgTakeAll = (m.querySelector<HTMLInputElement>("[data-tr-jg-take-all]")?.checked) ?? true;
      // Build the chain: depending on (source vs resource) and (JG) we emit
      // 1-3 goals with a shared chain id + priority ladder so the planner
      // dispatches them in order as ships arrive at each waypoint.
      const chainId = `txc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      const ships = { [ship]: shipCount };
      // v0.0.466: moon-source deuterium reserve (operator 2026-05-29 "从月球
      // 装载资源的时候留500000重氢在月球上"). When the resource source body
      // is a moon, automatically cap deuterium cargo to leave 500k on the
      // moon — moons don't produce, those 500k are the recall-fuel +
      // JG-cooldown safety reserve. Doesn't touch planet-sourced d.
      const resourceSourceId = resourceSrc ?? source;
      const resourceSourceP = planetsMap[resourceSourceId];
      const MOON_SOURCE_D_RESERVE = 500_000;   // 月球出发, 留 500K 应急 (operator 2026-05-29 拍板, 不变)
      const MOON_TARGET_D_BUFFER = 50_000;     // v0.0.505 — operator 2026-05-30: 500K 太多, 改 50K
      // v0.0.494 — TARGET 月球时加 buffer 给到货后做 build 留底。
      let cargoDFinal = cargoD;
      if (targetPlanet?.type === "moon") {
        cargoDFinal += MOON_TARGET_D_BUFFER;
      }
      if (resourceSourceP?.type === "moon") {
        const sourceD = (resourceSourceP as { resources?: { d?: number } }).resources?.d ?? 0;
        const sourceDMax = Math.max(0, sourceD - MOON_SOURCE_D_RESERVE);
        cargoDFinal = Math.min(cargoDFinal, sourceDMax);
      }
      const cargo = { m: cargoM, c: cargoC, d: cargoDFinal };
      // Find moon siblings (operator 2026-05-29 spec uses JG between sibling moons).
      const findSiblingMoon = (planetId: string): StorePlanet | undefined => {
        const p = planetsMap[planetId];
        if (!p?.coords) return undefined;
        const key = p.coords.join(":");
        return Object.values(planetsMap).find((q): q is StorePlanet => q?.type === "moon" && Array.isArray(q.coords) && q.coords.join(":") === key);
      };
      const sourceP = planetsMap[source];
      const resourceP = resourceSrc ? planetsMap[resourceSrc] : sourceP;
      const goalBodies: Array<{ type: string; target: Record<string, unknown>; planet?: string; priority?: number }> = [];
      // v0.0.425: factor the chain into a `genFerry` helper so every leg of
      // movement (source→resource, resource→target, target→stopover) uses
      // the same JG-aware decision: when JG is enabled AND both endpoints
      // have a sibling moon at their own coords, emit a 3-leg ferry
      // (planet→moon local deploy, moon→moon jumpgate, moon→planet local
      // deploy). Otherwise emit a single direct hop. Fixes operator's
      // 2026-05-29 report where Leg 1 was a sublight cross-system deploy.
      const genFerry = (
        fromId: string,
        toId: string,
        carryCargo: boolean,
        finalLegType: "deploy" | "transport",
        phasePrefix: string,
        basePriority: number,
      ): typeof goalBodies => {
        const fromP = planetsMap[fromId];
        const toP = planetsMap[toId];
        if (!fromP || !toP || fromP.id === toP.id) return [];
        const fromCoords = (fromP.coords ?? []).join(":");
        const toCoords = (toP.coords ?? []).join(":");
        // v0.0.462: same-coord shortcut (operator 2026-05-29 "运到本星球的
        // 月球 任务规划的不对"). When fromCoords === toCoords (planet↔moon
        // at same G:S:P), there's no long-distance to bridge — JG hop would
        // be moon→itself (nonsense). Emit ONE direct deploy and bail out
        // before the JG-vs-direct decision.
        if (fromCoords && fromCoords === toCoords) {
          return [{
            type: finalLegType,
            target: { target_coords: toCoords, target_type: toP.type ?? "planet", ships, cargo: carryCargo ? cargo : undefined, source_planet: fromP.id, chain_id: chainId, chain_phase: `${phasePrefix}_local` },
            planet: fromP.id, priority: basePriority,
          }];
        }
        const fromMoon = findSiblingMoon(fromP.id);
        const toMoon = findSiblingMoon(toP.id);
        // Operator 2026-05-29 rule: JG can only carry EMPTY ships. When this
        // segment is hauling cargo, force the direct sublight hop regardless
        // of whether both endpoints have moons.
        const useJgHere = jgEnabled && !!fromMoon && !!toMoon && !carryCargo;
        const cargoArg = carryCargo ? cargo : undefined;
        if (useJgHere && fromMoon && toMoon) {
          const fromMoonCoords = (fromMoon.coords ?? []).join(":");
          // Leg A: planet → own moon (local micro-deploy, same coord). When
          // fromP IS ALREADY a moon (Seg 3 target→stopover where target=moon),
          // ships are already on the moon — Leg A would emit moon→itself
          // which sendFleet either rejects or fallback-rewrites to planet,
          // causing a duplicate of the Seg 2 cargo fleet. Skip Leg A in this
          // case. (operator 2026-05-30 — saw 2 fleets 殖民 3:260:9 → 月球
          // 1:486:7 24s apart; Seg 3 leg A was the second fleet.)
          const legs: typeof goalBodies = [];
          if (fromP.type !== "moon") {
            legs.push({ type: "deploy",
              target: { target_coords: fromMoonCoords, target_type: "moon", ships, cargo: cargoArg, source_planet: fromP.id, chain_id: chainId, chain_phase: `${phasePrefix}_load` },
              planet: fromP.id, priority: basePriority });
          }
          // Leg B: moon → moon (jumpgate hop).
          legs.push({ type: "jumpgate",
            // v0.0.468: take_all is now per-chain (modal checkbox). When
            // true, planner reads source moon's current ships at dispatch
            // time and sweeps EVERYTHING. When false, only the configured
            // ships count flies through JG.
            target: { source_moon: fromMoon.id, target_moon: toMoon.id, ships, take_all: jgTakeAll, chain_id: chainId, chain_phase: `${phasePrefix}_hop` },
            planet: fromMoon.id, priority: basePriority - 1 });
          // Leg C: moon → planet at destination (local micro-deploy). Skip
          // symmetrically when toP IS already a moon (ships stay on moon).
          if (toP.type !== "moon") {
            legs.push({ type: "deploy",
              target: { target_coords: toCoords, target_type: toP.type ?? "planet", ships, cargo: cargoArg, source_planet: toMoon.id, chain_id: chainId, chain_phase: `${phasePrefix}_unload` },
              planet: toMoon.id, priority: basePriority - 2 });
          }
          return legs;
        }
        // Direct sublight hop — single goal. fromCoords is for debug only
        // (target stores planet-id refs that resolveCoord can pretty-print).
        void fromCoords;
        return [
          { type: finalLegType,
            target: { target_coords: toCoords, target_type: toP.type ?? "planet", ships, cargo: cargoArg, source_planet: fromP.id, chain_id: chainId, chain_phase: `${phasePrefix}_direct` },
            planet: fromP.id, priority: basePriority },
        ];
      };
      // Segment 1: source → resource (ferry empty ships into position).
      // Skipped when source == resource (ships already at resource).
      if (resourceP && sourceP && resourceP.id !== sourceP.id) {
        goalBodies.push(...genFerry(sourceP.id, resourceP.id, false, "deploy", "ferry_to_res", 12));
      }
      // Segment 2: resource → target (carries cargo). Always fires.
      // v0.0.465: operator 2026-05-29 rule "运输里面不要有运输 全部都用部署".
      // Changed from "transport" (mission=3, ships return) to "deploy"
      // (mission=4, ships stay). Whole chain now uses deploy consistently —
      // ships propagate along the path, no return leg. cargo still goes.
      const launchPlanetId = resourceP?.id ?? source;
      goalBodies.push(...genFerry(launchPlanetId, target, true, "deploy", "to_target", 9));
      // Segment 3: target → stopover (empty ferry post-unload), optional.
      const stopover = m.querySelector<HTMLInputElement>('input[name="tr-stopover-radio"]:checked')?.value ?? "";
      if (stopover && stopover !== target) {
        goalBodies.push(...genFerry(target, stopover, false, "deploy", "to_stop", 6));
      }
      if (status) { status.textContent = `creating ${goalBodies.length} goal(s)…`; status.style.color = "#7080a0"; }
      try {
        const ids: string[] = [];
        for (const body of goalBodies) {
          const r = await fetchFn(`${baseUrl}/ogamex/v1/goals/create`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
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
    //      "源地址和船所在的星球地址 用我的当前星球"). Set .checked = true
    //      WITHOUT firing change event — the change handler auto-fills
    //      cargo from resource planet's stockpile, which would overwrite
    //      the shortage cargo we want.
    //   ③ cargo inputs filled with shortage amounts
    //   ④ call updateShipCount() so 大运数量 auto-computes (input event
    //      doesn't fire when setting .value programmatically).
    // Source ships planet auto-defaults to current planet via the
    // existing tr-source-radio default-checked logic.
    if (prefill?.targetPlanetId) {
      // v0.0.522 — goals 的 → 运输 按钮过来时, prefill.targetPlanetId 可能
      // 是 moon (lunarBase / jumpgate goal). 之前只 setChecked 但 type toggle
      // 默认 "星球" → moon radio 在隐藏 section, submit 读不到正确 body。
      // 现在: 判 target body 的 type → 切 target type toggle 到对应 mode → 再 set radio。
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
        // v0.0.522 — 同 v0.0.521, 资源 radio 在 hidden moon section 时切 type toggle
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
      // v0.0.541 — operator 2026-05-31 "建筑任务里面点运输以后,所需资源
      // 没有正确填入". Bug: 旧逻辑 if (X > 0) 只覆盖正值, X=0 时保留 boot 块
      // 填的"当前星球库存"残留 → shortage 只缺 c 时, m/d 输入框还是当前
      // 星球的 m/d 库存, 操作员看到的"所需资源"跟实际填的对不上.
      // 修法: 显式按 prefill.cargo 三件都写, 0 就是 0; 同步把 cargoEnable
      // checkbox 在该资源 == 0 时取消, 不勾不装船 (跟 v0.0.531 配套).
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
    // v0.0.522 — prefill 来源是 goals "→ 运输" 按钮 (有 targetPlanetId), 这意味着
    // 操作员要 ship → 目标, 跟"同上"语义不冲突, resource 仍然 = ship 默认对。
    // 但 stopover shortcut 默认 ship 也对 (operator 想运到目标, 然后船回舰船星球
    // 是合理的)。 这里不强制改 shortcut, 让 v0.0.518 默认 = ship 生效。
  });
}

export function startGoalsPanel(opts: GoalsPanelOptions = {}): GoalsPanelHandle {
  const doc = opts.doc ?? document;
  const fetchFn = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const baseUrl = opts.httpBaseUrl ?? "https://ogame.anyfq.com";
  const pollMs = opts.pollMs ?? 3000;
  const showTerminal = opts.showTerminal ?? false;

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
    } catch { /* sidecar down or CORS — keep button hidden */ }
  };
  void checkRuntimeUpdate();
  const updateCheckTimer = setInterval(() => { void checkRuntimeUpdate(); }, 60_000);

  // Local-storage helpers — persist position + collapse state across page
  // reloads so the operator's preferred layout sticks.
  const LS_POS_KEY = "ogamex.panel.pos";
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
  // v0.0.487 accordion — operator 2026-05-30 "panel goals 全部展开太长了, 改
  // 成手风琴". Only one goal expanded at a time; click row header to toggle.
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
  // Operator 2026-05-26: "panel 菜单 默认都是收起的". One-time migration:
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
  // (meta[name="ogame-planet-id"]). operator 切星球时资源自动刷新. 一旦 operator
  // 手动改 dropdown → autoFollow=false, planet 锁定. 重置 autoFollow 通过再次
  // 选中"= ogame 当前" (UI暂不暴露, 默认就是自动).
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
    const r = await fetchFn(`${baseUrl}/ogamex/v1/goals`);
    if (!r.ok) throw new Error(`http ${r.status}`);
    const body = await r.json() as { goals: GoalRowFromHttp[] };
    return body.goals;
  }

  interface EmergencyPayload {
    hostile: Array<{ id: string; type: string; arrives_at: number; eta_in_seconds: number; from: string | null; to: string | null; ships_count: number | "?"; }>;
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
      const r = await fetchFn(`${baseUrl}/ogamex/v1/emergency`);
      if (!r.ok) return null;
      const body = await r.json() as Partial<EmergencyPayload>;
      // Validate shape — tests / stale stubs may return wrong objects.
      if (!Array.isArray(body.hostile)) return null;
      return body as EmergencyPayload;
    } catch { return null; }
  }
  async function fetchExpedition(): Promise<ExpeditionPayload | null> {
    try {
      const r = await fetchFn(`${baseUrl}/ogamex/v1/expedition`);
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
    const r = await fetchFn(`${baseUrl}/ogamex/v1/goals/${encodeURIComponent(id)}/${action}`, { method: "POST" });
    if (!r.ok) {
      const body = await r.text();
      throw new Error(`${action} failed: http ${r.status} ${body}`);
    }
  }

  function isPaused(g: GoalRowFromHttp): boolean {
    return g.status === "blocked" && (g.reason ?? "").startsWith("PAUSED");
  }

  // v0.0.474: derive panel display status from goal status+reason+type.
  // Operator 2026-05-30: "停下的时候不要都显示block 添加 building reseaching
  // 可以反映真实的状态". Maps raw "blocked" + reason text into specific
  // sub-states so operator can see WHY a goal isn't progressing at a glance.
  function deriveDisplayStatus(g: GoalRowFromHttp, allGoals: GoalRowFromHttp[] = []): { label: string; color: string } {
    // v0.0.484 — operator 2026-05-30 "统一检查所有任务状态". Single unified
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
    const stepLabel = cs ? `${cs.tech} L${cs.level}` : "";
    const now = Date.now();

    // L1
    if (isPaused(g)) return { label: "paused", color: "#8a8aff" };
    // L2 — body's ogame queue is ground truth FOR BUILD/RESEARCH FAMILY ONLY.
    // v0.0.510 — operator 2026-05-31: deploy/transport/jumpgate chain leg
    // 误显示 "building <body's tech>" 因为 body_build_q 跟 deploy 语义无关。
    // fleet/jg goals 走自己 status 路径, 不蹭 body 的 build_q。
    const isBuildFamily = goalType === "build" || goalType === "build_universal"
      || goalType === "research" || goalType === "build_ships" || goalType === "build_defense"
      || goalType === "lifeform_building";
    const bq = g.body_build_q;
    if (isBuildFamily && bq && bq.ends_at > now) {
      const lvLabel = bq.level !== null && bq.level !== undefined ? ` L${bq.level}` : "";
      const etaMin = Math.max(0, Math.round((bq.ends_at - now) / 60_000));
      const queueLabel = bq.queue === "lf_build" ? "building (lifeform)" : bq.queue === "shipyard" ? "constructing" : "building";
      return { label: `${queueLabel} ${bq.tech}${lvLabel} (~${etaMin}m)`, color: "#7cfc00" };
    }
    // L3 — planner's eta_at for this goal's tech is in the future
    if (typeof g.eta_at === "number" && g.eta_at > now) {
      const slot = cs ? stepLabel : "in queue";
      if (cs?.kind === "research") return { label: `researching ${slot}`, color: "#7cc0ff" };
      if (goalType === "build_ships" || goalType === "build_defense") return { label: `building ships`, color: "#7cfc00" };
      if (goalType === "lifeform_building") return { label: `building (lifeform) ${slot}`, color: "#7cfc00" };
      return { label: `building ${slot}`, color: "#7cfc00" };
    }
    // L4 — active status without eta_at (fleet ops or initial dispatch)
    if (g.status === "active") {
      if (goalType === "research") return { label: cs ? `researching ${stepLabel}` : "researching", color: "#7cc0ff" };
      if (goalType === "build" || goalType === "build_universal") return { label: cs ? `building ${stepLabel}` : "building", color: "#7cfc00" };
      if (goalType === "build_ships" || goalType === "build_defense") return { label: "constructing ships", color: "#7cfc00" };
      if (goalType === "lifeform_building") return { label: cs ? `building (lifeform) ${stepLabel}` : "building (lifeform)", color: "#7cfc00" };
      if (goalType === "expedition") return { label: "expedition flying", color: "#80c0ff" };
      if (goalType === "colonize") return { label: "colonizing", color: "#80c0ff" };
      if (goalType === "deploy") return { label: "deploying", color: "#80c0ff" };
      if (goalType === "transport") return { label: "transporting", color: "#80c0ff" };
      if (goalType === "jumpgate") return { label: "jumping", color: "#80c0ff" };
      return { label: "active", color: "#7cfc00" };
    }
    // L5 + L6 — blocked on resources. Use current_step for specificity.
    // Body has no production (moon or 0-prod planet) → must be operator-fed
    // via transport. Body has production → just waiting for natural fill.
    const csShortageSum = cs ? cs.shortage.m + cs.shortage.c + cs.shortage.d : 0;
    const goalShortage = g.resource_shortage;
    const hasShortage = csShortageSum > 0 || !!(goalShortage && (goalShortage.m + goalShortage.c + goalShortage.d) > 0);
    const subtreeEta = g.prereq_tree?.subtree_eta_seconds ?? 0;
    if (g.status === "blocked" && hasShortage && /waiting.*resources|waiting \d+s for resources/i.test(reason)) {
      const target = cs ? stepLabel : "";
      // L5 — no local production → awaiting transport
      if (subtreeEta <= 0) {
        return { label: target ? `awaiting transport · ${target}` : "awaiting transport", color: "#ffaa55" };
      }
      // L6 — has production, just need to fill up
      return { label: target ? `waiting resources · ${target}` : "waiting resources", color: "#ff9b6b" };
    }
    // L7 — same slot-family sibling currently building (queued behind)
    const slotFamily = (gg: GoalRowFromHttp): string | null => {
      const t = gg.type;
      if (t === "research") return "research:*";
      if (t === "build_ships" || t === "build_defense") return gg.planet ? `shipyard:${gg.planet}` : null;
      if (t === "lifeform_building") return gg.planet ? `lf:${gg.planet}` : null;
      if (t === "build" || t === "build_universal") return gg.planet ? `build:${gg.planet}` : null;
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
        const sibLabel = sib ? `${sib.tech} L${sib.level}` : sibling.type;
        const etaMin = Math.max(0, Math.round(((sibling.eta_at ?? 0) - now) / 60_000));
        return { label: `queued · waiting ${sibLabel} (~${etaMin}m)`, color: "#bdb76b" };
      }
    }
    // L8 — blocked with other reason patterns
    if (g.status === "blocked") {
      if (/build slot.*in use|shipyard slot.*in use|research slot.*in use|lf build slot.*in use/i.test(reason)) return { label: "queued (slot busy)", color: "#bdb76b" };
      if (/moon fields nearly full/i.test(reason)) return { label: "fields full → LB", color: "#ff9b6b" };
      if (/chain prereq.*waiting/i.test(reason)) return { label: "chain wait", color: "#bdb76b" };
      if (/has \d+× .*, need \d+|insufficient.*ship|0× .*, need/i.test(reason)) return { label: "ships short", color: "#ff9b6b" };
      if (/expedition slots full|fleet slots full|early skip, not queued/i.test(reason)) return { label: "slots full", color: "#bdb76b" };
      if (/storage.*insufficient|insufficient.*storage|倉存容量不足|仓存容量不足|140028/i.test(reason)) return { label: "dest storage full", color: "#ff9b6b" };
      if (/transient race|140043|請稍後再試|请稍后再试|try again later/i.test(reason)) return { label: "ogame race, retrying", color: "#bdb76b" };
      if (/100001|未知的錯誤|未知的错误/i.test(reason)) return { label: "ogame error 100001", color: "#ff6b6b" };
      if (/120023|沒有空間|没有空间|月球上.*空間|月球上.*空间/i.test(reason)) return { label: "moon space full", color: "#ff6b6b" };
      if (/cooldown.*remaining/i.test(reason)) return { label: "cooldown", color: "#bdb76b" };
      if (/jumpgate.*not on moon|missing source_moon|missing target_moon/i.test(reason)) return { label: "JG misconfig", color: "#ff6b6b" };
      if (/planet-only building.*cannot.*moon|moon-only building.*cannot.*planet/i.test(reason)) return { label: "body type mismatch", color: "#ff6b6b" };
      if (/awaiting.*event|awaiting empire_poll|awaiting operator_retry/i.test(reason)) return { label: "awaiting event", color: "#80c0ff" };
      return { label: "blocked", color: "#bdb76b" };
    }
    if (g.status === "pending") return { label: "pending", color: "#80c0ff" };
    if (g.status === "completed") return { label: "completed", color: "#888" };
    if (g.status === "cancelled") return { label: "cancelled", color: "#888" };
    return { label: g.status, color: "#ccc" };
  }

  // v0.0.526 — operator 2026-05-31 "这部分为什么不折叠?". 翻转默认:
  // tree node 默认全部折叠, 点击 chevron 才展开 (而不是默认全展开)。
  // treeExpanded Set 装当前展开的 node key, 没在 set 里的就是折叠。
  const treeExpanded = new Set<string>();
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

  function renderTreeNode(n: PrereqTreeNode, depth = 0): string {
    const indent = depth * 14;
    const hasChildren = n.children.length > 0;
    const key = treeKey(n);
    const collapsed = !treeExpanded.has(key); // v0.0.526 默认折叠
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
    // Per-node ETA badge — show subtree total (rolled-up) on parents and
    // self ETA on leaves. Hidden when the node is met (no work left).
    const subtreeEta = n.subtree_eta_seconds ?? 0;
    const etaBadge = (n.met || subtreeEta <= 0)
      ? ""
      : `<span style="color:#8090a8; font-size:10px; margin-left:4px;" title="time to complete this branch (serial)">⏱ ${fmtSeconds(subtreeEta)}</span>`;
    const me = `
      <div style="padding:2px 0 2px ${indent}px; font-size:11px; color:${techColor}; display:flex; align-items:center; gap:4px;">
        ${chev}<span>${kindIcon}</span>
        <span style="flex:1;">${escapeHtml(n.tech)} <span style="color:#8090a8;">(${levelStr})</span>${etaBadge}</span>
        ${statusBadge}
      </div>`;
    const kids = hasChildren && !collapsed
      ? n.children.map((c) => renderTreeNode(c, depth + 1)).join("")
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
          const b = String(target["building"] ?? "?");
          const lvl = target["target_level"] ?? target["level"] ?? "";
          return [planetTag, b, lvl].filter(Boolean).join(" ");
        }
        case "research": {
          const t = String(target["tech"] ?? "?");
          const lvl = target["target_level"] ?? target["level"] ?? "";
          return [t, lvl].filter(Boolean).join(" ");
        }
        case "build_ships": {
          const s = String(target["ship"] ?? "?");
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
    // synthetic "🚚 运输 chain" parent row, with each leg shown as a
    // compact "* G:S:P → G:S:P 部署/跳跃/运输" line.
    const chainStoreRef = (window as Window & { __ogamexStore?: { state?: { planets?: Record<string, { id?: string; coords?: number[] }> } } }).__ogamexStore;
    const planetCoordMap = chainStoreRef?.state?.planets ?? {};
    const resolveCoord = (idOrCoord: string): string => {
      if (!idOrCoord) return "?";
      if (/^\d+:\d+:\d+$/.test(idOrCoord)) return idOrCoord;
      const p = planetCoordMap[idOrCoord];
      return p?.coords ? p.coords.join(":") : idOrCoord;
    };
    const actionCN = (type: string): string =>
      type === "deploy" ? "部署"
      : type === "jumpgate" ? "跳跃"
      : type === "transport" ? "运输"
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
      const isMain = g.is_main_goal === true;
      const derived = deriveDisplayStatus(g, goals);
      const displayStatus = derived.label;
      const color = derived.color;
      const reasonLine = g.reason ? `<div style="color:#a0a0a0; font-size:10px; margin-top:2px;">↳ ${escapeHtml(g.reason)}</div>` : "";
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
        ? `<button data-action-resume="${escapeHtml(g.id)}" style="${btnStyle("#205a40", "#408a60")}" title="clear awaiting + immediate re-dispatch">↻ Retry</button>`
        : "";
      // Active / pending → Pause + Cancel. Paused → Resume + Cancel.
      const pauseOrResume = !canAct ? ""
        : paused
          ? `<button data-action-resume="${escapeHtml(g.id)}" style="${btnStyle("#205a20", "#408a40")}">Resume</button>`
          : `<button data-action-pause="${escapeHtml(g.id)}" style="${btnStyle("#5a4a20", "#8a7a40")}">Pause</button>`;
      const cancelBtn = canAct
        ? `<button data-action-cancel="${escapeHtml(g.id)}" style="${btnStyle("#5a2020", "#8a4040")}">Cancel</button>`
        : "";
      // Set/unset Main button — only on non-terminal goals.
      const mainBtn = canAct
        ? (isMain
            ? `<button data-action-unset-main="${escapeHtml(g.id)}" style="${btnStyle("#3a3a5a", "#6a6a8a")}" title="Clear main flag">★ Unset</button>`
            : `<button data-action-set-main="${escapeHtml(g.id)}" style="${btnStyle("#5a5a20", "#8a8a40")}" title="Mark as main objective">★ Set</button>`)
        : "";
      // Row background tint for the main goal so it pops visually.
      const mainBg = isMain ? "background:rgba(218,165,32,0.08); " : "";
      const mainStar = isMain ? `<span style="color:#ffd700; font-size:12px;" title="main objective">⭐</span> ` : "";
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
            const sh = g.resource_shortage;
            const shortageChip = sh && (sh.m + sh.c + sh.d) > 0
              ? `<span style="color:#ff9b6b; font-size:10px; margin-left:6px;" title="假设当前产能不变, 这是还需要从其他星球 transport 进来的资源总量">缺 ${sh.m > 0 ? `${fmtRes(sh.m)} m` : ""}${sh.c > 0 ? `${sh.m > 0 ? " · " : ""}${fmtRes(sh.c)} c` : ""}${sh.d > 0 ? `${(sh.m + sh.c) > 0 ? " · " : ""}${fmtRes(sh.d)} d` : ""}</span><button data-action-fill-shortage="${escapeHtml(g.id)}" data-fill-target="${escapeHtml(g.planet ?? "")}" data-fill-building="${escapeHtml(String((g.target as { building?: unknown })?.building ?? ""))}" data-fill-m="${Math.ceil(sh.m)}" data-fill-c="${Math.ceil(sh.c)}" data-fill-d="${Math.ceil(sh.d)}" style="${btnStyle("#205a40", "#408a60")} margin-left:6px; font-size:10px; padding:1px 6px;" title="打开运输 modal 自动填写目的+资源 (源=当前星球)">→ 运输</button>`
              : "";
            // v0.0.456: decouple shortageChip from totalEta — moons return
            // ETA=∞ (no local production for deuterium etc.), JSON serializes
            // to null, ?? 0 collapses to 0, fallback path was hiding the
            // shortage chip + 运输 button. Render shortage whenever it's
            // positive regardless of whether ETA is computable.
            const hasShortage = sh && (sh.m + sh.c + sh.d) > 0;
            // v0.0.486 — if body's build_q is currently building the
            // deepest-unmet step (current_step), no need to show "awaiting
            // transport" or shortage chip — that step's resources have
            // already been paid. Replace with "building <step>" + ETA from
            // ogame queue.
            const cs2 = g.current_step;
            const bqMatchesCS_outer = cs2 && g.body_build_q
              && g.body_build_q.tech === cs2.tech
              && g.body_build_q.level === cs2.level
              && g.body_build_q.ends_at > Date.now();
            const etaHeader = bqMatchesCS_outer
              ? `<span style="color:#7cfc00;">building ${escapeHtml(cs2.tech)} L${cs2.level} (~${fmtSeconds(Math.floor((g.body_build_q!.ends_at - Date.now())/1000))})</span>`
              : totalEta > 0
                ? `<span style="color:#ffd700;">ETA ≈ ${fmtSeconds(totalEta)}</span>${shortageChip}`
                : hasShortage
                  ? `<span style="color:#ffaa55;">awaiting transport (ETA n/a — moon local prod = 0)</span>${shortageChip}`
                  : `<span style="color:#7cfc00;">all prereqs met — can execute now</span>`;
            // v0.0.461: current-step row — "↳ 当前步骤: lunarBase L4 缺 ..."
            // separate line below the chain summary so operator sees what
            // the bot is RIGHT NOW trying to fire, and how short on cash.
            const cs = g.current_step;
            const csLine = cs ? (() => {
              const csh = cs.shortage;
              const csTotal = csh.m + csh.c + csh.d;
              const stepLabel = `${cs.tech} L${cs.level}`;
              // v0.0.486 — operator 2026-05-30: jumpgate L1 已在 build_q,
              // current_step 还说"缺 X 资源"是逻辑错。 当 body_build_q 跟
              // current_step 同 tech+level → 这级钱已付, 不再 emit 缺口,
              // 改显示"在造中, ~Xm 后完工"。
              const bqMatchesCS = g.body_build_q
                && g.body_build_q.tech === cs.tech
                && g.body_build_q.level === cs.level
                && g.body_build_q.ends_at > Date.now();
              if (bqMatchesCS) {
                const etaMin = Math.max(0, Math.round((g.body_build_q!.ends_at - Date.now()) / 60_000));
                return `<div style="font-size:10px; color:#7cfc00; margin-bottom:2px;">↳ 当前: ${escapeHtml(stepLabel)} · 🏗 在造中 (~${etaMin}m 完工)</div>`;
              }
              if (csTotal === 0) {
                return `<div style="font-size:10px; color:#7cfc00; margin-bottom:2px;">↳ 当前: ${escapeHtml(stepLabel)} · ✅ 资源够, 立即可派</div>`;
              }
              const shortageBits = [
                csh.m > 0 ? `${fmtRes(csh.m)} m` : "",
                csh.c > 0 ? `${fmtRes(csh.c)} c` : "",
                csh.d > 0 ? `${fmtRes(csh.d)} d` : "",
              ].filter(Boolean).join(" · ");
              const stepFillBtn = `<button data-action-fill-shortage="${escapeHtml(g.id)}" data-fill-target="${escapeHtml(g.planet ?? "")}" data-fill-building="${escapeHtml(cs.tech)}" data-fill-m="${Math.ceil(csh.m)}" data-fill-c="${Math.ceil(csh.c)}" data-fill-d="${Math.ceil(csh.d)}" style="${btnStyle("#205a40", "#408a60")} margin-left:6px; font-size:10px; padding:1px 6px;" title="按当前步骤缺口装运">→ 运输</button>`;
              return `<div style="font-size:10px; color:#ffaa55; margin-bottom:2px;">↳ 当前: ${escapeHtml(stepLabel)} 缺 ${shortageBits}${stepFillBtn}</div>`;
            })() : "";
            // v0.0.527 — operator 2026-05-31 "前置链都要归入主链 tree".
            // 去掉独立 "prereq chain" label, etaHeader 直接挂在 tree 顶部,
            // 整段就是这一个 goal 的主链 (前置 + 当前 step + 自身).
            return `<div style="margin-top:6px; padding:4px 0 2px; border-top:1px dashed #2a3a52;">
              <div style="font-size:10px; color:#8090a8; margin-bottom:2px;">${etaHeader}</div>
              ${csLine}
              ${renderTreeNode(g.prereq_tree)}
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
      // v0.0.488 — operator 2026-05-30 "bar 上要显示星球坐标". Coord shows
      // inline on the bar even when collapsed, so operator can scan moons
      // without expanding.
      const isExpanded = expandedGoalId === g.id;
      const chevron = `<span style="color:#8090a8; font-size:10px; width:10px; display:inline-block; user-select:none;">${isExpanded ? "▾" : "▸"}</span>`;
      const coordChip = g.planet
        ? `<span style="color:#a0b0c8; font-size:10px; margin-left:4px;" title="${escapeHtml(g.planet)}">@${escapeHtml(g.planet)}</span>`
        : "";
      const detailBlock = isExpanded
        ? `${reasonLine}${treeHtml}`
        : "";
      return `
        <div style="${mainBg}border-top: 1px solid #2a3a52; padding: 6px 0;">
          <div data-action-toggle-expand="${escapeHtml(g.id)}" style="display:flex; align-items:center; gap:6px; justify-content:space-between; cursor:pointer;" title="${isExpanded ? "点击折叠" : "点击展开详情"}">
            <span>${chevron}${mainStar}${optIcon}<span style="color:${color}; font-weight:bold;">${escapeHtml(displayStatus)}</span>${coordChip}${etaAtBadge}${awaitingChip}</span>
            <span style="color:#8090a8; font-size:10px;">P${g.priority}</span>
            <span style="display:flex; gap:4px; flex-wrap:wrap;" data-stop-toggle="1">${retryBtn}${mainBtn}${pauseOrResume}${cancelBtn}</span>
          </div>
          <div data-action-toggle-expand="${escapeHtml(g.id)}" style="margin-top:2px; cursor:pointer;"><strong style="color:#e0e8f0;">${escapeHtml(g.type)}</strong> ${escapeHtml(targetStr)}</div>
          ${detailBlock}
        </div>`;
    };
    // Chain child row — compact format with leg index + prerequisite hint.
    const renderChainChildRow = (g: GoalRowFromHttp, idx: number, prevType: string | null, paused: boolean): string => {
      const leg = formatChainLeg(g);
      const canAct = g.status === "pending" || g.status === "active" || g.status === "blocked";
      const cancelBtn = canAct
        ? `<button data-action-cancel="${escapeHtml(g.id)}" style="${btnStyle("#5a2020", "#8a4040")}">Cancel</button>`
        : "";
      const derivedLeg = deriveDisplayStatus(g);
      const color = derivedLeg.color;
      const displayStatus = derivedLeg.label;
      const prereq = idx === 0
        ? `<span style="color:#7cfc00; font-size:10px;">(无前置 · 立即派遣)</span>`
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
              <span style="color:#80ffd0; font-weight:bold;">🚚 运输 chain</span>
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
      const body = renderSingleGoalRow(g);
      const childRows = (childrenByParent.get(g.id) ?? [])
        .map((c) => `<div style="margin-left:${indent + 16}px; border-left:2px solid #3a4a60; padding-left:6px;"><span style="color:#80a8d0; font-size:10px;">↳ sub</span>${renderWithChildren(c, depth + 1)}</div>`)
        .join("");
      if (depth === 0) {
        return childRows ? body + childRows : body;
      }
      return body + childRows;
    };
    const singletonRows = singletonsTopLevel.map((g) => renderWithChildren(g, 0)).join("");
    const rows = chainBlocks.join("") + singletonRows;
    // v0.0.529 — operator 2026-05-31 "把运输任务从 goals 移到这里 (cargo 位置)".
    // 拆 rows: 运输系 (deploy/transport/jumpgate, 含 chain) 单独到 cargoSection,
    // 其它 (build/research/expedition 等) 留在 goalsSection.
    const isTransportType = (t: string): boolean => t === "deploy" || t === "transport" || t === "jumpgate";
    const transportChainBlocks_v529: string[] = [];
    const restChainBlocks_v529: string[] = [];
    for (const [cid, members] of chainGroups) {
      const isTransport = members.some(g => isTransportType(g.type));
      const bucket = isTransport ? transportChainBlocks_v529 : restChainBlocks_v529;
      bucket.push(renderChainParent(cid, members));
      members.forEach((g, idx) => {
        bucket.push(renderChainChildRow(g, idx, members[idx - 1]?.type ?? null, isPaused(g)));
      });
    }
    const transportSingletonsHtml_v529 = singletonsTopLevel.filter(g => isTransportType(g.type)).map(g => renderWithChildren(g, 0)).join("");
    const restSingletonsHtml_v529 = singletonsTopLevel.filter(g => !isTransportType(g.type)).map(g => renderWithChildren(g, 0)).join("");
    const transportRowsHtml_v529 = transportChainBlocks_v529.join("") + transportSingletonsHtml_v529;
    const restRowsHtml_v529 = restChainBlocks_v529.join("") + restSingletonsHtml_v529;
    const transportGoalCount_v529 = filtered.filter(g => isTransportType(g.type)).length;
    const restGoalCount_v529 = filtered.length - transportGoalCount_v529;
    // Header is the drag handle (cursor:move). Collapse button toggles the
    // body. Close removes the panel entirely.
    // Operator 2026-05-29 "panel 名称改成 oGame+版本号 添加按钮更新版本":
    // title shows current runtime version, update button hidden by default,
    // shown when latestRuntimeVersion (polled from sidecar) > currentVersion.
    const currentVersion = ((typeof window !== "undefined" ? window : globalThis) as { __ogamexVersion?: string }).__ogamexVersion ?? "?";
    const latestVersion = ((typeof window !== "undefined" ? window : globalThis) as { __ogamexLatestVersion?: string }).__ogamexLatestVersion ?? "";
    const hasUpdate = latestVersion !== "" && latestVersion !== currentVersion && cmpSemver(latestVersion, currentVersion) > 0;
    const updateBtn = hasUpdate
      ? `<button data-action="update-runtime" style="background:#205a20; color:#fff; border:1px solid #408a40; padding:1px 6px; border-radius:3px; cursor:pointer; font-size:10px;" title="新版 v${escapeHtml(latestVersion)} 可用 — 点击安装">🔄 v${escapeHtml(latestVersion)}</button>`
      : "";
    const header = `
      <div data-ogamex-drag="1" style="display:flex; align-items:center; justify-content:space-between; padding-bottom:4px; cursor:move; user-select:none;">
        <strong style="color:#e0e8f0;">🪐 oGame v${escapeHtml(currentVersion)}</strong>
        <span style="display:flex; gap:4px; align-items:center;">
          ${updateBtn}
          <button data-action="collapse" style="background:transparent; color:#8090a8; border:none; cursor:pointer; font-size:14px; padding:0 4px;" title="${collapsed ? "Expand" : "Collapse"}">${collapsed ? "▸" : "▾"}</button>
          <button data-action="close" style="background:transparent; color:#8090a8; border:none; cursor:pointer; font-size:14px; padding:0 4px;" title="Close (panel will re-mount on next page load)">×</button>
        </span>
      </div>
      <div style="color:#8090a8; font-size:10px;">${filtered.length} active${err ? ` — ${escapeHtml(err)}` : ""}</div>`;
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
        <span style="color:#a0a8b8;">侦察 → 紧急起飞</span>
        <button data-spy-save-toggle="1" style="${spySaveOn ? btnStyle("#205a20", "#408a40") : btnStyle("#5a2020", "#8a4040")}">${spySaveOn ? "ON" : "OFF"}</button>
      </div>`;
    const emRows = !emCollapsed && lastEmergency
      ? (emCount === 0
          ? `<div style="color:#666; font-size:10px; padding:2px 0;">(no hostile incoming)</div>${spyToggleRow}`
          : lastEmergency.hostile.map((h) => `
              <div style="font-size:11px; padding:3px 0; border-top:1px solid #2a2a3a;">
                <div style="display:flex; gap:6px; justify-content:space-between;">
                  <span style="color:#ff6b6b; font-weight:bold;">${escapeHtml(h.type)}</span>
                  <span style="color:#ff9b9b;">${fmtEta(h.eta_in_seconds)}</span>
                </div>
                <div style="color:#a0a8b8; font-size:10px;">${escapeHtml(h.from ?? "?")} → ${escapeHtml(h.to ?? "?")} · ships=${escapeHtml(String(h.ships_count))}</div>
              </div>`).join("") + spyToggleRow)
      : "";
    // Operator 2026-05-29: ⚙️ button opens emergency-specific settings modal.
    // Per "每个功能用自己的设置页面" — section header gets a per-feature
    // settings button instead of a global "AI 设置" tab.
    const emSettingsBtn = `<button data-settings="emergency" style="background:transparent; color:#8090a8; border:none; cursor:pointer; font-size:13px; padding:0 4px;" title="紧急任务设置">⚙</button>`;
    const emergencySection = `${sectionHeader("emergency", "🚨 Emergency", emCount, emColor, emSettingsBtn)}<div style="display:${emCollapsed ? "none" : "block"};">${emRows}</div>`;

    // Expedition section
    const exCollapsed = sectionCollapsed.expedition;
    const ex = lastExpedition;
    const exLabel = ex
      ? (ex.state_ready === false
          ? `🛸 Expeditions —/— (state loading…)`
          : `🛸 Expeditions ${ex.used}/${ex.max} (astro ${ex.astrophysics_level})`)
      : "🛸 Expeditions";
    const exRows = !exCollapsed && ex
      ? (ex.active.length === 0
          ? `<div style="color:#666; font-size:10px; padding:2px 0;">(no expeditions in flight)</div>`
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
    const exSettingsBtn = `<button data-settings="expedition" style="background:transparent; color:#8090a8; border:none; cursor:pointer; font-size:13px; padding:0 4px;" title="远征任务设置">⚙</button>`;
    const expeditionSection = `${sectionHeader("expedition", exLabel, ex?.active.length ?? 0, "#8a8aff", exSettingsBtn)}<div style="display:${exCollapsed ? "none" : "block"};">${exRows}</div>`;

    // Goals section — wraps existing goal rows with a collapsible header.
    const goalsCollapsed = sectionCollapsed.goals;
    const goalsBody = !goalsCollapsed ? `${empty}${rows}` : "";
    // M4 — Goals section ⚙ → openGoalsSettings modal (create new goal form).
    const goalsSettingsBtn = `<button data-settings="goals" style="background:transparent; color:#8090a8; border:none; cursor:pointer; font-size:13px; padding:0 4px;" title="普通任务设置 — 创建新任务">⚙</button>`;
    // v0.0.460: awaiting count badge — operator sees at a glance how many
    // goals are quiet because they're waiting for empire_poll / operator_retry.
    const awaitingCount = filtered.filter((g) => g.status === "blocked" && Array.isArray(g.awaiting_events) && g.awaiting_events.length > 0).length;
    const awaitingBadge = awaitingCount > 0
      ? `<span style="color:#80c0ff; font-size:10px; background:#1a3a5a; padding:1px 6px; border-radius:8px; margin-left:6px;" title="goals quietly waiting for an event before next dispatch attempt">⏸ ${awaitingCount} awaiting</span>`
      : "";
    // v0.0.529 — goalsSection 只装非运输 goals (运输移到 cargoSection)
    const goalsBody_v529 = !goalsCollapsed ? `${empty}${restRowsHtml_v529}` : "";
    const goalsSection = `${sectionHeader("goals", "🪐 Goals", restGoalCount_v529, "#e0e8f0", awaitingBadge + goalsSettingsBtn)}<div style="display:${goalsCollapsed ? "none" : "block"};">${goalsBody_v529}</div>`;

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
    // Operator 2026-05-23: "发现的 stop 按钮放上一层 位置类似于远征" —
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
    const discSettingsBtn = `<button data-settings="discovery" style="background:transparent; color:#8090a8; border:none; cursor:pointer; font-size:13px; padding:0 4px;" title="发现任务设置">⚙</button>`;
    const discSection = `${sectionHeader("discovery", "🧬 Discovery", activeDisc ? 1 : 0, "#c080ff", `${discHeaderBtn}${discSettingsBtn}`)}<div style="display:${discCollapsed ? "none" : "block"};">${discBody}</div>`;

    // Jumpgate cooldown per moon — operator 2026-05-26:
    //   "在月球上显示，跳跃门冷却时间" + "ready 的不用显示，只显示倒计时的，
    //    时间加上秒 mm:ss"
    // Lazy computation: live remaining = max(0, snapshot - (now - harvestedAt)).
    // 1-second ticker (#jg-cd-N spans) updates display without re-rendering whole panel.
    let moonsSection = "";
    try {
      const st = (window as Window & { __ogamexStore?: { state: { planets?: Record<string, { id?: string; type?: string; coords?: number[]; buildings?: Record<string, number | undefined>; jumpgate_cooldown_sec?: number | null; jumpgate_harvested_at?: number | null; jumpgate_pair_with?: string | null }> } } }).__ogamexStore;
      const planets = st?.state?.planets ?? {};
      const now = Date.now();
      // v0.0.514 — operator 2026-05-31 "应该有 4 个月球倒计时, 只显示了 2 个".
      // 实证: 4 月球 pair_with 被 sniffer 抓到, 但只 3 cd_sec 被 overlay 拉取 (cp race).
      // Fallback: 用 localStorage OGAMEX_JUMPGATE_LOG 兜底, log 里 ts 30min 内
      // 的 src moon 即使 cd_sec=null 也按 1800-elapsed 估算显示。
      // (JG L1 cooldown ~30min, L2 24min, L3 20min...; 用 1800 L1 默认猜测)
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
      // v0.0.513 — operator 2026-05-31 "显示的月球不全". 改成显示**所有有 JG 建筑**的月球
      // (建造了 jumpgate L≥1 都列出), 无冷却的显示 "ready" 绿色, 有冷却的显示 mm:ss 黄。
      // 排序按 G:S:P, 2 列布局不变。
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
      // v0.0.517 — operator 2026-05-31 "不要显示 ready". 只渲染有真 cooldown
      // 的月球。 cd_sec 没值但 log 30min 内有记录的, 按 1800 fallback 显示。
      const FALLBACK_JG_CD_SEC = 1800; // JG L1 默认 30 min; 真值 hydrate 后覆盖
      const cells: string[] = [];
      for (const { id, p } of allJgMoons) {
        let cd = p.jumpgate_cooldown_sec ?? 0;
        let at = p.jumpgate_harvested_at ?? now;
        // Fallback: 没 cd_sec 但 log 30min 内有记录 → 按 (1800 - elapsed) 估算
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
        if (remain <= 0) continue; // ready 不显示
        const mm = Math.floor(remain / 60);
        const ss = remain % 60;
        const coordsThis = (p.coords ?? []).join(":");
        cells.push(`<div style="flex:0 0 50%; padding:2px 4px; box-sizing:border-box; color:#c0d0e0; font-size:11px;">🌙 [${coordsThis}]/<span class="jg-cd" data-snap="${cd}" data-at="${at}" style="color:#bdb76b;">${mm}:${ss.toString().padStart(2, "0")}</span></div>`);
      }
      const pairRows: string[] = cells.length > 0
        ? [`<div style="display:flex; flex-wrap:wrap;">${cells.join("")}</div>`]
        : [];
      if (cells.length > 0) {
        // v0.0.513 — section header 计数显示 monn 总数 (有 JG 的), 之前是
        // pair-row 数会被误以为"很少"。
        // v0.0.528 — operator 2026-05-31 "Moons/JumpGate 无法折叠".
        // 之前 body 写死 display:block (源于 v0.0.??? "force expand" hack),
        // 现在尊重 sectionCollapsed.moons 状态, 跟其他 section 一致。
        const moonsBodyDisp = sectionCollapsed.moons ? "none" : "block";
        moonsSection = `${sectionHeader("moons", "🌙 Moons / Jumpgate", cells.length, "#80c0ff", "")}<div style="display:${moonsBodyDisp};">${pairRows.join("")}</div>`;
      }
      console.info(`[panel/moons] render allJgMoons=${allJgMoons.length} cells=${cells.length}`);
    } catch (e) { console.warn("[panel/moons] render failed:", e); }

    // Cargo calculator section — operator 2026-05-26:
    //   "1 选择星球 2 选择运输舰类型 LC/SC 3 checkbox 列出星球三种资源
    //    自动算需要的战舰数量 点击复制到剪贴板"
    let cargoSection = "";
    try {
      const st = (window as Window & { __ogamexStore?: { state: { planets?: Record<string, { id?: string; coords?: number[]; name?: string; resources?: { m?: number; c?: number; d?: number }; type?: string }>; server?: { ship_cargo_capacity?: Record<string, number> } } } }).__ogamexStore;
      const planets = Object.values(st?.state?.planets ?? {})
        // Operator 2026-05-26: "删除里面的月球，只显示星球" — Cargo Calc 拉资源
        // 来源限定 planets (月球通常无资源生产), 简化 dropdown 选择.
        .filter((p) => Array.isArray(p.coords) && p.coords.length === 3 && p.type === "planet")
        .sort((a, b) => (a.coords![0]! - b.coords![0]!) || (a.coords![1]! - b.coords![1]!) || (a.coords![2]! - b.coords![2]!));
      // Auto-follow ogame's active planet (meta) — operator 2026-05-26:
      // "切换星球，资源没有刷新". When autoFollow=true, cargoState.planetId
      // tracks the currently-visible planet so resources update immediately
      // as operator clicks between planets in ogame's sidebar.
      const ogameCurrentPid = doc.querySelector<HTMLMetaElement>('meta[name="ogame-planet-id"]')?.content ?? "";
      if (cargoState.autoFollow && ogameCurrentPid && planets.find((p) => p.id === ogameCurrentPid)) {
        cargoState.planetId = ogameCurrentPid;
      }
      const selectedId = cargoState.planetId && planets.find((p) => p.id === cargoState.planetId) ? cargoState.planetId : (planets[0]?.id ?? "");
      cargoState.planetId = selectedId;
      const planetOptsCargo = planets.map((p) =>
        // 只显示坐标 (operator 2026-05-26): planets only, 不含 moon, 不带后缀.
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
      const cargoSettingsBtn = `<button data-settings="transport" style="background:transparent; color:#8090a8; border:none; cursor:pointer; font-size:13px; padding:0 4px;" title="运输设置">⚙</button>`;
      // v0.0.529 — operator 2026-05-31 "这部分不要了, 把运输任务从 goals 移到这里".
      // 旧的 Cargo Calc UI (Planet 选择 / SC|LC / M C D / Need / Deploy→Moon)
      // 全删, cargo section header 改成 "🚚 运输任务" + 装 transportRowsHtml.
      // ⚙ 按钮保留 (跳到 transport modal 创建新运输任务).
      // 静默引用以保留 lbl 等闭包变量, 不致 TS 误报 unused.
      void planetOptsCargo; void m; void c; void d; void total; void cap; void shipsNeeded; void lbl; void selected;
      cargoSection = `${sectionHeader("cargo", "🚚 运输任务", transportGoalCount_v529, "#80ffd0", cargoSettingsBtn)}<div style="display:${cargoCollapsed ? "none" : "block"};">${transportRowsHtml_v529}</div>`;
    } catch { /* no store yet */ }

    const body = `<div data-ogamex-body="1" style="display:${bodyDisplay};">${emergencySection}${expeditionSection}${discSection}${moonsSection}${cargoSection}${goalsSection}</div>`;
    panel.innerHTML = header + body;
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
            method: "POST", headers: { "Content-Type": "application/json" },
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
        await fetchFn(`${baseUrl}/ogamex/v1/goals/${encodeURIComponent(gid)}/cancel`, { method: "POST" });
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
      // Operator 2026-05-26: "改行为为部署这些船到本星球的月球". 直接 ajax
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
        const t = e.target as HTMLElement;
        if (t.closest("[data-pause-daemon]") || t.closest("[data-action]")) return;
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
        // Operator 2026-05-26: emergency (FS) 是 frontend FSM, sidecar 没
        // /ogamex/v1/emergency/pause 端点 → 404. localStorage toggle 即可,
        // orchestrator handleThreat 读这个 flag 决定是否 skip.
        if (daemon === "emergency") {
          console.info(`[panel] emergency ${action} — localStorage flag set, orchestrator will honor`);
          return;
        }
        try {
          // Operator 2026-05-26: "远征 stop 按钮无效" — sidecar pause/resume
          // 端点在 auth-required block, panel POST 没带 bearer → 401 拒绝.
          // Fix: 带 bearer token (same as bridge). 同时 sidecar 那边 endpoint
          // 也移到 public block (双保险).
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
    // v0.0.449: shortage-chip → 运输 button. Opens transport modal with
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
        // the "→ 运输" shortcut on a moon goal (lunarBase / jumpgate /
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
        // v0.0.526 — toggle in treeExpanded (默认折叠语义)
        if (treeExpanded.has(key)) treeExpanded.delete(key);
        else treeExpanded.add(key);
        if (lastGoals) render(lastGoals);
      });
    }
    const closeBtn = panel.querySelector<HTMLElement>("[data-action=\"close\"]");
    closeBtn?.addEventListener("click", () => stop());

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
      // Avoid full refetch — toggle body display + chevron in place.
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
  // Operator 2026-05-24: "为啥没听到声音报警".
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
      let t = ctx.currentTime;
      for (const freq of tones) {
        if (freq === 0) { t += stepMs / 1000; continue; }
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "square";
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, t);
        gain.gain.exponentialRampToValueAtTime(0.35, t + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + (stepMs - 20) / 1000);
        osc.connect(gain).connect(ctx.destination);
        osc.start(t);
        osc.stop(t + stepMs / 1000);
        t += stepMs / 1000;
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

  function schedule(): void {
    if (stopped) return;
    timer = setTimeout(async () => {
      await refresh();
      schedule();
    }, pollMs);
  }

  // 1Hz ticker — updates jumpgate mm:ss countdowns in place without full
  // panel re-render. Reads each .jg-cd span's snapshot value + harvested_at
  // and recomputes remaining seconds. Hides span when remaining hits 0.
  let jgTickerId: ReturnType<typeof setInterval> | null = setInterval(() => {
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
        // v0.0.517 — operator 2026-05-31 "不要显示 ready": cooldown 到 0 →
        // 隐藏该 cell (operator 不想看 ready 行)。
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
    if (jgTickerId) { clearInterval(jgTickerId); jgTickerId = null; }
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
