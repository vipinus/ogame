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
  prereq_tree?: PrereqTreeNode | null;
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
    { key: "smallCargo",     label: "小型運輸艦 (ST)" },
    { key: "largeCargo",     label: "大型運輸艦 (LT)" },
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
    const planets = Object.values(storeRef?.state?.planets ?? {})
      .filter((p): p is StorePlanet => !!p?.coords)
      .sort((a, b) => {
        const ac = a.coords ?? [0, 0, 0]; const bc = b.coords ?? [0, 0, 0];
        for (let i = 0; i < 3; i++) {
          const av = ac[i] ?? 0; const bv = bc[i] ?? 0;
          if (av !== bv) return av - bv;
        }
        // planet before moon at same coords
        if (a.type !== b.type) return a.type === "planet" ? -1 : 1;
        return 0;
      });
    const planetOpts = `<option value="">(不指定 — 让 planner 默认 planet[0])</option>` + planets.map((p) => {
      const cs = (p.coords ?? []).join(":");
      const tag = p.type === "moon" ? "🌙" : "🌍";
      return `<option value="${escapeHtml(p.id)}">${tag} ${escapeHtml(p.name ?? "?")} [${escapeHtml(cs)}]</option>`;
    }).join("");
    const typeOpts = GOAL_PRESETS.map((g) => `<option value="${escapeHtml(g.value)}">${escapeHtml(g.label)}</option>`).join("");
    const inputStyle = "background:#0a1018; color:#e0e8f0; border:1px solid #2a3a52; border-radius:3px; padding:3px 6px; font-size:11px;";
    body.innerHTML = `
      <div style="color:#7080a0; font-size:11px; padding-bottom:6px;">普通任务 — 创建 build / research / colonize / 等任务. 已有 active goals 在主面板 Goals section 显示</div>
      <div style="padding:8px 10px; background:#0a1018; border:1px solid #2a3a52; border-radius:4px;">
        <div style="display:flex; gap:8px; align-items:center; padding:6px 0;">
          <span style="color:#d0d8e0; font-size:11px; width:80px;">任务类型</span>
          <select data-goal-type style="${inputStyle} flex:1;">${typeOpts}</select>
        </div>
        <div style="display:flex; gap:8px; align-items:center; padding:6px 0;">
          <span style="color:#d0d8e0; font-size:11px; width:80px;">星球</span>
          <select data-goal-planet style="${inputStyle} flex:1;">${planetOpts}</select>
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
    `;
    // Sync textarea placeholder with selected type.
    const typeSel = m.querySelector<HTMLSelectElement>("[data-goal-type]");
    const targetTa = m.querySelector<HTMLTextAreaElement>("[data-goal-target]");
    const targetHint = m.querySelector<HTMLElement>("[data-goal-target-hint]");
    const planetSel = m.querySelector<HTMLSelectElement>("[data-goal-planet]");
    const refreshPreset = (): void => {
      const t = typeSel?.value ?? "";
      const preset = GOAL_PRESETS.find((p) => p.value === t);
      if (!preset || !targetTa || !targetHint || !planetSel) return;
      targetTa.value = preset.targetPlaceholder;
      targetHint.textContent = preset.planetReq ? "需要选 planet — 该类型必须指定 source" : "可不选 planet — planner 会默认或读 target 内字段";
    };
    typeSel?.addEventListener("change", refreshPreset);
    refreshPreset();
    m.querySelector<HTMLElement>("[data-goal-create]")?.addEventListener("click", async () => {
      const status = m.querySelector<HTMLElement>("[data-goal-status]");
      const type = typeSel?.value ?? "";
      const planet = planetSel?.value || undefined;
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
      if (status) { status.textContent = "creating…"; status.style.color = "#7080a0"; }
      try {
        const r = await fetchFn(`${baseUrl}/ogamex/v1/goals/create`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type, target, planet, priority }),
        });
        if (!r.ok) {
          const j = await r.json().catch(() => ({ reason: `HTTP ${r.status}` })) as { reason?: string };
          throw new Error(j.reason ?? `HTTP ${r.status}`);
        }
        const j = await r.json() as { ok?: boolean; goal_id?: string; reason?: string };
        if (!j.ok) throw new Error(j.reason ?? "create rejected");
        if (status) { status.textContent = `✓ created ${j.goal_id ?? ""}`; status.style.color = "#7cfc00"; }
        setTimeout(() => m.remove(), 800);
      } catch (e) {
        if (status) { status.textContent = `× ${(e as Error).message}`; status.style.color = "#ff6b6b"; }
      }
    });
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

  // Tree-collapsed state — keyed by node "tech:targetLevel" so persists
  // across re-renders during the same panel session.
  const treeCollapsed = new Set<string>();
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
    const collapsed = treeCollapsed.has(key);
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
    const filtered = showTerminal
      ? goals
      : goals.filter((g) => g.status !== "completed" && g.status !== "cancelled");
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
    const rows = filtered.map((g) => {
      const targetStr = fmtTarget(g.type, g.target as Record<string, unknown>);
      const paused = isPaused(g);
      const isMain = g.is_main_goal === true;
      const displayStatus = paused ? "paused" : g.status;
      const color = paused ? "#8a8aff" : (statusColor[g.status] ?? "#ccc");
      const reasonLine = g.reason ? `<div style="color:#a0a0a0; font-size:10px; margin-top:2px;">↳ ${escapeHtml(g.reason)}</div>` : "";
      const canAct = g.status === "pending" || g.status === "active" || g.status === "blocked";
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
            const etaHeader = totalEta > 0
              ? `<span style="color:#ffd700;">ETA ≈ ${fmtSeconds(totalEta)}</span>`
              : `<span style="color:#7cfc00;">all prereqs met — can execute now</span>`;
            return `<div style="margin-top:6px; padding:4px 0 2px; border-top:1px dashed #2a3a52;">
              <div style="font-size:10px; color:#8090a8; margin-bottom:2px;">prereq chain · ${etaHeader}</div>
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
      return `
        <div style="${mainBg}border-top: 1px solid #2a3a52; padding: 6px 0;">
          <div style="display:flex; align-items:center; gap:6px; justify-content:space-between;">
            <span>${mainStar}${optIcon}<span style="color:${color}; font-weight:bold;">${escapeHtml(displayStatus)}</span>${etaAtBadge}</span>
            <span style="color:#8090a8; font-size:10px;">P${g.priority}</span>
            <span style="display:flex; gap:4px; flex-wrap:wrap;">${mainBtn}${pauseOrResume}${cancelBtn}</span>
          </div>
          <div style="margin-top:2px;"><strong style="color:#e0e8f0;">${escapeHtml(g.type)}</strong> ${escapeHtml(targetStr)}</div>
          ${g.planet ? `<div style="color:#8090a8; font-size:10px;">@ ${escapeHtml(g.planet)}</div>` : ""}
          ${reasonLine}
          ${treeHtml}
        </div>`;
    }).join("");
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
    const goalsSection = `${sectionHeader("goals", "🪐 Goals", filtered.length, "#e0e8f0", goalsSettingsBtn)}<div style="display:${goalsCollapsed ? "none" : "block"};">${goalsBody}</div>`;

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
      const st = (window as Window & { __ogamexStore?: { state: { planets?: Record<string, { id?: string; type?: string; coords?: number[]; jumpgate_cooldown_sec?: number | null; jumpgate_harvested_at?: number | null; jumpgate_pair_with?: string | null }> } } }).__ogamexStore;
      const planets = st?.state?.planets ?? {};
      const now = Date.now();
      // Pair grouping — operator 2026-05-27 "JG都是成对使用 显示改成 [源]/[目标] mm:ss".
      // Walk moons with active cooldown; for each, emit at most ONE row per pair
      // (skip when the partner has already been rendered). Sort by remaining
      // cooldown so 即将冷却完的排上面.
      const activeMoons = Object.entries(planets)
        .filter(([_id, p]) => {
          if (p.type !== "moon" || typeof p.jumpgate_cooldown_sec !== "number") return false;
          const cd = p.jumpgate_cooldown_sec ?? 0;
          const elapsed = Math.floor((now - (p.jumpgate_harvested_at ?? now)) / 1000);
          return Math.max(0, cd - elapsed) > 0;
        })
        .map(([id, p]) => ({ id, p, remain: Math.max(0, (p.jumpgate_cooldown_sec ?? 0) - Math.floor((now - (p.jumpgate_harvested_at ?? now)) / 1000)) }))
        .sort((a, b) => a.remain - b.remain);
      const rendered = new Set<string>();
      const pairRows: string[] = [];
      for (const { id, p } of activeMoons) {
        if (rendered.has(id)) continue;
        const partnerId = p.jumpgate_pair_with ?? null;
        const partner = partnerId ? planets[partnerId] : null;
        const cd = p.jumpgate_cooldown_sec ?? 0;
        const at = p.jumpgate_harvested_at ?? now;
        const elapsed = Math.floor((now - at) / 1000);
        const remain = Math.max(0, cd - elapsed);
        const mm = Math.floor(remain / 60);
        const ss = remain % 60;
        const coordsThis = (p.coords ?? []).join(":");
        // Operator 2026-05-27: "JG都是成对使用 显示改成 源/目的 成对显示".
        // 没 pair_with (harvest-derived) → 显示 [?] 明确表示 target 未知,
        // 而非误导用户以为单边即冷却.
        const label = partner
          ? `[${coordsThis}]/[${(partner.coords ?? []).join(":")}]`
          : `[${coordsThis}]/[?]`;
        pairRows.push(`<div style="padding:2px 0; color:#c0d0e0; font-size:11px;">🌙 ${label} JG: <span class="jg-cd" data-snap="${cd}" data-at="${at}" style="color:#bdb76b;">${mm}:${ss.toString().padStart(2, "0")}</span></div>`);
        rendered.add(id);
        if (partnerId) rendered.add(partnerId);  // suppress partner's own row
      }
      if (pairRows.length > 0) {
        // Operator 2026-05-27: 第一次跳完 panel 没显示 — 因为 sectionCollapsed
        // .moons 默认 true (折叠). data 已塞进 HTML 字符串但 display:none. 这里
        // 显式 force expand: 任何冷却中的月球都让用户看到, 否则模块跟没存在一样.
        moonsSection = `${sectionHeader("moons", "🌙 Moons / Jumpgate", pairRows.length, "#80c0ff", "")}<div style="display:block;">${pairRows.join("")}</div>`;
      }
      // Operator 2026-05-27: 第一次跳完 panel 没显示 — log render path
      // empirics 给我看 activeMoons / pairRows 实际长度
      console.info(`[panel/moons] render activeMoons=${activeMoons.length} pairRows=${pairRows.length} moonsSection.length=${moonsSection.length}`);
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
      cargoSection = `${sectionHeader("cargo", "🧮 Cargo Calc", shipsNeeded, "#80ffd0", "")}
<div style="display:${cargoCollapsed ? "none" : "block"}; padding:6px 10px; color:#c0d0e0; font-size:11px;">
  <div style="margin-bottom:4px;">
    Planet: <select data-action="cargo-planet" style="background:#1a2330; color:#c0d0e0; border:1px solid #354050; width:auto;">${planetOptsCargo}</select>
    <button data-action="cargo-auto" title="${cargoState.autoFollow ? "Auto-follow ON — tracks ogame current planet" : "Manual — click to re-enable auto-follow"}" style="background:${cargoState.autoFollow ? "#205a40" : "#2a3a52"}; color:#fff; border:1px solid ${cargoState.autoFollow ? "#408a60" : "#354050"}; padding:1px 5px; border-radius:3px; cursor:pointer; font-size:10px; margin-left:4px;">${cargoState.autoFollow ? "🔁 Auto" : "🔒 Lock"}</button>
  </div>
  <div style="margin-bottom:4px;">
    Ship:
    <label style="margin-right:8px;"><input type="radio" name="cargo-ship" value="smallCargo" data-action="cargo-ship" ${cargoState.ship === "smallCargo" ? "checked" : ""}> SC (${lbl((st?.state?.server?.ship_cargo_capacity ?? {}).smallCargo ?? 5000)})</label>
    <label><input type="radio" name="cargo-ship" value="largeCargo" data-action="cargo-ship" ${cargoState.ship === "largeCargo" ? "checked" : ""}> LC (${lbl((st?.state?.server?.ship_cargo_capacity ?? {}).largeCargo ?? 25000)})</label>
  </div>
  <div style="margin-bottom:4px;">
    <label style="margin-right:6px;"><input type="checkbox" data-action="cargo-m" ${cargoState.use.m ? "checked" : ""}> M ${lbl(m)}</label>
    <label style="margin-right:6px;"><input type="checkbox" data-action="cargo-c" ${cargoState.use.c ? "checked" : ""}> C ${lbl(c)}</label>
    <label><input type="checkbox" data-action="cargo-d" ${cargoState.use.d ? "checked" : ""}> D ${lbl(d)}</label>
  </div>
  <div style="display:flex; align-items:center; gap:6px;">
    <span>Need: <span data-cargo-need style="color:#7cfc00; font-weight:bold; font-size:13px;">${lbl(shipsNeeded)}</span> ${cargoState.ship === "smallCargo" ? "SC" : "LC"}</span>
    <button data-action="cargo-fill" title="Deploy ships from current planet to its moon (same coords, mission=4)" style="background:#205a80; color:#fff; border:1px solid #408aa0; padding:2px 8px; border-radius:3px; cursor:pointer; font-size:10px;">🚀 Deploy→Moon</button>
    <span data-cargo-copied style="color:#7cfc00; font-size:10px; display:none;">✓ deployed</span>
  </div>
  <div style="color:#6a7080; font-size:10px; margin-top:2px;">total=${lbl(total)} ÷ cap=${lbl(cap)} = ${lbl(shipsNeeded)} ship${shipsNeeded === 1 ? "" : "s"}</div>
</div>`;
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
    // Prereq tree toggles — flip per-node collapse state + re-render the
    // current goals snapshot (no refetch).
    for (const el of panel.querySelectorAll<HTMLElement>("[data-tree-toggle]")) {
      el.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const key = el.getAttribute("data-tree-toggle");
        if (!key) return;
        if (treeCollapsed.has(key)) treeCollapsed.delete(key);
        else treeCollapsed.add(key);
        // Cheap re-render: use the last fetched goals list rather than
        // hitting the network again.
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
