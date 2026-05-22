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
  is_main_goal?: boolean;
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

export function startGoalsPanel(opts: GoalsPanelOptions = {}): GoalsPanelHandle {
  const doc = opts.doc ?? document;
  const fetchFn = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const baseUrl = opts.httpBaseUrl ?? "https://ogame.anyfq.com";
  const pollMs = opts.pollMs ?? 3000;
  const showTerminal = opts.showTerminal ?? false;

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
  const sectionCollapsed: Record<string, boolean> = {
    emergency: loadJSON<boolean>("ogamex.panel.section.emergency", false),
    expedition: loadJSON<boolean>("ogamex.panel.section.expedition", false),
    goals: loadJSON<boolean>("ogamex.panel.section.goals", false),
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
    const header = `
      <div data-ogamex-drag="1" style="display:flex; align-items:center; justify-content:space-between; padding-bottom:4px; cursor:move; user-select:none;">
        <strong style="color:#e0e8f0;">🪐 OgameX goals</strong>
        <span style="display:flex; gap:4px;">
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
    const sectionHeader = (name: string, label: string, count: number, accentColor: string): string => {
      const c = sectionCollapsed[name];
      // Optional pause toggle button (only emergency/expedition).
      const pauseable = name === "emergency" || name === "expedition";
      const paused = pauseable ? loadJSON<boolean>(`ogamex.${name}.paused`, false) : false;
      const pauseBtn = pauseable
        ? `<button data-pause-daemon="${escapeHtml(name)}" style="background:transparent; color:${paused ? "#ffaa55" : "#7080a0"}; border:1px solid ${paused ? "#aa6622" : "#3a3a5a"}; border-radius:3px; cursor:pointer; font-size:10px; padding:1px 5px;" title="${paused ? "Resume daemon" : "Pause daemon"}">${paused ? "▶" : "⏸"}</button>`
        : "";
      return `<div data-section-toggle="${escapeHtml(name)}" style="display:flex; align-items:center; gap:6px; cursor:pointer; padding:4px 0; user-select:none; border-top:1px solid #2a3a52;">
        <span style="color:#8090a8; width:12px;">${c ? "▸" : "▾"}</span>
        <strong style="color:${accentColor}; font-size:11px; flex:1;">${escapeHtml(label)}</strong>
        <span style="color:#8090a8; font-size:10px;">${count}</span>
        ${pauseBtn}
      </div>`;
    };

    // Emergency section
    const emCollapsed = sectionCollapsed.emergency;
    const emCount = lastEmergency?.count ?? 0;
    const emColor = emCount > 0 ? "#ff6b6b" : "#7080a0";
    const emRows = !emCollapsed && lastEmergency
      ? (emCount === 0
          ? `<div style="color:#666; font-size:10px; padding:2px 0;">(no hostile incoming)</div>`
          : lastEmergency.hostile.map((h) => `
              <div style="font-size:11px; padding:3px 0; border-top:1px solid #2a2a3a;">
                <div style="display:flex; gap:6px; justify-content:space-between;">
                  <span style="color:#ff6b6b; font-weight:bold;">${escapeHtml(h.type)}</span>
                  <span style="color:#ff9b9b;">${fmtEta(h.eta_in_seconds)}</span>
                </div>
                <div style="color:#a0a8b8; font-size:10px;">${escapeHtml(h.from ?? "?")} → ${escapeHtml(h.to ?? "?")} · ships=${escapeHtml(String(h.ships_count))}</div>
              </div>`).join(""))
      : "";
    const emergencySection = `${sectionHeader("emergency", "🚨 Emergency", emCount, emColor)}<div style="display:${emCollapsed ? "none" : "block"};">${emRows}</div>`;

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
    const expeditionSection = `${sectionHeader("expedition", exLabel, ex?.active.length ?? 0, "#8a8aff")}<div style="display:${exCollapsed ? "none" : "block"};">${exRows}</div>`;

    // Goals section — wraps existing goal rows with a collapsible header.
    const goalsCollapsed = sectionCollapsed.goals;
    const goalsBody = !goalsCollapsed ? `${empty}${rows}` : "";
    const goalsSection = `${sectionHeader("goals", "🪐 Goals", filtered.length, "#e0e8f0")}<div style="display:${goalsCollapsed ? "none" : "block"};">${goalsBody}</div>`;

    const body = `<div data-ogamex-body="1" style="display:${bodyDisplay};">${emergencySection}${expeditionSection}${goalsSection}</div>`;
    panel.innerHTML = header + body;
    // Wire section collapse toggles.
    for (const el of panel.querySelectorAll<HTMLElement>("[data-section-toggle]")) {
      el.addEventListener("click", (e) => {
        // Don't toggle collapse if click landed on the pause button.
        if ((e.target as HTMLElement).closest("[data-pause-daemon]")) return;
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
        try {
          await fetchFn(`${baseUrl}/ogamex/v1/${daemon}/${action}`, { method: "POST" });
        } catch (err) {
          btn.textContent = wasPaused ? "▶" : "⏸";
          btn.title = "ERR: " + (err as Error).message;
          saveJSON(`ogamex.${daemon}.paused`, wasPaused);
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

  // Track event IDs we've already alerted on, so re-fetching the same
  // hostile entry doesn't re-trigger the audio/visual alarm every 3s.
  const alertedIds = new Set<string>();

  // Audio: Web Audio API generates a beep — no asset file shipped.
  // Different patterns for spy (single tone) vs attack (3 fast tones).
  function playAlarm(severity: "spy" | "attack"): void {
    try {
      const w = doc.defaultView as Window & { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
      const Ctor = w.AudioContext ?? w.webkitAudioContext;
      if (!Ctor) return;
      const ctx = new Ctor();
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
      // Close ctx after a small grace to free audio resources.
      setTimeout(() => { try { void ctx.close(); } catch { /* */ } }, (stepMs * tones.length) + 500);
    } catch { /* audio blocked → silently skip */ }
  }

  // Visual: flash panel border red for severity-keyed duration.
  let flashTimer: ReturnType<typeof setTimeout> | null = null;
  function flashPanel(severity: "spy" | "attack"): void {
    const panel = doc.getElementById("ogamex-goals-panel");
    if (!panel) return;
    const color = severity === "attack" ? "#ff2020" : "#ffaa20";
    const durationMs = severity === "attack" ? 8000 : 4000;
    panel.style.boxShadow = `0 0 24px 6px ${color}, 0 0 4px 1px ${color} inset`;
    panel.style.borderColor = color;
    if (flashTimer !== null) clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
      panel.style.boxShadow = "";
      panel.style.borderColor = "";
      flashTimer = null;
    }, durationMs);
  }

  function fireAlertsForNew(em: EmergencyPayload | null): void {
    if (!em || !Array.isArray(em.hostile)) return;
    let newAttack = false, newSpy = false;
    for (const h of em.hostile) {
      if (alertedIds.has(h.id)) continue;
      alertedIds.add(h.id);
      if (h.type === "attack") newAttack = true;
      else if (h.type === "spy") newSpy = true;
    }
    // Attack takes priority — louder/longer.
    if (newAttack) { playAlarm("attack"); flashPanel("attack"); }
    else if (newSpy) { playAlarm("spy"); flashPanel("spy"); }
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
      fireAlertsForNew(emergency);
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

  function stop(): void {
    stopped = true;
    if (timer) clearTimeout(timer);
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
