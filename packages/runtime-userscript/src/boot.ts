import type { WorldState } from "@ogamex/shared";
import { EventBus } from "./event_bus.js";
import { StateStore } from "./state_store.js";
import type { IndexedKv } from "./store/indexed_db.js";
import { initSafeFetch, fetchWithCp, BusyDeferredError } from "./api/safe_fetch.js";
import { setLocaleDocSource } from "./i18n/locale.js";
import { t } from "./i18n/t.js";
import { startMutationObserver } from "./probes/mutation_observer.js";
import { installXhrHook } from "./probes/xhr_hook.js";
import {
  extractResources,
  extractStorage,
  extractProduction,
  extractLifeformResources,
} from "./probes/extractors/resources.js";
import { extractIncomingEvents } from "./probes/extractors/events.js";
import { extractPlanets } from "./probes/extractors/planets.js";
import { extractTechLevels, extractTechLabels } from "./probes/extractors/buildings.js";
import { TECH_TREE, TECH_NAME_BY_ID, TECH_ID_BY_NAME, idKind, LIFEFORM_TECH, expeditionSlots } from "@ogamex/shared";
import { extractFleetMovements } from "./probes/extractors/fleet.js";
import { installEventBoxHook } from "./probes/eventbox_hook.js";
import { extractToken, type OgameWindow } from "./probes/extractors/token.js";

export interface BootEnv {
  doc: Document;
  win: Window;
  fetch?: typeof fetch;
  kv?: IndexedKv | null;
}

export interface BootSummary {
  resources_ok: boolean;
  storage_ok: boolean;
  production_ok: boolean;
  lifeform_resources_ok: boolean;
  events_count: number;
  planets_count: number;
  fleet_movements_count: number;
  token_present: boolean;
  ogame_meta: {
    universe?: string;
    universe_speed?: number;
    player_id?: string;
    player_name?: string;
    planet_coords?: string;
    alliance_tag?: string;
    is_vacation_mode?: boolean;
  };
}

export interface BootHandle {
  bus: EventBus;
  store: StateStore;
  summary: BootSummary;
  stop: () => void;
}

function readMeta(doc: Document, name: string): string | undefined {
  return doc.querySelector<HTMLMetaElement>(`meta[name="${name}"]`)?.content || undefined;
}

/**
 * Convert PlanetIdentity[] (extractor output) to Record<string, Planet>
 * (state shape, keyed by ogame planet id), preserving existing per-planet
 * data (buildings/ships/queues) where ids match, and synthesizing safe
 * defaults for fresh planets.
 *
 * Refactored 2026-05-21 from Array→Record. Callers spread the result
 * into state.planets so additional planets in existing (e.g. moons not in
 * the current planetList scrape) are NOT lost.
 */
/**
 * Race-safe planet identity merge (operator 2026-05-27: "不穩定" — full
 * planet-record overwrites raced against jumpgate cooldown writes).
 *
 * Returns ONLY per-planet identity patches (id/name/coords/type for existing,
 * full default record for new). Caller passes this to `store.setPlanetsPatch`
 * which spreads LIVE planet under the patch — preserving any concurrent
 * writes to other fields (jumpgate_cooldown_sec, etc.).
 */
function mergeWithExistingPlanets(
  ids: import("./probes/extractors/planets.js").PlanetIdentity[],
  existing: Record<string, import("@ogamex/shared").Planet>,
): Record<string, Partial<import("@ogamex/shared").Planet>> {
  const out: Record<string, Partial<import("@ogamex/shared").Planet>> = {};
  for (const p of ids) {
    if (existing[p.id]) {
      // Existing planet — patch ONLY identity fields. setPlanetsPatch will
      // overlay onto live state, preserving everything else (incl. jumpgate).
      out[p.id] = { id: p.id, name: p.name, coords: p.coords, type: p.type };
    } else {
      // New planet (first time seen) — full default record.
      out[p.id] = {
        ...p,
        resources: { m: 0, c: 0, d: 0, e: 0 },
        storage: { m_max: 0, c_max: 0, d_max: 0 },
        production: { m_h: 0, c_h: 0, d_h: 0 },
        buildings: {},
        build_q: null,
        shipyard_q: null,
        defense_q: null,
        ships: {},
        defense: {},
        lifeform: null,
      } as import("@ogamex/shared").Planet;
    }
  }
  return out;
}

function detectVacationMode(doc: Document): boolean {
  // The advice bar contains an icon with a title that includes t("auto.261") / "vacation mode"
  const banners = doc.querySelectorAll<HTMLElement>("#advice-bar [title]");
  for (const b of banners) {
    const txt = b.getAttribute("title") ?? "";
    if (txt.includes(t("auto.261")) || /vacation\s*mode/i.test(txt)) return true;
  }
  return false;
}

/**
 * Read current ogame page DOM for building / research levels, partition by
 * TECH_TREE kind, and merge into the right slots of state:
 *   - kind "building" → state.planets[activeIdx].buildings (active planet = the one
 *     whose id matches the <meta name="ogame-planet-id"> content)
 *   - kind "research" → state.research.levels (player-wide)
 *
 * Ship and defense kinds aren't extracted here (different DOM shape). Each
 * invocation is idempotent: missing tech ids just don't show up.
 */
function mergeTechLevels(doc: Document, store: StateStore): void {
  const levels = extractTechLevels(doc);
  // v0.0.615 — harvest localized labels from same DOM. Operator
  // 2026-06-01 "網頁上有名字" — ogame's title/aria-label is ground truth.
  const newLabels = extractTechLabels(doc);
  if (Object.keys(newLabels).length > 0) {
    const existing = (store.state as { tech_labels?: Record<string, string> }).tech_labels ?? {};
    let changed = false;
    for (const k of Object.keys(newLabels)) {
      if (existing[k] !== newLabels[k]) { changed = true; break; }
    }
    if (changed) {
      store.setPartial({ tech_labels: { ...existing, ...newLabels } } as Partial<typeof store.state>);
    }
  }
  if (Object.keys(levels).length === 0) return;
  const buildings: Record<string, number> = {};
  const research: Record<string, number> = {};
  const lifeformBuildings: Record<string, number> = {};
  // v0.0.616 — operator 2026-06-01 "不會後臺請求資料嗎?". Passive harvest
  // now buckets lifeform_research too. When operator visits any planet's
  // lfresearch page, env.doc reflects it; bucket the entries so the goals
  // panel sees data without re-fetch.
  const lifeformResearch: Record<string, number> = {};
  // Detect species from lifeform tech ID prefix:
  //   111xx = humans  121xx = rocktal  131xx = mechas  141xx = kaelesh
  let detectedSpecies: string | null = null;
  // Detect current page from <meta name=ogame-version>/<body> isn't reliable —
  // use the global `currentPage` var ogame sets (read via doc.defaultView).
  const docPage = (doc.defaultView as { currentPage?: string } | null)?.currentPage
    ?? doc.querySelector<HTMLMetaElement>('meta[name="ogame-page"]')?.content
    ?? "";
  const isLfResearchPage = docPage === "lfresearch";
  const isLfBuildingsPage = docPage === "lfbuildings";
  for (const [id, lvl] of Object.entries(levels)) {
    const techId = TECH_ID_BY_NAME[id];
    if (techId !== undefined && idKind(techId) === "lifeform_building") {
      lifeformBuildings[id] = lvl;
      if (lvl > 0 && detectedSpecies === null) {
        const prefix = Math.floor(techId / 1000);
        detectedSpecies = prefix === 11 ? "humans"
          : prefix === 12 ? "rocktal"
          : prefix === 13 ? "mechas"
          : prefix === 14 ? "kaelesh"
          : null;
      }
      continue;
    }
    if (techId !== undefined && idKind(techId) === "lifeform_research") {
      lifeformResearch[id] = lvl;
      continue;
    }
    // When on lfresearch page, ALL entries (even unmapped) are lf research.
    // Mirrors refreshOnePage's page-aware bucket so passive + active agree.
    if (isLfResearchPage) {
      lifeformResearch[id] = lvl;
      continue;
    }
    const entry = (TECH_TREE as Record<string, { kind: string }>)[id];
    if (!entry) continue;
    if (entry.kind === "building") buildings[id] = lvl;
    else if (entry.kind === "research") research[id] = lvl;
  }
  const cur = store.state;
  const patch: Partial<typeof cur> = {};
  // Merge buildings into the currently-active planet, identified by
  // <meta name="ogame-planet-id">. Without that meta we can't safely target.
  const activeIdRaw = doc.querySelector<HTMLMetaElement>("meta[name=\"ogame-planet-id\"]")?.content;
  const hasAnyTechData = Object.keys(buildings).length > 0
    || Object.keys(lifeformBuildings).length > 0
    || Object.keys(lifeformResearch).length > 0;
  if (hasAnyTechData && activeIdRaw && Object.keys(cur.planets).length > 0) {
    const existing = cur.planets[activeIdRaw];
    if (existing) {
      const mergedB: Record<string, number> = { ...(existing.buildings ?? {}) };
      for (const [k, v] of Object.entries(buildings)) {
        if (v >= (mergedB[k] ?? 0)) mergedB[k] = v;
      }
      // v0.0.620 — operator 2026-06-01 "已經切換了種族的星球老科技是無效
      // 的". On lfbuildings/lfresearch pages, ogame renders ONLY the
      // current-species set; that's the authoritative truth for THIS
      // planet at THIS moment. So REPLACE (not merge) — stale entries
      // from a previous species evict naturally.
      const existingLf = (existing as { lifeform_buildings?: Record<string, number> }).lifeform_buildings ?? {};
      let mergedLf: Record<string, number>;
      if (isLfBuildingsPage) {
        mergedLf = { ...lifeformBuildings };
      } else {
        mergedLf = { ...existingLf };
        for (const [k, v] of Object.entries(lifeformBuildings)) {
          if (v >= (mergedLf[k] ?? 0)) mergedLf[k] = v;
        }
      }
      const existingLfr = (existing as { lifeform_research?: Record<string, number> }).lifeform_research ?? {};
      let mergedLfr: Record<string, number>;
      if (isLfResearchPage) {
        mergedLfr = { ...lifeformResearch };
      } else {
        mergedLfr = { ...existingLfr };
        for (const [k, v] of Object.entries(lifeformResearch)) {
          if (v >= (mergedLfr[k] ?? 0)) mergedLfr[k] = v;
        }
      }
      const existingLfMeta = (existing as { lifeform?: { species?: string } | null }).lifeform ?? null;
      const lifeformPatch = detectedSpecies !== null && (existingLfMeta === null || existingLfMeta.species !== detectedSpecies)
        ? { lifeform: { ...(existingLfMeta ?? {}), species: detectedSpecies } }
        : {};
      patch.planets = {
        ...cur.planets,
        [activeIdRaw]: { ...existing, buildings: mergedB, lifeform_buildings: mergedLf, lifeform_research: mergedLfr, ...lifeformPatch } as unknown as typeof existing,
      };
      if (detectedSpecies !== null) {
        console.info(`[OgameX/species] planet ${activeIdRaw}: detected species=${detectedSpecies}`);
      }
    }
  }
  if (Object.keys(research).length > 0) {
    const mergedR: Record<string, number> = { ...(cur.research?.levels ?? {}) };
    for (const [k, v] of Object.entries(research)) {
      if (v >= (mergedR[k] ?? 0)) mergedR[k] = v;
    }
    patch.research = { ...cur.research, levels: mergedR };
  }
  if (Object.keys(patch).length > 0) store.setPartial(patch);
}

/**
 * Boots the OgameX runtime against a given environment.
 * Pure (no global side effects) — takes injected document/window/fetch/kv so it's testable in jsdom.
 */
export async function boot(env: BootEnv): Promise<BootHandle> {
  const bus = new EventBus();
  const store = new StateStore(bus, env.kv ?? null);

  // Init safe_fetch — every cp= fetch site beyond this line must use it
  // (architecture enforcement, see scripts/check-no-raw-cp.sh).
  initSafeFetch({ store, win: env.win, doc: env.doc });

  // v0.0.675 — operator 2026-06-03 "全部 boot burst 都加 once-per-session
  // guard, 如果前端 idle 超过 30 分钟可以再次运行一次": every ogame SPA
  // page navigation triggers a full Tampermonkey re-inject → boot() runs
  // again → all the harvestX / pollY / LF-prereq setTimeout bursts re-fire.
  // Persist a last-burst timestamp in localStorage so the bursts only run
  // ONCE per 30-min idle window. Event-driven sniffer signals still flow,
  // covering anything the bursts would have re-harvested.
  const BURST_LASTRUN_KEY = "ogamex_boot_burst_lastrun_v1";
  const BURST_IDLE_THRESHOLD_MS = 30 * 60 * 1000;
  const shouldRunBurst = (() => {
    try {
      const lsRaw = env.win.localStorage?.getItem(BURST_LASTRUN_KEY);
      const lastRun = lsRaw ? parseInt(lsRaw, 10) : 0;
      return Date.now() - lastRun > BURST_IDLE_THRESHOLD_MS;
    } catch { return true; }
  })();
  if (shouldRunBurst) {
    try { env.win.localStorage?.setItem(BURST_LASTRUN_KEY, String(Date.now())); } catch { /* */ }
    console.info(`[OgameX/boot-burst] running burst (last >${BURST_IDLE_THRESHOLD_MS / 60_000}min ago)`);
  } else {
    const lsRaw = env.win.localStorage?.getItem(BURST_LASTRUN_KEY) ?? "0";
    const ageMin = Math.round((Date.now() - parseInt(lsRaw, 10)) / 60_000);
    console.info(`[OgameX/boot-burst] SKIPPED — last burst ${ageMin}min ago (< ${BURST_IDLE_THRESHOLD_MS / 60_000}min)`);
  }
  const scheduleBurst = (fn: () => void | Promise<void>, ms: number): ReturnType<typeof setTimeout> | null => {
    if (!shouldRunBurst) return null;
    return setTimeout(fn, ms);
  };

  // i18n: pin t()'s locale detection to the REAL page-world doc/win.
  // Without this it falls back to the TM sandbox `document` which has
  // no `#menuTable` → locale always lands on "en" → curated keys show
  // English while auto-extracted keys show Traditional ("中英混版").
  setLocaleDocSource(env.doc, env.win);

  // 1. Hydrate prior state from IndexedDB if available
  try {
    await store.hydrate();
  } catch (e) {
    // Hydration failure should not break boot — log and continue with empty state
    console.warn("[OgameX] hydrate failed; continuing with empty state", e);
  }
  // 1a. Detect player class from DOM — Discoverer / 探險家 = +2 expedition.
  //     Class appears in topbar / player-info widget on every page.
  function detectPlayerClass(): "discoverer" | "collector" | "general" | "unknown" {
    try {
      // Match ONLY ogame's dedicated character-class CSS classes.
      // Operator 2026-05-23 incident: previous loose regex `class=.discoverer`
      // (single-char wildcard) matched any element with words like
      // "general"/"collector" in its class attribute (e.g. class="planet-general"),
      // misclassified discoverer→general, AND overwrote localStorage —
      // permanently poisoning the value across reloads. Expedition max
      // dropped from 6 → 4 (lost +2 discoverer bonus).
      const html = env.doc.documentElement?.outerHTML ?? "";
      // Strict: only ogame's own characterClassDiscoverer/Collector/General
      // CSS class. No fallback regex — those are too loose for v12 DOM.
      if (/characterClassDiscoverer\b/.test(html)) return "discoverer";
      if (/characterClassCollector\b/.test(html)) return "collector";
      if (/characterClassGeneral\b/.test(html)) return "general";
      return "unknown";
    } catch { return "unknown"; }
  }
  // localStorage TRUMPS DOM detection — once a class is confirmed
  // (either by a previous reliable detection or by the operator manually
  // setting OGAMEX_CLASS), never let a noisier page overwrite it.
  let playerClass: "discoverer" | "collector" | "general" | "unknown" = "unknown";
  try {
    const stored = env.win.localStorage.getItem("OGAMEX_CLASS");
    if (stored === "discoverer" || stored === "collector" || stored === "general") {
      playerClass = stored;
    }
  } catch { /* */ }
  // Only run DOM detection if localStorage has no value yet.
  if (playerClass === "unknown") {
    playerClass = detectPlayerClass();
  }
  if (playerClass !== "unknown") {
    try { env.win.localStorage.setItem("OGAMEX_CLASS", playerClass); } catch { /* */ }
    const cur = store.state;
    store.setPartial({
      server: { ...(cur.server ?? {}), player_class: playerClass } as typeof cur.server,
    });
    console.log(`[OgameX] player class = ${playerClass}`);
  } else {
    console.log(`[OgameX] player class unknown — set via: localStorage.OGAMEX_CLASS = "discoverer"`);
  }

  // 1b. Slot caps localStorage hydration REMOVED (v0.0.685).
  //     - max_expedition_slots: now computed in harvestSlotsFromMovement via
  //       expeditionSlots(astro) + class bonus (formula, no cache needed)
  //     - max_fleet_slots: galaxy JSON refresh fires on first eventbox poll
  //       (~5s after boot) — localStorage was always overwritten before any
  //       consumer read it (write-only data = pure dead weight)

  // 1b'. Slot-data write helpers exposed to ApiExec.
  // Operator 2026-05-23: "你的艦隊槽的數量是不是又是猜的？" / "艦隊:16/16 不要滿 保留一槽".
  // Previously slot counts came only from 10s /movement DOM harvest — discoveries
  // burst-dispatched between ticks would all fire before harvester caught up,
  // overshooting the "keep 1 slot empty" rule. Galaxy POST already returns
  // authoritative `usedFleetSlots`/`maximumFleetSlots` on every request; expose
  // a setter so ApiExec writes them post-fetch. Also expose an optimistic
  // increment helper for post-dispatch local bookkeeping.
  const updateSlotsFn = (used: number, max: number): void => {
    if (max <= 0) return;
    const cur = store.state;
    store.setPartial({
      server: { ...(cur.server ?? {}), used_fleet_slots: used, max_fleet_slots: max } as typeof cur.server,
    });
    // v0.0.685: OGAMEX_MAX_FLEET localStorage write removed (no consumer).
  };
  const incrementUsedSlotFn = (): void => {
    const cur = store.state;
    const used = ((cur.server as { used_fleet_slots?: number } | undefined)?.used_fleet_slots ?? 0) + 1;
    store.setPartial({ server: { ...(cur.server ?? {}), used_fleet_slots: used } as typeof cur.server });
  };
  (env.win as Window & {
    __ogamexUpdateSlots?: typeof updateSlotsFn;
    __ogamexIncrementUsedSlot?: typeof incrementUsedSlotFn;
  }).__ogamexUpdateSlots = updateSlotsFn;
  (env.win as Window & {
    __ogamexUpdateSlots?: typeof updateSlotsFn;
    __ogamexIncrementUsedSlot?: typeof incrementUsedSlotFn;
  }).__ogamexIncrementUsedSlot = incrementUsedSlotFn;

  // Operator 2026-05-28 "刪除以前設計的防止和前端衝突的機制": removed
  // the old user-busy gate (mousedown/keydown listeners → __ogamexUser
  // BusyUntil + user_busy_until store write → consumers SKIP-on-mousedown).
  // The new conflict-prevention stack is:
  //   1. v0.0.386 + v0.0.393 click intercept: operator clicks during any
  //      in-flight background ogame ajax (cp= fetches OR trackBackgroundOp
  //      leases) get preventDefault + toast + await + replay.
  //   2. v0.0.392 fleetdispatch page defer: GoalRunner pushes directives
  //      to deferredQueue when location.search contains component=fleet
  //      dispatch; resumes when operator navigates away.
  // These two layers together replace the old userBusy mechanism.

  // Operator 2026-05-28 "cp 鎖機制": when operator clicks while a background
  // cp= fetch is in flight, intercept the click in capture phase, await the
  // session-cp restore, then re-dispatch the click as a synthetic event.
  // Without this, ogame UI submits with stale session-cp → server race.
  // Toast gives operator visual feedback that we're syncing.
  let clickToastEl: HTMLElement | null = null;
  const showSyncToast = (): void => {
    if (clickToastEl) return;
    try {
      const el = env.doc.createElement("div");
      el.id = "ogamex-sync-toast";
      el.textContent = t("auto.262");
      el.style.cssText = "position:fixed;top:20px;left:50%;transform:translateX(-50%);background:rgba(20,20,30,0.95);color:#fff;padding:6px 14px;border-radius:4px;font:13px sans-serif;z-index:2147483647;pointer-events:none;box-shadow:0 2px 8px rgba(0,0,0,0.4);";
      env.doc.body.appendChild(el);
      clickToastEl = el;
    } catch { /* */ }
  };
  const hideSyncToast = (): void => {
    if (!clickToastEl) return;
    try { clickToastEl.remove(); } catch { /* */ }
    clickToastEl = null;
  };
  // Replay flag — when we re-dispatch a synthetic event, mark it so the
  // capture handler doesn't re-intercept (infinite loop guard).
  const REPLAY_FLAG = "__ogamexReplay";
  const clickInterceptHandler = (e: Event): void => {
    if (!e.isTrusted) return; // synthetic events (replay) pass through
    const ev = e as Event & { [k: string]: unknown };
    if (ev[REPLAY_FLAG]) return;
    void (async (): Promise<void> => {
      // Import lazily so the listener install doesn't depend on safe_fetch init.
      const { cpInFlightCount, awaitCpIdle } = await import("./api/safe_fetch.js");
      if (cpInFlightCount() === 0) return; // nothing in flight, let original fire
      // BUT we already missed the chance to preventDefault — this async block
      // ran after the event already bubbled. Need synchronous prevent.
      // (Handled below — sync prevent + async await + replay.)
    })();
  };
  // Boot-time test: can we even construct + dispatch a synthetic MouseEvent
  // in this Tampermonkey sandbox? Some sandboxes reject `view: env.win`
  // (env.win is a wrapped proxy, not the real Window). v0.0.386 evidence:
  // "Failed to construct 'MouseEvent': Failed to convert value to 'Window'".
  // If we can't replay, the worst outcome is operator clicks getting eaten
  // (preventDefault fires but no re-dispatch) — kills UI. Test first.
  let canReplayClick = false;
  try {
    const probe = new MouseEvent("click", { bubbles: true, cancelable: true });
    void probe; // unused
    canReplayClick = true;
  } catch (err) {
    console.warn("[OgameX/click-lock] sandbox can't construct synthetic MouseEvent — click intercept DISABLED to avoid eating clicks", err);
  }
  // Synchronous prevent + async wait + replay implementation.
  const clickInterceptSync = (e: Event): void => {
    if (!canReplayClick) return; // failsafe — never block clicks we can't replay
    if (!e.isTrusted) return;
    const ev = e as Event & { [k: string]: unknown };
    if (ev[REPLAY_FLAG]) return;
    // Sync read — must check inFlight count before letting ogame process.
    // Use a window mirror set by safe_fetch (avoids dynamic import in sync
    // path). safe_fetch updates window.__ogamexCpInFlight on every fetch.
    const inFlight = (env.win as Window & { __ogamexCpInFlight?: number }).__ogamexCpInFlight ?? 0;
    if (inFlight === 0) return; // pass through
    e.preventDefault();
    e.stopPropagation();
    showSyncToast();
    void (async (): Promise<void> => {
      try {
        const { awaitCpIdle } = await import("./api/safe_fetch.js");
        await awaitCpIdle();
      } catch { /* */ }
      hideSyncToast();
      // Replay the click as a synthetic event with REPLAY_FLAG set.
      // Note: `view` is intentionally omitted — TM sandbox env.win isn't
      // accepted as Window for MouseEvent construction. jQuery handlers
      // and ogame's framework don't rely on .view; bubbles+cancelable
      // are enough for the click to propagate normally.
      try {
        const target = e.target as HTMLElement | null;
        if (!target) return;
        const me = e as MouseEvent;
        const synth = new MouseEvent(e.type, {
          bubbles: true,
          cancelable: true,
          button: me.button ?? 0,
          buttons: me.buttons ?? 0,
          clientX: me.clientX ?? 0,
          clientY: me.clientY ?? 0,
          ctrlKey: me.ctrlKey ?? false,
          shiftKey: me.shiftKey ?? false,
          altKey: me.altKey ?? false,
          metaKey: me.metaKey ?? false,
        });
        (synth as unknown as Record<string, unknown>)[REPLAY_FLAG] = true;
        target.dispatchEvent(synth);
      } catch (err) {
        console.warn("[OgameX/click-lock] replay failed (click lost)", err);
      }
    })();
  };
  if (canReplayClick) {
    env.doc.addEventListener("click", clickInterceptSync, true);
    env.doc.addEventListener("mousedown", clickInterceptSync, true);
  }
  // safe_fetch will keep this mirror count current on each fetch start/end.
  // Polled here as a cheap fallback in case mirror gets out of sync.
  // v0.0.597 — also poll for lifeform-change signal from sniffer (page-world
  // script writes dataset.ogamexLfChangeTs on lfsettings/pickLifeform URLs).
  let lastSeenLfChangeTs = 0;
  let lastSeenLfResearchChangeTs = 0;
  setInterval(async () => {
    try {
      const { cpInFlightCount } = await import("./api/safe_fetch.js");
      (env.win as Window & { __ogamexCpInFlight?: number }).__ogamexCpInFlight = cpInFlightCount();
      // Event-driven species refresh: if sniffer detected an lfsettings hit,
      // immediately trigger pollEmpire(force) so species lands in store.
      const lfTsRaw = env.doc.documentElement.dataset["ogamexLfChangeTs"];
      const lfTs = lfTsRaw ? parseInt(lfTsRaw, 10) : 0;
      if (lfTs > lastSeenLfChangeTs) {
        lastSeenLfChangeTs = lfTs;
        const pollFn = (env.win as Window & { __ogamexPollEmpire?: (opts: { force?: boolean }) => Promise<void> }).__ogamexPollEmpire;
        if (typeof pollFn === "function") {
          console.info(`[OgameX/species] lifeform change detected by sniffer @ ts=${lfTs} — firing pollEmpire(force)`);
          void pollFn({ force: true }).catch((e) => console.warn("[OgameX/species] post-lf pollEmpire failed", e));
        }
      }
      // v0.0.606 — operator 2026-06-01 "每次從星球添加和重置科技的時候更新
      // 維護列表". Sniffer detected an lfresearch upgrade/reset → force
      // refreshOnePage("lfresearch") so the planet's research catalog stays
      // current without waiting for the periodic cycle (~70s).
      const lfrTsRaw = env.doc.documentElement.dataset["ogamexLfResearchChangeTs"];
      const lfrTs = lfrTsRaw ? parseInt(lfrTsRaw, 10) : 0;
      if (lfrTs > lastSeenLfResearchChangeTs) {
        lastSeenLfResearchChangeTs = lfrTs;
        const refreshFn = (env.win as Window & { __ogamexRefreshOnePage?: (forcePage?: string) => Promise<void> }).__ogamexRefreshOnePage;
        if (typeof refreshFn === "function") {
          console.info(`[OgameX/lfresearch] lfresearch change detected by sniffer @ ts=${lfrTs} — forcing refreshOnePage("lfresearch")`);
          void refreshFn("lfresearch").catch((e) => console.warn("[OgameX/lfresearch] force refresh failed", e));
        }
      }
    } catch { /* */ }
  }, 200);
  void clickInterceptHandler; // unused (kept for reference)
  // userBusy() local helper retained as `() => false` so existing callers
  // (cargo-probe, jumpgate hydrate) compile without churn. The conflict-
  // prevention work is now done at the click-intercept layer above.
  const userBusy = (): boolean => false;
  void userBusy;

  // 2. Wire probes
  const stopMO = startMutationObserver(env.doc, bus, env.win);
  if (env.fetch) {
    installXhrHook({ fetch: env.fetch }, bus);
  }

  // 2b. Page-world fetch/XHR sniffer. The isolated-context xhr_hook above
  // only sees fetches WE make. To learn ogame's real POST endpoints (so
  // ApiDirectiveExecutor can reproduce them), inject a wrapper in page
  // world that captures every fetch/XHR ogame itself fires + logs to
  // console with [OgameXSniff] prefix. The user clicks "upgrade" once
  // and we read the exact URL/body from console.
  const sniffer = env.doc.createElement("script");
  sniffer.textContent = `
    (function(){
      try {
        // Cross-context bridge: store recent ogame API calls on document
        // dataset (string only — userscript-isolated context reads it via
        // env.doc.documentElement.dataset.ogamexCaptures). Last 30 calls.
        const PERSIST_KEY = "ogamexCaptures";
        const LS_KEY = "OGAMEX_API_CAPTURES";
        const TOKEN_LS_KEY = "OGAMEX_TOKEN";
        // ogame v12 stores its CSRF token as 'var token = "..."' in inline
        // JS — only accessible from page world. Sniffer (running in page
        // world) captures it via window.token and persists for isolated
        // context (ApiExec) to read.
        const captureToken = () => {
          try {
            const t = window.token;
            if (typeof t === "string" && t.length > 10) {
              // Only SEED dataset if empty (first boot). After that,
              // ApiExec's scheduleEntry response is authoritative —
              // window.token is for OGAME's UI clicks, not ours.
              if (!document.documentElement.dataset.ogamexToken) {
                document.documentElement.dataset.ogamexToken = t;
                localStorage.setItem(TOKEN_LS_KEY, t);
              }
            }
          } catch (_) {}
        };
        // Capture only once at boot — no longer interval-overwrite.
        captureToken();
        // Auto-dump scheduleEntry captures at boot — operator doesn't have
        // to paste anything; just read the line in console.
        setTimeout(() => {
          try {
            const all = JSON.parse(localStorage.getItem(LS_KEY) || "[]");
            const realClicks = all.filter((c) =>
              c.url && c.url.includes("scheduleEntry") &&
              c.body && !c.body.includes("modus=1&cp=") // exclude our own POSTs
            );
            if (realClicks.length > 0) {
              console.log("[OgameX/captures] REAL ogame scheduleEntry POSTs captured:");
              for (const c of realClicks.slice(-5)) {
                console.log("  url=", c.url);
                console.log("  body=", c.body);
              }
            }
            // (no-captures message silenced — was once-per-boot but still noise)
          } catch (_) {}
        }, 3000);
        // Hydrate from localStorage on every boot so captures survive reload.
        try {
          const stored = localStorage.getItem(LS_KEY);
          if (stored) document.documentElement.dataset[PERSIST_KEY] = stored;
        } catch (_) {}
        const persist = (rec) => {
          try {
            const cur = document.documentElement.dataset[PERSIST_KEY];
            const arr = cur ? JSON.parse(cur) : [];
            arr.push(rec);
            while (arr.length > 50) arr.shift();
            const json = JSON.stringify(arr);
            document.documentElement.dataset[PERSIST_KEY] = json;
            try { localStorage.setItem(LS_KEY, json); } catch (_) {}
          } catch (_) {}
        };
        const log = (kind, url, body, status, respLen, respText) => {
          const u = String(url).replace(/^.*\\/game\\//, "/game/");
          console.log("[OgameXSniff]", kind, status||"", u, body ? "body="+String(body).slice(0,300) : "", respLen?("resp="+respLen+"B"):"");
          // Persist only non-trivial (with body OR with action/modus URL OR
          // any URL/body containing "jump" — captures jumpgate overlay GET
          // which has neither body nor action/modus params but IS critical).
          const isJump = /jump/i.test(u) || (body && /jump/i.test(String(body)));
          if (body || /[?&](?:modus|action|menge)=/.test(u) || isJump) {
            const rec = { ts: Date.now(), kind, url: u, body: String(body || "").slice(0, 500), status };
            if (isJump && respText) rec.resp = String(respText).slice(0, 2000);
            persist(rec);
          }
          // v0.0.597 — operator 2026-06-01 "星球切換種族類型的時候, 重新拿
          // 種族類型, 事件觸發". Detect lifeform pick / lfsettings change
          // and bump a dataset timestamp so the sandbox-side mirror tick
          // can trigger pollEmpire(force) immediately (no waiting for the
          // periodic ~5s empire poll).
          if (/lfsettings|pickLifeform|component=lfsettings/i.test(u)) {
            document.documentElement.dataset.ogamexLfChangeTs = String(Date.now());
          }
          // v0.0.606 — operator 2026-06-01 "每次從星球添加和重置科技的時候
          // 更新維護列表". Detect lfresearch upgrade/reset on any planet —
          // force the sandbox-side mirror tick to immediately refresh the
          // lfresearch page so the per-planet research catalog stays current.
          if (/component=lfresearch|action=upgrade.*lfresearch|action=resetTree/i.test(u)) {
            document.documentElement.dataset.ogamexLfResearchChangeTs = String(Date.now());
          }
        };
        // Expose a one-liner dump helper for operator. Reads OGAMEX_API_CAPTURES
        // ring (50 last calls) + filters or shows last N. Returns array so
        // operator can copy from console.
        window.__ogamexDumpCaptures = function(filter) {
          try {
            var arr = JSON.parse(localStorage.getItem(LS_KEY) || "[]");
            if (filter) arr = arr.filter(function(c){ return new RegExp(filter,"i").test(c.url + (c.body||"") + (c.resp||"")); });
            console.log("[OgameXSniff/dump] " + arr.length + " captures matching " + (filter||"<all>"));
            arr.forEach(function(c, i){
              console.log("[" + i + "] ts=" + new Date(c.ts).toISOString() + " " + c.kind + " status=" + c.status);
              console.log("    url=" + c.url);
              if (c.body) console.log("    body=" + c.body);
              if (c.resp) console.log("    resp=" + c.resp);
            });
            return arr;
          } catch (e) { console.warn("dump failed", e); return []; }
        };
        const origFetch = window.fetch;
        window.fetch = function(input, init) {
          const url = typeof input === "string" ? input : (input && input.url) || "";
          const method = (init && init.method) || (typeof input !== "string" && input.method) || "GET";
          if (url.includes("/game/index.php")) {
            const body = init && init.body ? (init.body instanceof URLSearchParams ? init.body.toString() : (typeof init.body === "string" ? init.body : "<form>")) : "";
            const p = origFetch.apply(this, arguments);
            p.then(r => {
              try { r.clone().text().then(t => {
                log("FETCH "+method, url, body, r.status, t.length, t);
                // Sniff newAjaxToken from ANY ogame JSON response and
                // refresh dataset/localStorage so ApiExec gets fresh token.
                try {
                  // ONLY rotate from scheduleEntry responses — other ogame
                  // responses (fetchResources, eventBox, etc.) have their
                  // own token chains that would pollute scheduleEntry's.
                  if (url.includes("scheduleEntry") || url.includes("buildlistactions")) {
                    const m = t.match(/"newAjaxToken"\\s*:\\s*"([a-f0-9]{20,})"/);
                    if (m) {
                      document.documentElement.dataset.ogamexToken = m[1];
                      localStorage.setItem(TOKEN_LS_KEY, m[1]);
                    }
                  }
                  // v0.0.472: operator-initiated build cancel/queue change
                  // → force empire poll so sidecar sees fresh build_q
                  // immediately (operator 2026-05-30 "前臺取消後臺沒有反應").
                  // Without this, sidecar's stale build_q blocked stuck-recovery
                  // until next natural empire poll (could be minutes).
                  if (url.includes("cancelEntry") || url.includes("cancelbuildlistEntry")) {
                    try { window.__ogamexPollEmpire && window.__ogamexPollEmpire(); } catch (_) {}
                  }
                  if (url.includes("action=checkTarget")) {
                    try {
                      const j = JSON.parse(t);
                      if (j && j.shipsData) {
                        window.postMessage(
                          { source: "ogamex:shipsData", shipsData: j.shipsData },
                          window.location.origin
                        );
                      }
                    } catch (_) { /* not JSON */ }
                  }
                  // Operator 2026-05-26/27: "發生跳躍事件 從 api 拿到源和目的
                  // 月球的計時時長並開始計時". Robust sniff — broader URL match
                  // + multiple body field candidates + 起始座標 fallback parse.
                  // 2026-05-27: relax to ANY url/body containing "jump" — ogame
                  // may use action=ajaxJumpgateAction etc. (operator: 跳了沒拿到資料)
                  if (/jump/i.test(url) || (body && /jump/i.test(body))) {
                    try {
                      // JSON parse first (executeJump endpoint returns JSON)
                      let cd = null;
                      let jsonResp = null;
                      try { jsonResp = JSON.parse(t); } catch(_) {}
                      if (jsonResp) {
                        cd = jsonResp.cooldown ?? jsonResp.nextActionAt ?? jsonResp.cooldownSec ?? jsonResp.time ?? null;
                        if (cd !== null) cd = parseInt(cd, 10);
                      }
                      // HTML overlay fallback
                      if (cd === null) {
                        const cdMatch = t.match(/simpleCountdown\\s*\\(\\s*\\$\\(["']#cooldown["']\\)\\s*,\\s*(\\d+)/);
                        cd = cdMatch ? parseInt(cdMatch[1], 10) : null;
                      }
                      const cpMatch = url.match(/[?&]cp=(\\d+)/) || (body && body.match(/[?&]cp=(\\d+)/));
                      let sourceMoonId = cpMatch ? cpMatch[1] : null;
                      if (!sourceMoonId) {
                        try {
                          const meta = document.querySelector("meta[name='ogame-planet-id']");
                          if (meta) sourceMoonId = meta.getAttribute("content");
                        } catch(_) {}
                      }
                      let targetMoonId = null;
                      if (body) {
                        const m = body.match(/targetSpaceObjectId=(\\d+)/)
                              || body.match(/selectedTarget=(\\d+)/)
                              || body.match(/[\\?&]target=(\\d+)/)
                              || body.match(/destId=(\\d+)/)
                              || body.match(/destinationId=(\\d+)/)
                              || body.match(/dest_planet=(\\d+)/);
                        if (m) targetMoonId = m[1];
                      }
                      const origCoordMatch = t.match(/起始座[標標][\\s\\S]{0,300}?\\[(\\d+):(\\d+):(\\d+)\\]/);
                      const originCoords = origCoordMatch ? [origCoordMatch[1], origCoordMatch[2], origCoordMatch[3]].join(":") : null;
                      console.log("[OgameXSniff] jumpgate detected url=" + url.slice(0, 80) + " src=" + sourceMoonId + " tgt=" + targetMoonId + " cd=" + cd + " origCoords=" + originCoords);
                      if (cd === null && jsonResp) {
                        console.log("[OgameXSniff] jumpgate cooldown NOT FOUND in JSON resp=" + t.slice(0, 300));
                      }
                      if (!targetMoonId && body && body.length > 0) {
                        console.log("[OgameXSniff] jumpgate target NOT FOUND, body=" + String(body).slice(0, 400));
                      }
                      window.postMessage({
                        source: "ogamex:jumpgateEvent",
                        sourceMoonId, targetMoonId, cooldownSec: cd, originCoords,
                        url, hasNotReady: t.includes("jumpgateNotReady") || (jsonResp && (jsonResp.status === true || jsonResp.success === true)),
                      }, window.location.origin);
                    } catch (e) { console.warn("[OgameXSniff] jumpgate parse fail:", e); }
                  }
                } catch (_) {}
              }); } catch(_){}
            }).catch(()=>{});
            return p;
          }
          return origFetch.apply(this, arguments);
        };
        const OrigXHR = window.XMLHttpRequest;
        function PatchedXHR() {
          const xhr = new OrigXHR();
          let method = ""; let url = ""; let reqBody = "";
          const origOpen = xhr.open.bind(xhr);
          xhr.open = function(m, u) { method = m; url = u; return origOpen.apply(this, arguments); };
          const origSend = xhr.send.bind(xhr);
          xhr.send = function(body) {
            reqBody = body ? (body instanceof URLSearchParams ? body.toString() : (typeof body === "string" ? body : "<form>")) : "";
            xhr.addEventListener("load", () => {
              if (url.includes("/game/index.php")) {
                try { log("XHR "+method, url, reqBody, xhr.status, (xhr.responseText||"").length, xhr.responseText); } catch(_){}
                // v0.0.472: operator-initiated cancel via ogame UI XHR →
                // force empire poll so sidecar sees fresh build_q.
                if (url.includes("cancelEntry") || url.includes("cancelbuildlistEntry")) {
                  try { window.__ogamexPollEmpire && window.__ogamexPollEmpire(); } catch(_) {}
                }
                // checkTarget shipsData piggyback (same as fetch branch)
                if (url.includes("action=checkTarget")) {
                  try {
                    const j = JSON.parse(xhr.responseText || "{}");
                    if (j && j.shipsData) {
                      window.postMessage(
                        { source: "ogamex:shipsData", shipsData: j.shipsData },
                        window.location.origin
                      );
                    }
                  } catch(_) {}
                }
                // Mirror fetch branch broader URL/field match.
                if (/jump/i.test(url) || (reqBody && /jump/i.test(reqBody))) {
                  try {
                    const t = xhr.responseText || "";
                    // 2026-05-27 真實 ogame v12 evidence:
                    //   POST .../component=jumpgate&action=executeJump&asJson=1
                    //   resp 是 JSON 274B (不是 HTML overlay) → 必須 JSON parse
                    //   cooldown 字段大概率叫 cooldown / nextActionAt / time
                    let cd = null;
                    let jsonResp = null;
                    try { jsonResp = JSON.parse(t); } catch(_) {}
                    if (jsonResp) {
                      // try common field names — operator paste 1 次後我對症
                      cd = jsonResp.cooldown ?? jsonResp.nextActionAt ?? jsonResp.cooldownSec ?? jsonResp.time ?? null;
                      if (cd !== null) cd = parseInt(cd, 10);
                    }
                    // HTML overlay fallback (page=ajax&component=jumpgate&overlay=1)
                    if (cd === null) {
                      const cdMatch = t.match(/simpleCountdown\\s*\\(\\s*\\$\\(["']#cooldown["']\\)\\s*,\\s*(\\d+)/);
                      cd = cdMatch ? parseInt(cdMatch[1], 10) : null;
                    }
                    // SOURCE: real ogame URL/body 都沒 cp= (executeJump endpoint).
                    // Fallback chain: URL cp= → body cp= → current session meta planet-id
                    const cpMatch = url.match(/[?&]cp=(\\d+)/) || (reqBody && reqBody.match(/[?&]cp=(\\d+)/));
                    let sourceMoonId = cpMatch ? cpMatch[1] : null;
                    if (!sourceMoonId) {
                      try {
                        const meta = document.querySelector("meta[name='ogame-planet-id']");
                        if (meta) sourceMoonId = meta.getAttribute("content");
                      } catch(_) {}
                    }
                    // v0.0.516 — operator 2026-05-31 "跳躍的時候源地址和目
                    // 標地址都要抓". 擴 target 提取 regex + URL params 也兜底.
                    let targetMoonId = null;
                    if (reqBody) {
                      const m = reqBody.match(/targetSpaceObjectId=(\\d+)/)
                            || reqBody.match(/selectedTarget=(\\d+)/)
                            || reqBody.match(/[\\?&]target(?:Id|MoonId|PlanetId)?=(\\d+)/i)
                            || reqBody.match(/destId=(\\d+)/)
                            || reqBody.match(/destinationId=(\\d+)/)
                            || reqBody.match(/dest_planet=(\\d+)/)
                            || reqBody.match(/[\\?&]tgt=(\\d+)/)
                            || reqBody.match(/[\\?&]moonId=(\\d+)/)
                            || reqBody.match(/moon=(\\d+)/);
                      if (m) targetMoonId = m[1];
                    }
                    // URL fallback: executeJump 可能把 target 放 URL query
                    if (!targetMoonId) {
                      const um = url.match(/[?&]target(?:Id|MoonId|PlanetId)?=(\\d+)/i)
                            || url.match(/[?&]tgt=(\\d+)/)
                            || url.match(/[?&]destId=(\\d+)/);
                      if (um) targetMoonId = um[1];
                    }
                    // JSON response fallback — ogame 可能 echo 回 target info
                    if (!targetMoonId && jsonResp) {
                      const targetField = jsonResp.targetSpaceObjectId
                                       ?? jsonResp.targetMoonId
                                       ?? jsonResp.targetId
                                       ?? jsonResp.destination
                                       ?? jsonResp.tgt;
                      if (targetField) targetMoonId = String(targetField);
                    }
                    const origCoordMatch = t.match(/起始座[標標][\\s\\S]{0,300}?\\[(\\d+):(\\d+):(\\d+)\\]/);
                    const originCoords = origCoordMatch ? [origCoordMatch[1], origCoordMatch[2], origCoordMatch[3]].join(":") : null;
                    console.log("[OgameXSniff] XHR jumpgate url=" + url.slice(0, 80) + " src=" + sourceMoonId + " tgt=" + targetMoonId + " cd=" + cd);
                    if (cd === null && jsonResp) {
                      console.log("[OgameXSniff] XHR jumpgate cooldown NOT FOUND in JSON resp=" + t.slice(0, 300));
                    }
                    if (!targetMoonId && reqBody && reqBody.length > 0) {
                      console.log("[OgameXSniff] XHR jumpgate target NOT FOUND, body=" + String(reqBody).slice(0, 400));
                    }
                    window.postMessage({
                      source: "ogamex:jumpgateEvent",
                      sourceMoonId, targetMoonId, cooldownSec: cd, originCoords,
                      url, hasNotReady: t.includes("jumpgateNotReady") || (jsonResp && (jsonResp.status === true || jsonResp.success === true)),
                    }, window.location.origin);
                    // 2026-05-27 operator: 點確認對話框 = page navigate target moon,
                    // sandbox async overlay re-fetch 來不及跑完就被 abort. 這裏同步
                    // 寫 localStorage (blocking) — navigate 前必然落盤. boot 時
                    // hydrate. ONLY 真實 jump (有 target) 寫, overlay GET 不寫.
                    // v0.0.516 — 放寬 log 寫入條件: 只要 URL 是 executeJump
                    // 並且能拿到 src AND tgt, 不管 jsonResp 是不是有 status:true
                    // (ogame 不同版本 success 字段名變化, 不能要求)。 這樣:
                    //   - sniffer 不會因爲 status field 名錯就漏抓
                    //   - 即使 response 不解析 (HTML overlay 或網路抖), 仍記錄
                    //   - 後續 hydrate 拿真值 cooldown 不依賴 sniffer 解析對
                    if (url.includes("action=executeJump") && targetMoonId && sourceMoonId) {
                      try {
                        const key = "OGAMEX_JUMPGATE_LOG";
                        const log = JSON.parse(localStorage.getItem(key) || "[]");
                        // 只記 ts+pair, 不假設 cooldown 時長 (jumpgate level 決定真實值).
                        // hydrate 時 fire overlay re-fetch 拿精確剩餘, 而非用預設值.
                        log.push({ ts: Date.now(), src: sourceMoonId, tgt: targetMoonId });
                        while (log.length > 20) log.shift();
                        localStorage.setItem(key, JSON.stringify(log));
                        console.log("[OgameXSniff] jumpgate sync-persisted src=" + sourceMoonId + " tgt=" + targetMoonId);
                      } catch (_) {}
                    } else if (url.includes("action=executeJump")) {
                      // 捕獲失敗診斷 — 看下次咋錯
                      console.warn("[OgameXSniff] jumpgate executeJump captured but src/tgt MISSING — src=" + sourceMoonId + " tgt=" + targetMoonId + " body=" + String(reqBody).slice(0, 300));
                    }
                  } catch(_) {}
                }
              }
            });
            return origSend.apply(this, arguments);
          };
          return xhr;
        }
        PatchedXHR.prototype = OrigXHR.prototype;
        window.XMLHttpRequest = PatchedXHR;
        // 2026-05-27: jumpgate may be <form> POST (full page nav) not XHR.
        // Hook submit event in CAPTURE phase so we see action+body BEFORE
        // navigation. Logs every form submit; jumpgate-detect filters later.
        try {
          document.addEventListener("submit", function(e) {
            try {
              var form = e.target;
              if (!form || !form.tagName || form.tagName !== "FORM") return;
              var action = form.action || form.getAttribute("action") || "";
              var fd = new FormData(form);
              var bodyStr = new URLSearchParams(fd).toString();
              console.log("[OgameXSniff] FORM-SUBMIT action=" + action + " body=" + bodyStr.slice(0, 400));
              // Detect jumpgate by URL substring (case-insensitive)
              if (/jump/i.test(action) || /jump/i.test(bodyStr)) {
                window.postMessage({
                  source: "ogamex:jumpgateFormSubmit",
                  action: action,
                  body: bodyStr,
                }, window.location.origin);
              }
            } catch (_) {}
          }, true);
          console.log("[OgameXSniff] form-submit listener installed");
        } catch (e) { console.warn("[OgameXSniff] form listener install failed", e); }
        console.log("[OgameXSniff] installed — fetch + XHR + form-submit wrapped, logging /game/index.php calls");
      } catch (e) { console.warn("[OgameXSniff] install failed", e); }
    })();
  `;
  env.doc.documentElement.appendChild(sniffer);
  setTimeout(() => { try { sniffer.remove(); } catch { /* gone */ } }, 500);

  // Active cargo-cap probe — operator 2026-05-26: cache 一直空因爲 boot 後
  // ogame 沒自動 fire checkTarget (operator 沒手動 select 目標). 主動跑 stage1+
  // stage2 chain (fleetSelectionAjax → checkTarget) ABORT 在 stage3 之前.
  // sniffer postMessage 自動 piggyback cache. 不依賴 ogame UI / daemon expedition.
  async function probeShipCargoCap(): Promise<void> {
    // Operator 2026-05-28 evidence: cargo-probe POSTs fleetSelectionAjax
    // (am202=1) + checkTarget which MUTATE ogame's server-side fleet
    // selection state. When operator is on the fleetdispatch page, ogame's
    // own UI then tries to render with that mutated state and crashes:
    //   "Uncaught TypeError: Cannot read properties of null (reading
    //    'baseFuelCapacity')" — FleetHelper.calcFuelCapacity dies.
    // Fix: skip the probe entirely when operator is on fleetdispatch page.
    // The probe is for our cargo cache; on other pages there's no UI to
    // disturb. The state mutation also affects only the active session,
    // so cp= isolation doesn't help.
    try {
      const path = env.win.location?.search ?? "";
      if (path.includes("component=fleetdispatch")) {
        console.info("[OgameX/cargo-probe] on fleetdispatch page — skip (would disturb operator fleet UI rendering)");
        // Retry on next page navigation rather than 10s timer.
        return;
      }
    } catch { /* */ }
    try {
      const planetId = env.doc.querySelector<HTMLMetaElement>('meta[name="ogame-planet-id"]')?.content;
      if (!planetId) return;
      const planet = store.state.planets[planetId];
      if (!planet || !Array.isArray(planet.coords) || planet.coords.length !== 3) return;
      // bootstrap token via fetchEventBox cp=current (no UI shift; current==target).
      // probe runs only when !userBusy (gated above) — safe to bypassBusy here.
      const r0 = await fetchWithCp(
        `/game/index.php?page=componentOnly&component=eventList&action=fetchEventBox&ajax=1&asJson=1`,
        { credentials: "same-origin", headers: { "X-Requested-With": "XMLHttpRequest" } },
        planetId,
        { bypassBusy: true, skipRestore: true },
      );
      const j0 = await r0.json() as { newAjaxToken?: string };
      let token = j0.newAjaxToken;
      if (!token) token = (env.doc.documentElement as HTMLElement).dataset["ogamexToken"] ?? "";
      if (!token) return;
      const body1 = new URLSearchParams({ token });
      body1.append("am202", "1");
      const r1 = await fetchWithCp(
        `/game/index.php?page=ingame&component=fleetdispatch&action=fleetSelectionAjax&ajax=1&asJson=1`,
        { method: "POST", credentials: "same-origin",
          headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Requested-With": "XMLHttpRequest" },
          body: body1 },
        planetId,
        { bypassBusy: true, skipRestore: true },
      );
      const j1 = await r1.json() as { newAjaxToken?: string };
      if (!j1.newAjaxToken) return;
      const body2 = new URLSearchParams({
        token: j1.newAjaxToken,
        galaxy: String(planet.coords[0]),
        system: String(planet.coords[1]),
        position: String(planet.coords[2]),
        type: "1",
      });
      body2.append("am202", "1");
      const r2 = await fetchWithCp(
        `/game/index.php?page=ingame&component=fleetdispatch&action=checkTarget&ajax=1&asJson=1`,
        { method: "POST", credentials: "same-origin",
          headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Requested-With": "XMLHttpRequest" },
          body: body2 },
        planetId,
        { bypassBusy: true, skipRestore: true },
      );
      const j2 = await r2.json() as { shipsData?: unknown };
      console.info(`[OgameX/cargo-probe] checkTarget response shipsData present=${!!j2.shipsData}`);
      if (j2.shipsData) {
        const { cacheShipsData } = await import("./api/ship_cargo_cache.js");
        cacheShipsData(j2.shipsData, env.win);
      }
    } catch (e) {
      console.warn("[OgameX/cargo-probe] failed:", e);
    }
  }
  // Fire one probe at boot +10s, gives empire/planets time to populate.
  setTimeout(() => { void probeShipCargoCap(); }, 10_000);
  // Expose for manual re-trigger from console / panel.
  (env.win as Window & { __ogamexProbeShipCargo?: () => Promise<void> }).__ogamexProbeShipCargo = probeShipCargoCap;
  try {
    if (typeof (globalThis as { unsafeWindow?: Window }).unsafeWindow !== "undefined") {
      ((globalThis as { unsafeWindow: Window }).unsafeWindow as Window & { __ogamexProbeShipCargo?: () => Promise<void> })
        .__ogamexProbeShipCargo = probeShipCargoCap;
    }
  } catch { /* */ }

  // Listen for shipsData piggybacked from sniffer (page world) on
  // EVERY checkTarget response — caches post-bonus cargoCapacity into
  // store.server.ship_cargo_capacity. Uses window.postMessage to cross
  // Tampermonkey sandbox boundary (CustomEvent.detail object identity
  // is lost across boundary, postMessage uses structured clone).
  env.win.addEventListener("message", (ev) => {
    try {
      const data = ev.data as { source?: string; shipsData?: unknown };
      // 2026-05-27 diagnostic — log ALL ogamex:* messages BEFORE source/origin
      // filtering so we know whether listener is even receiving page-world posts.
      if (data && typeof data === "object" && data.source && String(data.source).startsWith("ogamex:")) {
        console.info("[OgameX/msg-listener] received source=" + data.source + " ev.source===env.win? " + (ev.source === env.win) + " origin=" + ev.origin);
      }
      // 2026-05-27: 放寬 source check —— Tampermonkey sandbox 隔離下
      // ev.source (page-world window) !== env.win (sandbox proxy) is possible
      // even though they are the same underlying window. Origin check 已足夠.
      if (ev.origin !== env.win.location.origin) return;
      if (!data) return;
      if (data.source === "ogamex:shipsData" && data.shipsData) {
        void import("./api/ship_cargo_cache.js").then(({ cacheShipsData }) => {
          cacheShipsData(data.shipsData, env.win);
        }).catch((e) => console.warn("[OgameX] shipsData cache import failed:", e));
      }
      // Operator 2026-05-26: 跳躍事件驅動 update jumpgate cooldown.
      // Sniffer 監聽 component=jumpgate POST/GET response, post message 含
      // sourceMoonId / targetMoonId / cooldownSec → 寫 store, ticker 自動倒計時.
      if (data.source === "ogamex:jumpgateEvent") {
        const e = data as unknown as { sourceMoonId?: string; targetMoonId?: string; cooldownSec?: number | null; hasNotReady?: boolean; originCoords?: string };
        const cd = e.cooldownSec ?? null;
        const ts = Date.now();
        // Fallback — if sourceMoonId regex missed, find moon by originCoords
        let resolvedSourceId = e.sourceMoonId;
        if (!resolvedSourceId && e.originCoords) {
          const [g, s, p] = e.originCoords.split(":").map(Number);
          const m = Object.values(store.state.planets ?? {}).find((pl) =>
            pl.type === "moon" && pl.coords[0] === g && pl.coords[1] === s && pl.coords[2] === p
          );
          if (m) {
            resolvedSourceId = m.id;
            console.info(`[OgameX/jumpgate-event] sourceMoonId fallback by coords ${e.originCoords} → ${resolvedSourceId}`);
          }
        }
        const pairTgt = e.targetMoonId ?? null;
        const pairSrc = resolvedSourceId ?? null;

        // Helper: commit cooldown to store. cd!=null → cooldown active;
        // cd===0 → mark ready (clear pair); cd===null → noop.
        // Uses setPlanetsPatch (race-safe — re-reads live at write time).
        const commitCooldown = (srcId: string | null, cdSec: number | null): void => {
          if (!srcId) return;
          if (!store.state.planets[srcId]) return;
          const patch: Record<string, Partial<typeof store.state.planets[string]>> = {};
          if (cdSec !== null && cdSec > 0) {
            // Operator 2026-05-28: when pairTgt is null (sniffer caught an
            // overlay GET / re-fetch that doesn't carry target info), don't
            // OVERWRITE the existing pair_with with null. null means "I don't
            // know", not "clear it". Only patch pair_with when we have a
            // positive new value. Same for partner side.
            const srcPatch: Partial<typeof store.state.planets[string]> = {
              jumpgate_cooldown_sec: cdSec,
              jumpgate_harvested_at: Date.now(),
            };
            if (pairTgt !== null) {
              srcPatch.jumpgate_pair_with = pairTgt;
            }
            patch[srcId] = srcPatch;
            if (pairTgt && store.state.planets[pairTgt] && pairSrc !== null) {
              // v0.0.525 — operator 2026-05-31: target 月球也進 cooldown
              // (ogame 物理: JG 跳完兩邊都"充能中"). 寫 cd_sec + harvested_at
              // 到目的月球, 不僅寫 pair_with.
              patch[pairTgt] = {
                jumpgate_cooldown_sec: cdSec,
                jumpgate_harvested_at: Date.now(),
                jumpgate_pair_with: pairSrc,
              };
            }
          } else if (cdSec === 0) {
            // Explicit READY signal — clearing pair is fine here.
            patch[srcId] = { jumpgate_cooldown_sec: 0, jumpgate_harvested_at: Date.now(), jumpgate_pair_with: null };
          }
          store.setPlanetsPatch(patch);
          // Auto-expand Moons section so operator sees the new cooldown row even
          // if they previously collapsed it. Operator 2026-05-27 第一次跳完
          // "panel 裏面沒有顯示" — 極可能是 section collapsed 狀態遺留.
          try { window.localStorage.setItem("ogamex.panel.section.moons", "false"); } catch (_) {}
          const fmt = (sec: number): string => `${Math.floor(sec / 60)}:${(sec % 60).toString().padStart(2, "0")}`;
          console.info(`[OgameX/jumpgate-event] src=${srcId} tgt=${pairTgt ?? "?"} cd=${cdSec !== null ? fmt(cdSec) : "READY"}`);
          // Loud diagnostic — dump all moons w/ cooldown OR pair_with after commit
          // so we see store actually got the update.
          const debug = Object.entries(store.state.planets ?? {})
            .filter(([_, p]) => p.type === "moon" && (p.jumpgate_cooldown_sec !== null && p.jumpgate_cooldown_sec !== undefined || p.jumpgate_pair_with))
            .map(([id, p]) => `${id}(${(p.coords ?? []).join(":")}) cd=${p.jumpgate_cooldown_sec} at=${p.jumpgate_harvested_at} pair=${p.jumpgate_pair_with}`);
          console.info(`[OgameX/jumpgate-event] post-commit store snapshot: ${debug.length} entries → ${debug.join(" | ")}`);
        };

        // CASE A: sniffer 拿到了精確 cooldown → 直接 commit
        if (cd !== null && cd > 0) {
          commitCooldown(resolvedSourceId ?? null, cd);
        } else if (e.hasNotReady === true && resolvedSourceId && e.targetMoonId) {
          // CASE B: 真實 jump 事件 (有 target) — 跳躍成功但 ogame executeJump
          // JSON 不返回 cd. Event-driven re-fetch overlay GET → parse cooldown.
          // **關鍵 gate**: 必須有 e.targetMoonId. Operator 2026-05-27 第二次跳前
          // 打開 jumpgate widget → overlay GET 也觸發 sniffer with tgt=null +
          // hasNotReady=true (源月球還在 cooldown). 如果不 gate,會:
          //   (1) 死循環: re-fetch overlay → sniffer 攔它 → 又 fire CASE B
          //   (2) pair_with 被 overlay GET (tgt=null) 覆寫成 null → panel 壞
          // Try several regex variants (ogame v12 may use different markup).
          // Fallback to 3600 (60 min, level-1 jumpgate default).
          console.info(`[OgameX/jumpgate-event] success but JSON no cd — re-fetch overlay cp=${resolvedSourceId} for precise cooldown`);
          void (async (): Promise<void> => {
            try {
              // CASE B fires right after operator clicked jump → cp likely already at
              // source moon (no UI bounce). Still bypassBusy=true since this is event-
              // driven response to operator's own action.
              const { fetchWithCpBypassBusy } = await import("./api/safe_fetch.js");
              const r = await fetchWithCpBypassBusy(
                `/game/index.php?page=ajax&component=jumpgate&overlay=1&ajax=1`,
                { credentials: "same-origin", headers: { "X-Requested-With": "XMLHttpRequest" } },
                resolvedSourceId,
              );
              const html = await r.text();
              // Multi-regex sweep — first hit wins.
              const patterns: RegExp[] = [
                /simpleCountdown\s*\(\s*\$\(["']#cooldown["']\)\s*,\s*(\d+)/,
                /simpleCountdown\s*\(\s*[^,)]+,\s*(\d+)/,
                /id\s*=\s*["']cooldown["'][^>]*data-(?:end-time|cd|cooldown|countdown)\s*=\s*["']?(\d+)/i,
                /data-(?:end-time|cd|cooldown|countdown)\s*=\s*["']?(\d+)["']?[^>]*id\s*=\s*["']cooldown["']/i,
                /id\s*=\s*["']cooldown["'][^>]*>\s*(\d+)/,
              ];
              let parsedCd: number | null = null;
              for (const re of patterns) {
                const m = html.match(re);
                if (m && m[1]) {
                  parsedCd = parseInt(m[1], 10);
                  if (!isNaN(parsedCd) && parsedCd > 0) {
                    console.info(`[OgameX/jumpgate-event] overlay cd parsed via ${re.source.slice(0, 50)}... → ${parsedCd}s`);
                    break;
                  }
                  parsedCd = null;
                }
              }
              if (parsedCd === null) {
                // Dump cooldown-keyword vicinity for next-iter regex refinement.
                const cdIdx = html.toLowerCase().indexOf("cooldown");
                if (cdIdx >= 0) {
                  console.warn(`[OgameX/jumpgate-event] overlay regex all missed — context: ${html.slice(Math.max(0, cdIdx - 100), cdIdx + 300)}`);
                }
                parsedCd = 3600;
                console.warn(`[OgameX/jumpgate-event] using fallback cooldown=3600s (60min default for level-1 jumpgate)`);
              }
              commitCooldown(resolvedSourceId, parsedCd);
            } catch (err) {
              console.warn(`[OgameX/jumpgate-event] overlay re-fetch failed, fallback 3600s:`, err);
              commitCooldown(resolvedSourceId, 3600);
            }
          })();
        }
      }
    } catch (e) { console.warn("[OgameX] message listener failed:", e); }
  });

  // 3. Initial extraction from current page
  const resources = extractResources(env.doc);
  const storage = extractStorage(env.doc);
  const production = extractProduction(env.doc);
  const lifeform_resources = extractLifeformResources(env.doc);
  const events = extractIncomingEvents(env.doc);
  const planets = extractPlanets(env.doc);
  const fleets = extractFleetMovements(env.doc);
  const token = extractToken(env.doc, env.win as OgameWindow);

  // 4. Compose ogame_meta from <meta> tags (omit undefined keys for exactOptionalPropertyTypes)
  const universe = readMeta(env.doc, "ogame-universe");
  const universeSpeedRaw = readMeta(env.doc, "ogame-universe-speed");
  const playerIdMeta = readMeta(env.doc, "ogame-player-id");
  const playerNameMeta = readMeta(env.doc, "ogame-player-name");
  const planetCoordsMeta = readMeta(env.doc, "ogame-planet-coordinates");
  const allianceTagMeta = readMeta(env.doc, "ogame-alliance-tag");
  const ogame_meta: BootSummary["ogame_meta"] = {
    is_vacation_mode: detectVacationMode(env.doc),
  };
  if (universe !== undefined) ogame_meta.universe = universe;
  if (universeSpeedRaw !== undefined) ogame_meta.universe_speed = Number(universeSpeedRaw);
  if (playerIdMeta !== undefined) ogame_meta.player_id = playerIdMeta;
  if (playerNameMeta !== undefined) ogame_meta.player_name = playerNameMeta;
  if (planetCoordsMeta !== undefined) ogame_meta.planet_coords = planetCoordsMeta;
  if (allianceTagMeta !== undefined) ogame_meta.alliance_tag = allianceTagMeta;

  // 5. Seed StateStore with what we know
  const playerId = ogame_meta.player_id ?? "";
  const playerName = ogame_meta.player_name ?? "";
  const allianceTag = ogame_meta.alliance_tag ?? null;
  // Fetch /api/serverData.xml for the fleet + research speed multipliers
  // that aren't exposed via meta tags. ogame servers differ — Scorpius has
  // research=16, build=8; classic has both=1. We fire-and-forget here so
  // boot doesn't stall on the network; the result is patched into the
  // store via setPartial once it lands.
  void (async () => {
    try {
      const resp = await fetch("/api/serverData.xml", { credentials: "same-origin" });
      if (!resp.ok) return;
      const xml = await resp.text();
      const pick = (tag: string): number | undefined => {
        const m = xml.match(new RegExp(`<${tag}>([^<]+)</${tag}>`));
        return m ? Number(m[1]) : undefined;
      };
      const econ = pick("speed");
      const resDiv = pick("researchDurationDivisor") ?? 1;
      const fleetP = pick("speedFleetPeaceful");
      const fleetW = pick("speedFleetWar");
      const fleetH = pick("speedFleetHolding");
      const patch: Partial<WorldState["server"]> = {};
      if (typeof econ === "number") patch.speed = econ;
      if (typeof econ === "number") patch.research_speed = econ * resDiv;
      if (typeof fleetP === "number") patch.fleet_peaceful_speed = fleetP;
      if (typeof fleetW === "number") patch.fleet_war_speed = fleetW;
      if (typeof fleetH === "number") patch.fleet_holding_speed = fleetH;
      if (Object.keys(patch).length > 0) {
        const prev = store.state.server;
        store.setPartial({ server: { ...prev, ...patch } });
      }
    } catch { /* boot must never throw on network errors */ }
  })();

  // ogame v12+ exposes fleet speeds in <meta> tags directly — read these
  // synchronously so the optimizer's first tick has accurate values
  // without waiting on the /api/serverData.xml async fetch above.
  const metaSpeedFleetP = readMeta(env.doc, "ogame-universe-speed-fleet-peaceful");
  const metaSpeedFleetW = readMeta(env.doc, "ogame-universe-speed-fleet-war");
  const metaSpeedFleetH = readMeta(env.doc, "ogame-universe-speed-fleet-holding");
  // Stamp our userscript version into the snapshot so /v1/state lets the
  // operator see which version is actually running (vs the served bundle).
  // Manually kept in sync with rollup.config.js @version banner.
  const USERSCRIPT_VERSION = "0.0.758";
  console.log(`[OgameX] runtime version ${USERSCRIPT_VERSION} booting on ${location.href}`);
  // Operator 2026-05-29: expose for panel title + update-check button.
  (env.win as Window & { __ogamexVersion?: string }).__ogamexVersion = USERSCRIPT_VERSION;
  try {
    if (typeof (globalThis as { unsafeWindow?: Window }).unsafeWindow !== "undefined") {
      ((globalThis as { unsafeWindow: Window }).unsafeWindow as Window & { __ogamexVersion?: string }).__ogamexVersion = USERSCRIPT_VERSION;
    }
  } catch { /* */ }
  // (meta-probes / extractProduction / box-title / window.production /
  //  reloadResources extractor traces silenced — extractor stable, schema
  //  stable. Errors still surface from parse-error path below.)
  void extractProduction(env.doc);
  const winAny = env.win;
  void (winAny.production || winAny.productionRates || winAny.resourcesData);
  for (const s of Array.from(env.doc.querySelectorAll("script"))) {
    const txt = s.textContent ?? "";
    const m = txt.match(/reloadResources\(\s*(\{[\s\S]*?"resources"[\s\S]*?\})\s*\)/);
    if (m) {
      try { JSON.parse(m[1]); } catch (e) {
        console.warn(`[OgameX] reloadResources parse error:`, (e as Error).message);
      }
      break;
    }
  }
  store.setPartial({
    server: {
      // Operator 2026-05-26 evidence: SC/LC 反復回 5000/25000 base — 因爲
      // boot init 每次 (ogame SPA navigate 重 inject) 跑此 setPartial 用
      // hardcode server build, 覆蓋 ship_cargo_capacity. Fix: spread existing
      // store.state.server (rehydrated from IndexedDB) 才保留 cache 字段.
      ...(store.state.server ?? {}),
      universe: ogame_meta.universe ?? "",
      speed: ogame_meta.universe_speed ?? 1,
      userscript_version: USERSCRIPT_VERSION,
      ...(metaSpeedFleetP ? { fleet_peaceful_speed: Number(metaSpeedFleetP) } : {}),
      ...(metaSpeedFleetW ? { fleet_war_speed: Number(metaSpeedFleetW) } : {}),
      ...(metaSpeedFleetH ? { fleet_holding_speed: Number(metaSpeedFleetH) } : {}),
    } as any,
    player: {
      id: playerId,
      name: playerName,
      alliance: allianceTag,
    },
    events_incoming: events,
    fleets_outbound: fleets,
  });

  // 6. Wire dom.changed → re-extract on the affected target
  const offDomChanged = bus.on("dom.changed", (payload: unknown) => {
    const p = payload as { targetId?: string } | undefined;
    const targetId = p?.targetId;
    if (!targetId) return;
    if (targetId.startsWith("resources_")) {
      const r = extractResources(env.doc);
      const prod = extractProduction(env.doc);
      if (r || prod) {
        // Route updates to the ACTIVE planet (per `<meta name="ogame-planet-id">`).
        // Production is needed by the bridge optimizer for "礦升到幾級最快" —
        // without it, prodPerSec=0 and every mine candidate gets discarded.
        const activeIdRaw = env.doc.querySelector<HTMLMetaElement>('meta[name="ogame-planet-id"]')?.content ?? "";
        if (activeIdRaw && store.state.planets[activeIdRaw]) {
          store.setPlanetsPatch({
            [activeIdRaw]: {
              ...(r ? { resources: { m: r.m, c: r.c, d: r.d, e: r.e ?? 0 } } : {}),
              ...(prod ? { production: { m_h: prod.m_h, c_h: prod.c_h, d_h: prod.d_h } } : {}),
            },
          });
        }
      }
    }
    if (targetId === "eventContent") {
      // Operator 2026-05-24: this path was wiping out API-sourced spy
      // events. parseEventListHTMLAndInject (eventbox_hook.ts) is the
      // authoritative source — it adds rows with id prefix "evrow-".
      // dom.changed on a non-event page returns empty here and was
      // overwriting events_incoming → spy disappeared → /v1/emergency
      // empty → panel never fired alarm. Only update if extractor
      // actually found rows; even then, MERGE with API-sourced
      // "evrow-" entries instead of replacing.
      const evs = extractIncomingEvents(env.doc);
      if (evs.length > 0) {
        const cur = store.state.events_incoming ?? [];
        const apiSourced = cur.filter((e) => e.id.startsWith("evrow-"));
        store.setPartial({ events_incoming: [...evs, ...apiSourced] });
      }
    }
    if (targetId === "movement") {
      const fls = extractFleetMovements(env.doc);
      store.setPartial({ fleets_outbound: fls });
    }
    if (targetId === "planetList") {
      const pls = mergeWithExistingPlanets(extractPlanets(env.doc), store.state.planets);
      if (Object.keys(pls).length > 0) store.setPlanetsPatch(pls);
    }
  });

  // 6b. Boot-time race: planetList sometimes renders AFTER document-end. Schedule
  //     a one-shot re-extract at +500ms + +2000ms to catch late renders. The
  //     dom.changed MO handler above covers all later updates.
  const schedulePlanetReExtract = (delayMs: number): ReturnType<typeof setTimeout> =>
    setTimeout(() => {
      const pls = mergeWithExistingPlanets(extractPlanets(env.doc), store.state.planets);
      const newCount = Object.keys(pls).length;
      const oldCount = Object.keys(store.state.planets).length;
      if (newCount > 0 && newCount !== oldCount) {
        store.setPlanetsPatch(pls);
      }
      // Same window: harvest building / research levels from current page.
      mergeTechLevels(env.doc, store);
    }, delayMs);
  const lateExtract1 = schedulePlanetReExtract(500);
  const lateExtract2 = schedulePlanetReExtract(2000);
  // Also harvest immediately so the very first state.snapshot push carries
  // real building/research levels when the page is fully rendered at boot.
  mergeTechLevels(env.doc, store);

  // Boot-time production harvest — the dom.changed handler above writes
  // production on `resources_*` mutations, but on the very first page
  // load there's no mutation yet. Retry a few times until planets is
  // populated by the late re-extracts (mergeWithExistingPlanets runs at
  // +500ms/+2000ms), then snapshot resources+production into the ACTIVE
  // planet (resolved via `<meta name="ogame-planet-id">`).
  const harvestProduction = (): boolean => {
    const prod = extractProduction(env.doc);
    const res = extractResources(env.doc);
    if (!prod && !res) return false;
    if (Object.keys(store.state.planets).length === 0) return false;
    const activeIdRaw = env.doc.querySelector<HTMLMetaElement>('meta[name="ogame-planet-id"]')?.content ?? "";
    if (!activeIdRaw || !store.state.planets[activeIdRaw]) return false;
    store.setPlanetsPatch({
      [activeIdRaw]: {
        ...(res ? { resources: { m: res.m, c: res.c, d: res.d, e: res.e ?? 0 } } : {}),
        ...(prod ? { production: { m_h: prod.m_h, c_h: prod.c_h, d_h: prod.d_h } } : {}),
      },
    });
    return true;
  };
  // Try immediately + at the same checkpoints the planet extractor uses.
  if (!harvestProduction()) {
    const harvestRetries = [200, 700, 2100, 4500].map((ms) =>
      scheduleBurst(() => harvestProduction(), ms),
    );
    void harvestRetries; // keep handles alive — cleared at stop()
  }

  // ─── research / build / shipyard queue harvest ─────────────────────────
  // Scans the page for active queues (li.technology[data-status="active"])
  // and writes them into state. Without this, the planner doesn't know a
  // research is already in flight and keeps computing full ETA. Runs at
  // boot + every dom.changed event so queue stays fresh.
  // Map li[data-technology="<id>"] → canonical name. Reuse the reverse of
  // the executor's table — but boot.ts can't see it; hard-code the small
  // set we actually research/build.
  // Sourced from shared/tech_ids.ts — single source of truth for tech IDs.
  const TECH_ID_TO_NAME = TECH_NAME_BY_ID as Record<string, string>;
  const RESEARCH_NUMERIC_RE = /^(10[6-9]|11[0-9]|12[0-4]|199)$/; // 106-124 + 199
  // Ships inventory extractor — runs on shipyard page. Each ship li has
  // a count rendered either as `<span class="amount">N</span>` inside the
  // li OR baked into `data-tooltip-title="<name> (N)<br/>...". Read both;
  // first hit wins. Without this, Object.values(state.planets ?? {})[0].ships stays empty and
  // the bridge's expedition daemon never realizes ships are built.
  const SHIP_NUMERIC_RE = /^(20[2-9]|21[0-9]|217|218|219)$/;
  const SHIP_ID_TO_NAME = TECH_NAME_BY_ID as Record<string, string>;
  function harvestShips(): void {
    // GATED: only run on shipyard / fleetdispatch pages. On overview/research/
    // other pages, li.technology with data-technology="203" can be present
    // (e.g. ship-build preview, expedition slot indicator) but its tooltip's
    // "(N)" refers to something OTHER than ship-owned count (e.g. "expedition
    // slots used: 1") — writing N=1 there clobbers empire's correct 1500.
    //
    // Empire endpoint IS the multi-planet ship source. DOM-harvest only as
    // belt-and-braces for the CURRENT planet on fleet pages.
    const pageUrl = (env.win.location?.href ?? "");
    if (!/component=(shipyard|fleetdispatch)/.test(pageUrl)) return;
    const lis = env.doc.querySelectorAll<HTMLElement>('li.technology[data-technology]');
    if (lis.length === 0) return;
    const out: Record<string, number> = {};
    for (const li of lis) {
      const numeric = li.getAttribute("data-technology") ?? "";
      if (!SHIP_NUMERIC_RE.test(numeric)) continue;
      const name = SHIP_ID_TO_NAME[numeric];
      if (!name) continue;
      // Only trust explicit data-max-amount (ogame's launchable count).
      const inputEl = li.querySelector<HTMLInputElement>('input[name^="am"][data-max-amount]');
      const dataMax = inputEl?.getAttribute("data-max-amount");
      if (dataMax && /^\d+$/.test(dataMax)) {
        out[name] = parseInt(dataMax, 10);
      }
    }
    if (Object.keys(out).length === 0) return;
    if (Object.keys(store.state.planets).length === 0) return;
    const activeIdRaw = env.doc.querySelector<HTMLMetaElement>('meta[name="ogame-planet-id"]')?.content ?? "";
    const target = activeIdRaw ? store.state.planets[activeIdRaw] : undefined;
    if (!target) return;
    store.setPlanetsPatch({ [activeIdRaw]: { ships: { ...(target.ships ?? {}), ...out } } });
  }
  // Run on boot + retries (shipyard page DOM mounts late).
  [600, 2200, 4600].forEach((ms) => scheduleBurst(harvestShips, ms));

  // PRIMARY: fetch ogame's movement page → count real fleet entries by
  // mission_type. Server-side truth, no DOM scraping ambiguity.
  async function harvestSlotsFromMovement(): Promise<void> {
    try {
      const url = "/game/index.php?page=componentOnly&component=movement&ajax=1";
      const resp = await env.win.fetch(url, { credentials: "same-origin", headers: { "X-Requested-With": "XMLHttpRequest" } });
      if (!resp.ok) return;
      const html = await resp.text();
      // Parse each fleet block — capture mission type + surrounding HTML so
      // we can extract origin/destination coords. ogame v12 renders each
      // fleet as <div class="fleetDetails" data-mission-type="N">...</div>
      // with coords in <span class="originCoords">[G:S:P]</span> etc.
      const allFleetEls = Array.from(html.matchAll(/data-mission-type="(\d+)"/g));
      // Parse each <li class="fleetDetails"> block with its inner coords.
      const fleetBlockRe = /<(?:li|div)[^>]+(?:class="fleetDetails[^"]*"|data-mission-type="\d+")[^>]*?>([\s\S]*?)(?=<(?:li|div)[^>]+(?:class="fleetDetails|data-mission-type=)|<\/(?:tbody|ul|table)>)/g;
      // Diagnostic: dump first fleet inner block once per session so we
      // can see actual ogame v12 HTML format for arrival_at / coords.
      if (!(env.win as Window & { __ogamexMovDump?: boolean }).__ogamexMovDump) {
        (env.win as Window & { __ogamexMovDump?: boolean }).__ogamexMovDump = true;
        // (movement-dump silenced — was useful only for first-extractor verify)
      }
      const parsedFleets = Array.from(html.matchAll(fleetBlockRe)).map((m) => {
        const block = m[0] ?? "";
        const inner = m[1] ?? "";
        const missionM = block.match(/data-mission-type="(\d+)"/);
        const mission = missionM ? parseInt(missionM[1]!, 10) : 0;
        // Real ogame fleet id (v0.0.295 — operator probe 2026-05-26 evidence):
        //   <span class="timer tooltip" ... id="timer_NNNNNNN">載入中...</span>
        // The numeric suffix after "timer_" IS the ogame fleet id; used by
        // recallFleetAjax POST. Verified for both mission=4 deploy (2005022)
        // and mission=15 expedition (2001819) on live server. Previous guess
        // `data-fleet-id` was from fleetdispatch fixture — wrong page.
        const fleetIdMatch = inner.match(/id="timer_(\d+)"/);
        const fleetId = fleetIdMatch ? parseInt(fleetIdMatch[1]!, 10) : null;
        // Find ALL coords [G:S:P] in the inner block. First = origin, last = dest.
        const coordsList = Array.from(inner.matchAll(/\[(\d+):(\d+):(\d+)\]/g)).map((cm) =>
          [parseInt(cm[1]!, 10), parseInt(cm[2]!, 10), parseInt(cm[3]!, 10)] as readonly number[]
        );
        // ogame v12 movement renders <span class="timer tooltip" title="DD.MM.YYYY HH:MM:SS" ...>
        // Parse from title attribute (no data-end-time attr in this skin).
        let arrival_at = 0;
        const titleMatch = inner.match(/<span\s+class="timer[^"]*"\s+title="(\d{1,2})\.(\d{1,2})\.(\d{4})\s+(\d{1,2}):(\d{1,2}):(\d{1,2})"/i);
        if (titleMatch) {
          const [, dd, mm, yyyy, hh, mi, ss] = titleMatch;
          // Scorpius server runs UTC+1. Title shows server's wall-clock time.
          // Convert: UTC epoch = parse-as-UTC(server-wall-clock) - 1h offset.
          const SERVER_TZ_OFFSET_MS = 1 * 3600 * 1000;
          const tsServerWall = Date.UTC(parseInt(yyyy!, 10), parseInt(mm!, 10) - 1, parseInt(dd!, 10),
                                        parseInt(hh!, 10), parseInt(mi!, 10), parseInt(ss!, 10));
          arrival_at = tsServerWall - SERVER_TZ_OFFSET_MS;
        }
        // Legacy fallback for other ogame skins with data-end-time attr.
        if (!arrival_at) {
          const dataMatch = inner.match(/data-(?:end-time|arrival-time|end)="(\d+)"/i);
          if (dataMatch) {
            const n = parseInt(dataMatch[1]!, 10);
            arrival_at = n < 1e12 ? n * 1000 : n;
          }
        }
        const returnMatch = inner.match(/data-return-time="(\d+)"/i) ?? inner.match(/data-return="(\d+)"/i);
        let return_at: number | null = null;
        if (returnMatch) {
          const n = parseInt(returnMatch[1]!, 10);
          return_at = n < 1e12 ? n * 1000 : n;
        }
        // expedition (mission=15) always targets G:S:16 — derive dest from
        // origin instead of unreliable HTML coord extraction.
        const origin = coordsList[0];
        let dest = coordsList[coordsList.length - 1];
        if (mission === 15 && origin && origin.length === 3) {
          dest = [origin[0]!, origin[1]!, 16] as readonly number[];
        }
        // Operator 2026-05-29: extract origin_type (planet|moon) from
        // movement row's <span class="originPlanet"><figure class=
        // "planetIcon planet|moon">. Without this, syntheticFleets writes
        // fleets_outbound with origin_type=undefined, which breaks the
        // multi-FSM patchFleetId origin_type gate (v0.0.395) — patcher
        // skips all candidates → fleetId stays 0 → backend DROPs FS as
        // unsalvageable → ships never recall. dest_type extracted similarly
        // for symmetry (case_decider's moon discrimination at dest).
        const originIconM = inner.match(/<span\s+class="originPlanet"[\s\S]{0,200}?<figure[^>]+class="planetIcon\s+(planet|moon)"/);
        const origin_type: "planet" | "moon" = originIconM?.[1] === "moon" ? "moon" : "planet";
        const destIconM = inner.match(/<span\s+class="destinationPlanet"[\s\S]{0,200}?<figure[^>]+class="planetIcon\s+(planet|moon)"/);
        const dest_type: "planet" | "moon" = destIconM?.[1] === "moon" ? "moon" : "planet";
        return { mission, origin, origin_type, dest, dest_type, arrival_at, return_at, fleetId };
      });
      // v0.0.679 — slot fields (used_*/max_*) moved to refreshSlotsViaApi
      // (official JSON: fetchGalaxyContent). This function now owns only
      // fleets_outbound. No regex slot scrape, no suspicious-drop gate.
      // /movement hostile detection REMOVED (v0.0.219).
      // Was added v0.0.217 as bandaid before the right signal was found.
      // Operator clarified: red enemy spy lives in #eventContent DOM (page-
      // wide events widget), not /movement. eventbox_hook installs a
      // MutationObserver on #eventContent that injects events_incoming
      // entries with prefix "evrow-" directly. /movement endpoint stays for
      // slot counts + own fleet list only.
      // (movement summary silenced — slots are tracked, no repeated log needed)
      // Synthesize fleets_outbound entries from parsedFleets (has origin+dest).
      // Fall back to allFleetEls count if parser missed entries.
      // v0.0.553 — MOV-SCRAPE forensic removed (was every harvestSlots call,
      // could fire 10+/min during active dispatch → spammed sidecar journal
      // and browser fetch queue). Diagnostic served its purpose (confirmed
      // cross-galaxy dest parse gap); future investigation can use one-shot
      // probes instead of always-on logging.
      const sourceList = parsedFleets.length === allFleetEls.length ? parsedFleets : allFleetEls.map((m) => ({
        mission: parseInt(m[1]!, 10),
        origin: undefined as readonly number[] | undefined,
        dest: undefined as readonly number[] | undefined,
      }));
      const syntheticFleets = sourceList.map((f, idx) => {
        // Real fleet id preferred over synthetic; fsm.patchFleetId needs it.
        const realId = (f as { fleetId?: number | null }).fleetId;
        // Operator 2026-05-29: propagate origin_type/dest_type from parser.
        // Falls back to "planet" only when parser didn't see the icon (legacy
        // / unparsed row). patchFleetId's origin_type gate (v0.0.395) needs
        // the real value to match the FSM source's celestial type.
        const ft = f as { origin_type?: "planet" | "moon"; dest_type?: "planet" | "moon"; arrival_at?: number; return_at?: number | null };
        return {
          id: realId !== null && realId !== undefined ? String(realId) : `mvt-${idx}`,
          mission: f.mission,
          origin: f.origin,
          origin_type: ft.origin_type ?? "planet",
          dest: f.dest,
          dest_type: ft.dest_type ?? "planet",
          arrival_at: ft.arrival_at ?? 0,
          return_at: ft.return_at ?? null,
          ships: {} as Record<string, number>,
        };
      }) as unknown as typeof store.state.fleets_outbound;
      // v0.0.715 — operator 2026-06-03 "顶层方案 (改 2 处)". The /movement
      // harvest now writes ONLY fleets_outbound (per memory rule
      // [[feedback_single_source_slot_data]] "harvestMovement 只写
      // fleets_outbound"). All slot fields — including expedition — moved
      // to refreshSlotsViaApi (galaxy JSON path, with cap to usedFleetSlots
      // so a phantom mission=15 in this cache can't lock out new launches).
      store.setPartial({ fleets_outbound: syntheticFleets });
    } catch (e) {
      void e;
    }
  }
  // v0.0.712 — operator 2026-06-03 "EN 服跑出来全是中文+西班牙文". 上版
  // dumpTechLabelsFn 读 store.tech_labels (被动累积字段, 旧 session 脏数据).
  // 改成主动 fetch 5 个 ogame chunk 页, 当场 extractTechLabels, 不污染 store.
  // 1 个命令 = 1 个 locale 的完整 corpus.
  const dumpTechLabelsFn = async (): Promise<void> => {
    const PAGES = ["supplies", "research", "facilities", "shipyard", "lfbuildings", "lfresearch"];
    const merged: Record<string, string> = {};
    const buildingsModule = await import("./probes/extractors/buildings.js");
    const locale = (env.doc.documentElement.getAttribute("lang") ?? "?");
    console.info(`[OgameX/dump-tech-labels] START locale=${locale}, fetching ${PAGES.length} pages...`);
    for (const page of PAGES) {
      try {
        const resp = await env.win.fetch(`/game/index.php?page=ingame&component=${page}`, {
          credentials: "same-origin",
        });
        if (!resp.ok) {
          console.warn(`[OgameX/dump-tech-labels] ${page} HTTP ${resp.status} skip`);
          continue;
        }
        const html = await resp.text();
        const parser = new (env.win as unknown as { DOMParser: typeof DOMParser }).DOMParser();
        const parsedDoc = parser.parseFromString(html, "text/html");
        const labels = buildingsModule.extractTechLabels(parsedDoc);
        let added = 0;
        for (const [k, v] of Object.entries(labels)) {
          if (!(k in merged)) { merged[k] = v; added += 1; }
        }
        console.info(`[OgameX/dump-tech-labels] ${page}: +${added} labels (total ${Object.keys(merged).length})`);
      } catch (e) {
        console.warn(`[OgameX/dump-tech-labels] ${page} error:`, e);
      }
    }
    const sorted: Record<string, string> = {};
    for (const k of Object.keys(merged).sort()) sorted[k] = merged[k]!;
    console.info(`[OgameX/dump-tech-labels] DONE locale=${locale} keys=${Object.keys(sorted).length}`);
    console.info(JSON.stringify(sorted, null, 2));
  };
  (env.win as Window & { __ogamexDumpTechLabels?: () => Promise<void> }).__ogamexDumpTechLabels = dumpTechLabelsFn;
  try {
    if (typeof (globalThis as { unsafeWindow?: Window }).unsafeWindow !== "undefined") {
      ((globalThis as { unsafeWindow: Window }).unsafeWindow as Window & { __ogamexDumpTechLabels?: () => Promise<void> }).__ogamexDumpTechLabels = dumpTechLabelsFn;
    }
  } catch { /* */ }

  // v0.0.704-710 auto-walk attempt removed (POST settings 表单切语言永远不
  // 真正生效; 7 sprint 全失败). 真实有效方法 = manual: operator 在
  // account.gameforge.com 切 UI 语言 → F5 ogame → run __ogamexDumpTechLabels()
  // → paste 输出。每 locale ~2 min, 22 langs ≈ 45 min。

  // v0.0.740 — operator 2026-06-04 "生命建筑的依赖关系没有, 去建依赖关系".
  // kaelesh_tech.ts catalog 全 verified_against_live: false, 不全, ogame
  // 用真规则拒了 forumOfTranscendence 120020. 主动 fetch lfbuildings +
  // lfresearch chunk, 每个 building/research 找 tooltip 里的"需要/Requires"
  // 区段 + dump 解析后的 requires JSON, 让 operator 拿真数据补 catalog.
  const dumpLfRequiresFn = async (): Promise<void> => {
    const PAGES = ["lfbuildings", "lfresearch"];
    const out: Record<string, unknown> = {};
    for (const page of PAGES) {
      try {
        const resp = await env.win.fetch(`/game/index.php?page=ingame&component=${page}`, { credentials: "same-origin" });
        if (!resp.ok) { console.warn(`[OgameX/dump-lf-requires] ${page} HTTP ${resp.status}`); continue; }
        const html = await resp.text();
        const parser = new (env.win as unknown as { DOMParser: typeof DOMParser }).DOMParser();
        const parsedDoc = parser.parseFromString(html, "text/html");
        const techNodes = parsedDoc.querySelectorAll<HTMLElement>("li.technology[data-technology], div.technology[data-technology]");
        console.info(`[OgameX/dump-lf-requires] ${page}: scanning ${techNodes.length} tech nodes`);
        techNodes.forEach((li) => {
          const techId = li.getAttribute("data-technology") ?? "";
          const techName = (TECH_ID_TO_NAME as Record<string, string>)[techId] ?? `id_${techId}`;
          // v0.0.741 — dump-v1 全空 (.tooltipHTML 不命中 lfbuildings). Dump
          // the ENTIRE li.outerHTML + all data-* attributes so operator's
          // second run reveals the real DOM shape, including any data-tooltip
          // / data-tipid / data-content / aria-describedby pointers, plus
          // ogame v12 React/Vue-injected popup containers elsewhere in doc.
          const attrs: Record<string, string> = {};
          for (const a of Array.from(li.attributes)) attrs[a.name] = a.value;
          const allLinks: string[] = [];
          li.querySelectorAll<HTMLElement>("a[href*='ranking']").forEach((a) => allLinks.push((a.getAttribute("href") ?? "")));
          const tooltipPopupCandidates: string[] = [];
          // Look at sibling popup divs ogame v12 lazy-renders (e.g. #planet,
          // #content, body-level tooltip containers).
          ["#planet", "#contentWrapper", "body"].forEach((sel) => {
            const root = parsedDoc.querySelector(sel);
            if (!root) return;
            root.querySelectorAll<HTMLElement>("[data-tipid], [id*='tooltip'], [class*='tooltip'], [class*='popup'], [class*='requirements']").forEach((t) => {
              if (tooltipPopupCandidates.length > 3) return;
              tooltipPopupCandidates.push(`${t.tagName}#${t.id}.${t.className.slice(0, 40)}: ${(t.textContent ?? "").slice(0, 200).trim()}`);
            });
          });
          const kind: "building" | "research" = page === "lfbuildings" ? "building" : "research";
          out[techName] = {
            kind,
            tech_id: techId,
            attrs,
            li_outerHTML: li.outerHTML.slice(0, 1500),
            external_tooltip_candidates: tooltipPopupCandidates.slice(0, 4),
          } as unknown as typeof out[string];
        });
      } catch (e) { console.warn(`[OgameX/dump-lf-requires] ${page} error:`, e); }
    }
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(out).sort()) sorted[k] = out[k]!;
    console.info(`[OgameX/dump-lf-requires] DONE — ${Object.keys(sorted).length} tech rows (v2 outerHTML+attrs). Paste JSON:`);
    console.info(JSON.stringify(sorted, null, 2));
  };
  (env.win as Window & { __ogamexDumpLfRequires?: () => Promise<void> }).__ogamexDumpLfRequires = dumpLfRequiresFn;
  try {
    if (typeof (globalThis as { unsafeWindow?: Window }).unsafeWindow !== "undefined") {
      ((globalThis as { unsafeWindow: Window }).unsafeWindow as Window & { __ogamexDumpLfRequires?: () => Promise<void> }).__ogamexDumpLfRequires = dumpLfRequiresFn;
    }
  } catch { /* */ }
  scheduleBurst(() => { void harvestSlotsFromMovement(); }, 2000);
  // Operator 2026-05-25: "不要用倒計時，都用事件驅動". Removed the 10s
  // setInterval. Triggers that refresh /movement now:
  //   1. eventbox_hook friendly-fleet-count delta (launch OR return)
  //   2. ApiExec sendFleet success (api_executor.ts after step5)
  //   3. wire.ts data.refresh downstream (sidecar's expedition trigger)
  // No periodic poll; if events miss, daemon's data.refresh acts as backup.
  // Expose so eventbox hook + ApiExec can fire it on demand.
  (env.win as Window & { __ogamexHarvestMovement?: () => Promise<void> }).__ogamexHarvestMovement = harvestSlotsFromMovement;

  // v0.0.679/680 — operator 2026-06-03 "改成有任何舰队回航，就触发官方api
  // 拿新的空槽数据" + "全事件驱动". Galaxy JSON owns FLEET slots only:
  //   { system: { usedFleetSlots, maximumFleetSlots, ... } }
  // Expedition slots are NOT in galaxy JSON (verified 2026-06-03 keys dump
  // — only canExpedition bool present). They come from /movement slot
  // indicator regex inside harvestSlotsFromMovement.
  // Both writers fire in parallel via eventbox_hook friendly-count delta.
  async function refreshSlotsViaApi(): Promise<void> {
    try {
      const planetIdEl = env.doc.querySelector<HTMLMetaElement>('meta[name="ogame-planet-id"]');
      const planetId = planetIdEl?.content;
      if (!planetId) return;
      const planet = store.state.planets[planetId];
      if (!planet || !Array.isArray(planet.coords) || planet.coords.length !== 3) return;
      const url = `/game/index.php?page=ingame&component=galaxy&action=fetchGalaxyContent&ajax=1&asJson=1`;
      const body = new URLSearchParams({
        galaxy: String(planet.coords[0]),
        system: String(planet.coords[1]),
      }).toString();
      const r = await env.win.fetch(url, {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "X-Requested-With": "XMLHttpRequest",
        },
        body,
      });
      if (!r.ok) return;
      const j = await r.json() as { system?: { usedFleetSlots?: number; maximumFleetSlots?: number } };
      const sys = (j.system ?? {}) as Record<string, unknown>;
      if (typeof sys.usedFleetSlots !== "number" || typeof sys.maximumFleetSlots !== "number") return;
      const curServer = (store.state.server ?? {}) as { used_expedition_slots?: number; max_expedition_slots?: number };
      const baseMax = expeditionSlots(store.state.research?.levels?.astrophysics ?? 0);
      const classBonus = playerClass === "discoverer" ? 2 : 0;
      const expMax = baseMax + classBonus;
      // v0.0.736 — operator 2026-06-03 "不能用api获取吗 不要扫网页" +
      //   "boot.ts:2076 '真的沒有 api 直接拿 slot 位嗎?' Yes — /movement
      //    chunk ajax".
      // galaxy JSON 验证后 NOT contain expedition fields (sys keys log
      // confirmed v0.0.735: only usedFleetSlots / maximumFleetSlots).
      // Authoritative expedition count = /movement chunk (ajax endpoint,
      // returns each fleet as unique timer_NNNNNNN row, no overcount).
      // Call harvestSlotsFromMovement INLINE (replaces fleets_outbound
      // with truth from /movement). Then count mission=15 entries.
      // Per memory [[feedback_single_source_slot_data]]: /movement owns
      // fleets_outbound, refreshSlotsViaApi owns slot count fields.
      await harvestSlotsFromMovement();
      const mission15Count = (store.state.fleets_outbound ?? [])
        .filter((f) => (f as { mission?: number }).mission === 15).length;
      const expUsed = Math.min(mission15Count, sys.usedFleetSlots, expMax);
      const serverPatch: Record<string, unknown> = {
        ...curServer,
        used_fleet_slots: sys.usedFleetSlots,
        max_fleet_slots: sys.maximumFleetSlots,
      };
      if (expMax > 0) {
        serverPatch.max_expedition_slots = expMax;
        serverPatch.used_expedition_slots = expUsed;
      }
      store.setPartial({ server: serverPatch as typeof store.state.server });
      console.info(`[OgameX/slots-api] fleet ${sys.usedFleetSlots}/${sys.maximumFleetSlots} | exp ${expUsed}/${expMax} (mission15 from /movement ajax = ${mission15Count})`);
    } catch (e) {
      console.warn("[OgameX/slots-api] failed:", e);
    }
  }
  (env.win as Window & { __ogamexRefreshSlots?: () => Promise<void> }).__ogamexRefreshSlots = refreshSlotsViaApi;

  // v0.0.716 — operator 2026-06-03 "前端只要有舰队操作，就往后船 solts 信息".
  // sendFleet success path calls this to append a synthetic fleet record
  // and trigger an immediate state push. Replaces the periodic /movement
  // chunk harvest that used to populate fleets_outbound. Synthetic id =
  // `syn-${Date.now()}`; return time = coarse estimate (90 min for
  // expedition matching operator's ~1h holding + ~10 min each way; 60 min
  // default otherwise). Periodic prune (every 60s) drops expired entries —
  // local in-memory timer, not network polling.
  type FleetLike = (typeof store.state.fleets_outbound)[number];
  // v0.0.718 — operator 2026-06-03 "我们不是有保护cp和token的api吗".
  // Replace pollEmpire (全帝国一刷) with targeted fetchResources(cp=source)
  // via safe_fetch's fetchWithCp. Per-planet payload, cp shift + restore +
  // busy-defer + token rotation handled by the unified wrapper. BusyDeferred
  // is OK — sidecar replans on next event.
  const refreshSourcePlanetResources = async (sourcePlanetId: string): Promise<void> => {
    try {
      const existing = store.state.planets[sourcePlanetId];
      if (!existing) return;
      const resp = await fetchWithCp(
        `/game/index.php?page=fetchResources&ajax=1`,
        { credentials: "same-origin", headers: { "X-Requested-With": "XMLHttpRequest" } },
        sourcePlanetId,
        { bypassBusy: false, skipRestore: false },
      );
      if (!resp.ok) return;
      const j = await resp.json() as {
        resources?: {
          metal?: { amount?: number }; crystal?: { amount?: number };
          deuterium?: { amount?: number }; energy?: { amount?: number };
        };
      };
      if (!j.resources) return;
      const m = j.resources.metal?.amount ?? existing.resources?.m ?? 0;
      const c = j.resources.crystal?.amount ?? existing.resources?.c ?? 0;
      const d = j.resources.deuterium?.amount ?? existing.resources?.d ?? 0;
      const e = j.resources.energy?.amount ?? existing.resources?.e ?? 0;
      // v0.0.743 — operator 2026-06-04 "Leg 1 ... 已经跳过了怎么卡在这里
      // chain prereq: source 6354 ship inventory not yet synced". JG 到港
      // 后 dest planet 的 ships changed (received cargo) 但 fetchResources
      // JSON 只返资源不返 ships → priority_merger ship-inventory check 用
      // stale planet.ships[largeCargo]=0 死锁下一 leg dispatch. 同步刷
      // ships via __ogamexFetchPlanetShips (fleetdispatch chunk inline
      // shipsOnPlanet data block) 才算完整 arrival sync.
      const fetchShips = (env.win as Window & { __ogamexFetchPlanetShips?: (pid: string) => Promise<Record<string, number>> }).__ogamexFetchPlanetShips;
      let freshShips: Record<string, number> | null = null;
      if (typeof fetchShips === "function") {
        try { freshShips = await fetchShips(sourcePlanetId); } catch (e) { console.warn(`[fleet-launch-record] fetchPlanetShips threw`, e); }
      }
      // v0.0.755 — operator "事件驱动 不要扫网页". 改 setPlanetsPatch (merge
       // 不 spread) 避免 race: 之前用 {...store.state.planets, [pid]: {...existing,
       // resources, ships}} 用 stale `existing` snapshot 覆盖中间 commitCooldown
       // 写入的 jumpgate_cooldown_sec/pair_with → JG 双边 cd 单边丢失 bug.
      store.setPlanetsPatch({
        [sourcePlanetId]: {
          resources: { m, c, d, e },
          ...(freshShips ? { ships: freshShips } : {}),
        },
      });
      const shipsTag = freshShips ? ` + ships (${Object.entries(freshShips).filter(([_, n]) => n > 0).map(([k, n]) => `${k}=${n}`).slice(0, 5).join(",")}...)` : " (ships fetch unavailable)";
      console.info(`[fleet-launch-record] refreshed source ${sourcePlanetId} resources (m=${m} c=${c} d=${d} e=${e})${shipsTag}`);
    } catch (e) {
      if (e instanceof BusyDeferredError) {
        console.info(`[fleet-launch-record] refresh deferred — operator busy; sidecar will re-plan on next event`);
        return;
      }
      console.warn("[fleet-launch-record] refreshSourcePlanetResources threw:", e);
    }
  };
  const recordFleetLaunch = (params: {
    mission: number;
    sourcePlanetId?: string;
    origin: readonly number[];
    originType?: "planet" | "moon";
    dest: readonly number[];
    destType?: "planet" | "moon";
  }): void => {
    try {
      const launchedAt = Date.now();
      // v0.0.733 — operator 2026-06-03 "synthetic.return_at = launch+90min 这个没用就删了吧".
      // ttl-based prune RETIRED. Synthetic now lives until eventbox poll
      // detects its mission's count drop (per-mission FIFO prune). Sidecar
      // Signal B still gates on return_at !== null as "fleet committed to
      // return path" — set return_at = launchedAt (non-null sentinel,
      // value itself unused).
      // v0.0.720 — operator 2026-06-03 "运输任务的链式任务竟然可以一起执行".
      // fleet_api.ts 传 origin=[0,0,0] (no coord context at that layer);
      // sidecar chain prereq inTransit check does `f.origin.join(":") ===
      // srcCoords` — [0,0,0] 永不匹配 → downstream legs 并行触发。Self-derive
      // real origin coords from store.planets[sourcePlanetId] when caller's
      // origin is zero/missing.
      let effectiveOrigin: readonly number[] = params.origin;
      let effectiveOriginType: "planet" | "moon" = params.originType ?? "planet";
      if ((!effectiveOrigin || effectiveOrigin.every((n) => n === 0)) && params.sourcePlanetId) {
        const sp = store.state.planets[params.sourcePlanetId];
        if (sp && Array.isArray(sp.coords) && sp.coords.length === 3) {
          effectiveOrigin = sp.coords;
          if ((sp as { type?: string }).type === "moon") effectiveOriginType = "moon";
        }
      }
      const synthetic = {
        id: `syn-${launchedAt}`,
        source_planet_id: params.sourcePlanetId,  // v0.0.719 — return path reuse
        mission: params.mission,
        origin: effectiveOrigin as unknown,
        origin_type: effectiveOriginType,
        dest: params.dest as unknown,
        dest_type: params.destType ?? "planet",
        arrival_at: 0,
        return_at: launchedAt,  // v0.0.733 — non-null sentinel; ttl prune retired
        ships: {} as Record<string, number>,
      } as unknown as FleetLike;
      const cur = store.state.fleets_outbound ?? [];
      store.setPartial({ fleets_outbound: [...cur, synthetic] as typeof store.state.fleets_outbound });
      const pushNow = (env.win as Window & { __ogamexPushNow?: () => void }).__ogamexPushNow;
      if (typeof pushNow === "function") { try { pushNow(); } catch { /* */ } }
      // v0.0.726 — operator 2026-06-03 "我发了舰队去月球 usedFleetSlots = 0
      // 为什么没有更新". recordFleetLaunch 之前只刷源星球资源, galaxy slot
      // 数 (used_fleet_slots / max_fleet_slots) 要等 eventbox-hook 5s 后才
      // refresh, panel 滞后看到旧值。Galaxy JSON 跟资源 fetch 并行触发,
      // sidecar 立刻拿到新 slot 数字, 0-5s 滞后消除。
      void refreshSlotsViaApi()
        .then(() => { if (typeof pushNow === "function") { try { pushNow(); } catch { /* */ } } });
      if (params.sourcePlanetId) {
        void refreshSourcePlanetResources(params.sourcePlanetId)
          .then(() => { if (typeof pushNow === "function") { try { pushNow(); } catch { /* */ } } });
      }
      // v0.0.728 — operator 2026-06-03 "不用任何评估，舰队到达都会触发事件，
      // 全事件驱动 为什么要有评估？". v0.0.727 setTimeout(arrivalEtaMs) 拆掉。
      // Arrival 改走 eventbox_hook own-fleet row 的 data-arrival-time:
      // poll 检测 arrival_at ≤ now AND 未 fired → 调 __ogamexRefreshPlanetResources
      // (window export 见下方)。零评估, 纯事件驱动。
      console.info(`[fleet-launch-record] +synthetic ${synthetic.id} mission=${params.mission} (eventbox count-drop will prune), refreshSlots + fetchResources(cp=${params.sourcePlanetId ?? "?"}) scheduled`);
    } catch (e) { console.warn("[fleet-launch-record] threw:", e); }
  };
  (env.win as Window & { __ogamexRecordFleetLaunch?: typeof recordFleetLaunch }).__ogamexRecordFleetLaunch = recordFleetLaunch;
  // v0.0.728 — expose the same cp-protected per-planet refresh helper so
  // eventbox_hook can call it on own-fleet arrival events. Returns a
  // Promise so caller can chain pushNow on resolve.
  (env.win as Window & { __ogamexRefreshPlanetResources?: (pid: string) => Promise<void> }).__ogamexRefreshPlanetResources = refreshSourcePlanetResources;

  // v0.0.755 — operator "用 api / 事件驱动 不要扫网页". executeJump response
  // 自身返回 cd field (resp.cooldown / nextActionAt), api_executor 已捕获.
  // 旧路径走 sniffer-postMessage-CASE-B-HTML-overlay-regex, 改一刀直写双边
  // store. 0 网页扫描, 0 race window (atomic setPlanetsPatch).
  (env.win as Window & { __ogamexCommitJgCd?: (src: string, tgt: string, cdSec: number) => void }).__ogamexCommitJgCd =
    (src: string, tgt: string, cdSec: number): void => {
      if (!src || !tgt || !Number.isFinite(cdSec) || cdSec <= 0) return;
      const now = Date.now();
      const patch: Record<string, Partial<typeof store.state.planets[string]>> = {};
      if (store.state.planets[src]) {
        patch[src] = { jumpgate_cooldown_sec: cdSec, jumpgate_harvested_at: now, jumpgate_pair_with: tgt };
      }
      if (store.state.planets[tgt]) {
        patch[tgt] = { jumpgate_cooldown_sec: cdSec, jumpgate_harvested_at: now, jumpgate_pair_with: src };
      }
      if (Object.keys(patch).length > 0) {
        store.setPlanetsPatch(patch);
        try { window.localStorage.setItem("ogamex.panel.section.moons", "false"); } catch { /* */ }
        const pushNow = (env.win as Window & { __ogamexPushNow?: () => void }).__ogamexPushNow;
        if (typeof pushNow === "function") { try { pushNow(); } catch { /* */ } }
        console.info(`[OgameX/jg-commit] api-driven cd=${cdSec}s src=${src} tgt=${tgt} (${Object.keys(patch).length} sides written)`);
      } else {
        console.warn(`[OgameX/jg-commit] both moons missing in store: src=${src} tgt=${tgt}`);
      }
    };
  // v0.0.748 — operator 2026-06-04 "sandbox" 一字诊断: TM sandbox 隔离下
  // 单挂 env.win 不够, devtools console (page world) 拿不到. dual-expose
  // 到 unsafeWindow 让 operator 能 console 直接救现状 (例如历史死锁未被
  // v0.0.747 arrival hook 救到的 stale moon ships).
  try {
    const pwExp = (typeof unsafeWindow !== "undefined" ? unsafeWindow : env.win) as Window & { __ogamexRefreshPlanetResources?: (pid: string) => Promise<void> };
    pwExp.__ogamexRefreshPlanetResources = refreshSourcePlanetResources;
  } catch { /* sandbox might forbid cross-world expose */ }
  // v0.0.733 — operator 2026-06-03 "synthetic.return_at = launch+90min 这个
  // 没用就删了吧". Pre-v0.0.733 pruneExpiredFleets() + 60s setInterval +
  // __ogamexPruneFleets export 全部退役. synthetic 现在生命周期完全由
  // eventbox per-mission count drop 触发: 单一权威源 = ogame eventbox,
  // 单一抓手 = pruneByMission(mission, N). ttl 估算永远会落后或抢跑,
  // 不如直接听 ogame 的.
  //
  // v0.0.732 pruneMission15 generalized to pruneByMission: eventbox poll
  // 检测任意 mission 的 own-fleet count 下降 N, FIFO 删 N 个 oldest
  // synthetic with 该 mission. 同时 refresh 它们的 source_planet (回港
  // 资源更新, 替代 pruneExpiredFleets 里的 source planet refresh path).
  const pruneByMission = (mission: number, count: number): void => {
    try {
      if (!Number.isFinite(mission) || !Number.isFinite(count) || count <= 0) return;
      const cur = store.state.fleets_outbound ?? [];
      const matchingFleets = cur.filter((f) => (f as { mission?: number }).mission === mission);
      const otherFleets = cur.filter((f) => (f as { mission?: number }).mission !== mission);
      const keep = matchingFleets.slice(count);
      const dropped = matchingFleets.slice(0, count);
      if (dropped.length === 0) return;
      store.setPartial({ fleets_outbound: [...otherFleets, ...keep] as typeof store.state.fleets_outbound });
      // Source planet refresh for each dropped synthetic (return-home resource update).
      // (Dest-side arrival refresh lives in eventbox_hook.ts v0.0.747
      // arrival-by-disappearance, which is the proper architectural fix and
      // covers cases where fleets_outbound has no matching row.)
      const ids = new Set(
        dropped.map((f) => (f as { source_planet_id?: string }).source_planet_id)
          .filter((x): x is string => typeof x === "string"),
      );
      const pushNow = (env.win as Window & { __ogamexPushNow?: () => void }).__ogamexPushNow;
      for (const pid of ids) {
        void refreshSourcePlanetResources(pid).then(() => {
          if (typeof pushNow === "function") { try { pushNow(); } catch { /* */ } }
        });
      }
      if (typeof pushNow === "function") { try { pushNow(); } catch { /* */ } }
      console.info(`[fleet-prune] dropped ${dropped.length} mission=${mission} synthetic(s) on eventbox count-drop; refreshed ${ids.size} source planet(s); ids=${dropped.map((f) => (f as { id?: string }).id ?? "?").join(",")}`);
    } catch (e) { console.warn(`[fleet-prune] mission=${mission} prune threw`, e); }
  };
  (env.win as Window & { __ogamexPruneByMission?: (mission: number, n: number) => void }).__ogamexPruneByMission = pruneByMission;

  // Jumpgate cooldown harvester — DELETED 2026-05-27 (architecture migration).
  // Original purpose: probe each moon's jumpgate overlay every boot+15s + 24h
  // throttle to fill store.jumpgate_cooldown_sec. Replaced by:
  //   1. sniffer (page-world) intercepts ogame's real executeJump POST
  //   2. sandbox CASE B fires overlay re-fetch via fetchWithCpBypassBusy
  //   3. sync-log in localStorage survives page-navigate; boot+2s hydrate
  // Old code dropped (~110 lines). Function not exposed; no callers.
  // 2026-05-27 operator: "不要用 boot 時的 harvest 探針 改成截取跳躍事件 / 事件驅動".
  // harvestJumpgateCooldowns() FULLY DEPRECATED — boot 時不再 fire, 不再 expose.
  // 僅靠 sniffer (fetch+XHR+form-submit) 截取 ogame 真實 jumpgate POST 事件
  // → message listener 寫 source.pair_with=target + target.pair_with=source.
  // Boot 時清空所有月球已有的 jumpgate_cooldown_sec — 那些是歷史 harvest 來的
  // 污染資料 (無 pair, 時間不準, 3-singles 顯示 bug 根因). 靜默清掉.
  setTimeout(() => {
    // Operator 2026-05-27 evidence: aggressive clear-on-boot wiped 9 jumpgate
    // fields → hydrate then race-skipped (expedition fired concurrent cp=,
    // session-cp clobbered) → panel went from 3 rows to 0.
    //
    // New policy: TRUST IDB-hydrated data (last-session's accurate writes
    // with pair_with). Only clear obviously-expired entries (harvested_at
    // > 2h ago, well beyond jumpgate max cooldown ~60min). Hydrate then
    // refreshes precise cd for entries still in 2h window.
    const planets = store.state.planets ?? {};
    const now = Date.now();
    const expiredPatch: Record<string, Partial<typeof planets[string]>> = {};
    for (const [id, p] of Object.entries(planets)) {
      if (p.type !== "moon" || typeof p.jumpgate_cooldown_sec !== "number") continue;
      const at = p.jumpgate_harvested_at ?? 0;
      if (at > 0 && now - at > 2 * 3600_000) {
        expiredPatch[id] = { jumpgate_cooldown_sec: null, jumpgate_harvested_at: null, jumpgate_pair_with: null };
      }
    }
    if (Object.keys(expiredPatch).length > 0) {
      store.setPlanetsPatch(expiredPatch);
      console.info(`[OgameX/jumpgate] cleared ${Object.keys(expiredPatch).length} >2h-old cooldowns (definitely expired)`);
    }

    // Operator 2026-05-27: hydrate from sniffer's sync localStorage log.
    // Page navigate race kills sandbox async re-fetch; sniffer writes
    // OGAMEX_JUMPGATE_LOG synchronously before navigate. For each log entry,
    // fire overlay re-fetch to get PRECISE remaining cooldown (jumpgate level
    // → cooldown 1800/2400/3600 都可能, 不能 hardcode).
    try {
      const log = JSON.parse(env.win.localStorage.getItem("OGAMEX_JUMPGATE_LOG") || "[]") as Array<{ts: number; src: string; tgt: string}>;
      const now = Date.now();
      // Dedupe by src (latest entry per source moon wins).
      const latestBySrc = new Map<string, {ts: number; src: string; tgt: string}>();
      for (const entry of log) {
        const cur = latestBySrc.get(entry.src);
        if (!cur || entry.ts > cur.ts) latestBySrc.set(entry.src, entry);
      }
      // Skip entries older than 2 hours (any jumpgate cooldown maxes at <2h).
      const candidates = Array.from(latestBySrc.values())
        .filter(e => (now - e.ts) < 2 * 3600_000)
        .filter(e => {
          const src = store.state.planets?.[e.src];
          if (!src || src.type !== "moon") return false;
          // 已經有更新的精確 cd (CASE B 校正), 不重新 fetch
          if (typeof src.jumpgate_cooldown_sec === "number" && src.jumpgate_cooldown_sec > 0
              && src.jumpgate_harvested_at && src.jumpgate_harvested_at > e.ts) return false;
          return true;
        });
      // v0.0.524 — REVERT v0.0.515 (operator 2026-05-31 "又開始自動切星球了").
      // v0.0.515 加的"掃所有有 JG 月球 cp= overlay 拉真值"會讓 ogame 頂欄
      // 9 次跳來跳去, 視覺很糟。 退回 log-only candidates (sniffer 抓到的才
      // 探測), 完全事件驅動。 跨 session 的 cooldown 等 sniffer 下次抓。
      if (candidates.length > 0) {
        // Operator 2026-05-27 evidence: 3 rows with identical cd=29:15 after
        // multi-moon hydrate. ogame session-cp is single-slot per session;
        // concurrent cp= fetches RACE on server side. All N parallel overlays
        // see whichever cp won the race → all return SAME moon's cooldown.
        // Serial the loop to give each cp= fetch a clean session-cp window.
        // Also verify origin coords from response — defense-in-depth against
        // session-cp race even when serial.
        console.info(`[OgameX/jumpgate] hydrating ${candidates.length} cooldown(s) from sync log (SERIAL to avoid session-cp race)`);
        void (async (): Promise<void> => {
          // v0.0.632 — owner 2026-06-01 "有沒有其他的沒有使用標準接口?".
          // JG cooldown hydrate is sniffer-driven but NOT directly owner-
          // requested at this moment — it's a deferred background reconcile
          // for cooldowns we observed earlier. Per memory cp-shift-visible:
          // "operator busy 時所有 cp= fetch 必須 defer". Switch to standard
          // fetchWithCp (bypassBusy:false) so safe_fetch.awaitCpIdle gates
          // each iteration until owner stops clicking. Restore stays on.
          const { fetchWithCp } = await import("./api/safe_fetch.js");
          for (const entry of candidates) {
            try {
              const r = await fetchWithCp(
                `/game/index.php?page=ajax&component=jumpgate&overlay=1&ajax=1`,
                { credentials: "same-origin", headers: { "X-Requested-With": "XMLHttpRequest" } },
                entry.src,
              );
              const html = await r.text();
              // Origin verify: parse 起始座標 from response; if it doesn't match
              // entry.src's coords, server saw a different cp (race) — skip.
              const originMatch = html.match(/起始座[標標][\s\S]{0,300}?\[(\d+):(\d+):(\d+)\]/);
              if (originMatch) {
                const got = `${originMatch[1]}:${originMatch[2]}:${originMatch[3]}`;
                const want = (store.state.planets[entry.src]?.coords ?? []).join(":");
                if (want && got !== want) {
                  console.warn(`[OgameX/jumpgate] hydrate src=${entry.src} session-cp race: wanted ${want} got ${got} — skipping`);
                  continue;
                }
              }
              let parsedCd: number | null = null;
              const patterns = [
                /simpleCountdown\s*\(\s*\$\(["']#cooldown["']\)\s*,\s*(\d+)/,
                /simpleCountdown\s*\(\s*[^,)]+,\s*(\d+)/,
              ];
              for (const re of patterns) {
                const m = html.match(re);
                if (m && m[1]) { parsedCd = parseInt(m[1], 10); if (!isNaN(parsedCd) && parsedCd > 0) break; parsedCd = null; }
              }
              if (parsedCd === null || parsedCd <= 0) {
                console.warn(`[OgameX/jumpgate] hydrate src=${entry.src}: overlay says no cooldown (already ready or parse failed). Skipping.`);
                continue;
              }
              if (!store.state.planets[entry.src]) continue;
              // v0.0.525 — operator 2026-05-31 "目的月球的冷卻時間沒抓到".
              // ogame 物理: JG 跳躍後 BOTH src 和 tgt 月球都進 cooldown
              // (每月球只 1 個 JG, 用過 = 充能). 之前只在 src 寫 cd_sec, target
              // 只寫 pair_with → target panel 不顯示倒計時。 現在 target 也
              // 同步 cd_sec + harvested_at。
              const harvestNow = Date.now();
              const hydratePatch: Record<string, Partial<typeof store.state.planets[string]>> = {
                [entry.src]: entry.tgt
                  ? { jumpgate_cooldown_sec: parsedCd, jumpgate_harvested_at: harvestNow, jumpgate_pair_with: entry.tgt }
                  : { jumpgate_cooldown_sec: parsedCd, jumpgate_harvested_at: harvestNow },
              };
              if (entry.tgt && store.state.planets[entry.tgt]) {
                hydratePatch[entry.tgt] = {
                  jumpgate_cooldown_sec: parsedCd,
                  jumpgate_harvested_at: harvestNow,
                  jumpgate_pair_with: entry.src,
                };
              }
              store.setPlanetsPatch(hydratePatch);
              const fmt = (s: number): string => `${Math.floor(s/60)}:${(s%60).toString().padStart(2,"0")}`;
              console.info(`[OgameX/jumpgate] hydrated src=${entry.src} tgt=${entry.tgt} cd=${fmt(parsedCd)} (precise from overlay)`);
            } catch (e) {
              if (e instanceof BusyDeferredError) {
                console.info(`[OgameX/jumpgate] hydrate src=${entry.src} deferred (operator busy); will retry on next state.updated tick`);
              } else {
                console.warn(`[OgameX/jumpgate] hydrate fetch failed src=${entry.src}:`, e);
              }
            }
          }
        })();
      }
    } catch (e) { console.warn("[OgameX/jumpgate] hydrate from log failed:", e); }
  }, 2_000);

  // PARASITIC EVENTBOX HOOK — replaces failed /movement-based pollInboundFleets.
  // Rationale (corrected from earlier design): /movement endpoint returns ONLY
  // MY OWN outgoing fleets, NEVER foreign incoming. Incoming attack/spy events
  // live in ogame's eventList endpoint, which the native client polls every 5s.
  // We hook XHR + fetch to PARASITIZE that poll — zero extra requests, perfect
  // sync with what ogame's UI itself sees. Watchdog self-fetches if ogame's
  // own poll stalls (tab backgrounded). See probes/eventbox_hook.ts.
  const eventboxHook = installEventBoxHook({ store, win: env.win });
  void eventboxHook; // handle kept alive via closure; .stop() if we add teardown

  // Slot harvest via ajax fleetdispatch fragment — operator 2026-05-25:
  // "slot harvest 也改 ajax". ogame's SPA navigation uses
  // `&ajax=1&asJson=1` on fleetdispatch which returns a JSON envelope
  // containing the page's `<div id="slots">...</div>` HTML fragment
  // INSTEAD of the full ~500KB page chrome. ~5-15KB payload, no
  // browser-tab render side effects.
  //
  // Response shape (verified empirically): { components: [...],
  // newAjaxToken: "...", ... } where components includes an entry
  // for the slots container with `html` field. We scan the entire JSON
  // text for the slot labels — robust against component-array layout
  // changes.
  async function harvestSlotsFromFleetdispatch(): Promise<void> {
    // Operator 2026-05-25 "真的沒有 api 直接拿 slot 位嗎?". Yes — /movement
    // is the ajax-only (page=componentOnly&ajax=1) endpoint we already use
    // via harvestSlotsFromMovement, and its HTML renders the
    // "艦隊:X/Y 遠征艦隊:N/M" labels. Delegate. Keeps a single source of
    // truth for slot harvest + drops the heavy /fleetdispatch HTML fetch.
    return harvestSlotsFromMovement();
  }
  scheduleBurst(() => { void harvestSlotsFromFleetdispatch(); }, 3500);
  // Operator 2026-05-25: "不要用倒計時，都用事件驅動". Removed 30s setInterval;
  // slot caps from /fleetdispatch are now refreshed by ApiExec when it
  // touches that endpoint as part of its expedition/save flows.
  // Operator 2026-05-25 follow-up "遠征有空槽沒有自動起飛": daemon needs
  // accurate max_expedition_slots to decide free slots. The computed
  // fallback (sqrt(astro) + class) misses lifeform tech bonus. Expose
  // so wire.ts data.refresh handler can trigger a fresh harvest on
  // demand from sidecar without waiting for an expedition launch.
  (env.win as Window & { __ogamexHarvestFdSlots?: () => Promise<void> }).__ogamexHarvestFdSlots = harvestSlotsFromFleetdispatch;

  // (pollEventList REMOVED — parasitic eventbox_hook now handles eventList
  //  intercept via ogame's own native 5s poll. Self-fetch watchdog inside
  //  the hook covers the gap when ogame's poll stalls.)

  // FALLBACK: scrape from current page DOM (less reliable):
  // Extract BOTH used & max because ogame's `floor(sqrt)` formula misses
  // class/lifeform bonuses AND we can't count expedition fleets in
  // fleets_outbound when the page didn't render them.
  function harvestSlots(): void {
    // Scan the WHOLE document body for the labelled pairs. ogame uses
    // <span> with classes like `tooltipHTML`, but the text is everywhere.
    // ogame v12 fleetdispatch renders slot counters in a specific element.
    // Most-targeted path: `#slots` div with two children "1/2" + "1/2".
    // Fall back to scanning the page for labelled "<label> N/M" patterns.
    let max_fleet = 0, used_fleet = 0;
    let max_expedition = 0, used_expedition = 0;
    // Target 1: ogame's #slots / .slots container — render-stable across skins.
    const slotsEl = env.doc.querySelector<HTMLElement>("#slots, .slots, #fleetstatusbar, .fleetstatusbar");
    if (slotsEl) {
      // Children typically: fleet slot first, expedition slot second.
      // Parse with order-aware regex on the textContent.
      const txt = slotsEl.textContent ?? "";
      // Look for two "N/M" pairs in order.
      const pairs = Array.from(txt.matchAll(/(\d+)\s*\/\s*(\d+)/g)).map((m) => [parseInt(m[1]!, 10), parseInt(m[2]!, 10)] as const);
      if (pairs.length >= 1) { used_fleet = pairs[0]![0]; max_fleet = pairs[0]![1]; }
      if (pairs.length >= 2) { used_expedition = pairs[1]![0]; max_expedition = pairs[1]![1]; }
    }
    // No fallback body-scan — it picks up `🛸 Expeditions 1/1 (astro 2)`
    // tooltip text on supplies/overview which is NOT the real slot count.
    // The real slot count lives in #slots container only. If that's not
    // present on this page, fleetdispatch bg fetcher fills it.
    if (max_expedition === 0 && max_fleet === 0) return;
    // v0.0.685: OGAMEX_MAX_EXP / OGAMEX_MAX_FLEET localStorage writes removed
    // (no consumer — see boot.ts:357 hydration removal note).
    const cur = store.state;
    store.setPartial({
      server: {
        ...(cur.server ?? {}),
        ...(max_expedition > 0 ? { max_expedition_slots: max_expedition, used_expedition_slots: used_expedition } : {}),
        ...(max_fleet > 0 ? { max_fleet_slots: max_fleet, used_fleet_slots: used_fleet } : {}),
      } as typeof cur.server,
    });
    // (slots-extracted log silenced — running every 5-8s, no diagnostic value
    //  in steady state. Resurfaces via server.{max,used}_*_slots in /v1/state.)
  }
  // Boot retries (5 attempts in 20s) catch the slot-bar DOM as it
  // hydrates. Operator 2026-05-25: "不要用倒計時，都用事件驅動".
  // Removed continuous 30s setInterval — slot caps change rarely and
  // pollEmpire / harvestSlotsFromMovement events catch slot changes.
  [800, 2400, 4800, 10_000, 20_000].forEach((ms) => scheduleBurst(harvestSlots, ms));
  // v0.0.735 — operator 2026-06-03 "不能用api获取吗 不要扫网页". DOM
  // scrape RETIRED per [[feedback_ajax_not_html_scrape]]. used_expedition_
  // slots must come from ogame ajax endpoint. Probing galaxy JSON for
  // expedition fields in refreshSlotsViaApi (see logged sys.* keys);
  // until confirmed, fall back to synthetic mission=15 count + max cap.

  function harvestQueues(): void {
    const actives = env.doc.querySelectorAll<HTMLElement>('li.technology[data-status="active"]');
    if (actives.length === 0) return;
    for (const li of actives) {
      const numeric = li.getAttribute("data-technology") ?? "";
      const name = TECH_ID_TO_NAME[numeric];
      if (!name) continue;
      // ogame renders countdown via either <time data-end> or a child
      // <span class="time"> with epoch in attribute. Probe multiple shapes.
      const timeEl = li.querySelector<HTMLElement>("[data-end], time, .time");
      let ends_at: number | null = null;
      const endAttr = timeEl?.getAttribute("data-end") ?? timeEl?.getAttribute("data-target-time");
      if (endAttr) {
        const n = Number(endAttr);
        if (Number.isFinite(n)) ends_at = n * (n < 1e12 ? 1000 : 1);
      }
      // Fallback: parse hh:mm:ss in textContent → relative offset.
      if (ends_at === null) {
        const txt = timeEl?.textContent ?? li.textContent ?? "";
        const m = txt.match(/(\d+)h\s*(\d+)m\s*(\d+)s/i)
              ?? txt.match(/(\d+):(\d+):(\d+)/);
        if (m) {
          const sec = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
          ends_at = Date.now() + sec * 1000;
        }
      }
      const technology_id = parseInt(numeric, 10);
      const kind = idKind(technology_id);
      if (kind === "research") {
        // research queue is player-global
        const cur = store.state.research ?? { levels: {}, queue: null };
        const target_level = (cur.levels[name] ?? 0) + 1;
        store.setPartial({
          research: {
            ...cur,
            queue: { tech: name, technology_id, level: target_level, ends_at: ends_at ?? Date.now() + 60000 } as typeof cur.queue,
          },
        });
        console.log(`[OgameX] research queue: ${name} L${target_level} ends_at=${ends_at}`);
      } else if (kind === "ship" || kind === "defense") {
        if (Object.keys(store.state.planets).length === 0) continue;
        const activeIdRaw = env.doc.querySelector<HTMLMetaElement>('meta[name="ogame-planet-id"]')?.content ?? "";
        const target = activeIdRaw ? store.state.planets[activeIdRaw] : undefined;
        if (!target) continue;
        const cnt = (target.ships?.[name] ?? 0);
        store.setPlanetsPatch({
          [activeIdRaw]: {
            shipyard_q: { ship: name, technology_id, count: cnt + 1, ends_at: ends_at ?? Date.now() + 60000 } as typeof target.shipyard_q,
          },
        });
        console.log(`[OgameX] shipyard queue (planet ${activeIdRaw}): ${name}`);
      } else {
        if (Object.keys(store.state.planets).length === 0) continue;
        const activeIdRaw = env.doc.querySelector<HTMLMetaElement>('meta[name="ogame-planet-id"]')?.content ?? "";
        const target = activeIdRaw ? store.state.planets[activeIdRaw] : undefined;
        if (!target) continue;
        const target_level = (target.buildings?.[name] ?? 0) + 1;
        store.setPlanetsPatch({
          [activeIdRaw]: {
            build_q: { building: name, technology_id, level: target_level, ends_at: ends_at ?? Date.now() + 60000 } as typeof target.build_q,
          },
        });
        console.log(`[OgameX] build queue (planet ${activeIdRaw}): ${name} L${target_level}`);
      }
    }
  }
  // Run at +500ms (after planets settle) + retry windows.
  [600, 2200, 4600].forEach((ms) => scheduleBurst(harvestQueues, ms));
  // Also re-run on any DOM mutation in research/supplies areas.
  bus.on("dom.changed", (payload: unknown) => {
    const p = payload as { targetId?: string } | undefined;
    const t = p?.targetId ?? "";
    if (t.includes("technologies") || t.includes("buildlist") || t.includes("queue")) {
      harvestQueues();
    }
  });

  // ─── Background page refresher ─────────────────────────────────────────
  // Periodically fetch ogame pages in the background (same-origin, no UI
  // disruption) and re-run extractors on the fetched HTML. Without this,
  // state.research.queue / planet.build_q / ships go stale when the
  // operator isn't actively navigating between supplies/facilities/
  // research/shipyard. ApiExecutor already token-fetches each page on
  // dispatch; this complements that by keeping STATE fresh, not just
  // tokens.
  // PRIMARY state poller — ogame's own fetchResources JSON endpoint
  // returns resources + queue + production + planet data atomically.
  // Way faster than HTML page scraping. Updates state every 5s.
  async function pollFetchResources(): Promise<void> {
    try {
      // Only poll CURRENT planet. Earlier we rotated through all planets
      // to refresh stale lifeform_resources, but every cp= GET sets the
      // ogame session current-planet cookie. That poisoned ApiExec
      // sendFleet (sees wrong planet → 140054 可用艦船不足). Cross-planet
      // resource freshness now comes from refreshOnePage which is rate-
      // limited and runs less frequently. Worst case stale colony data
      // for a few minutes is acceptable; broken expeditions are not.
      const planetId = env.doc.querySelector<HTMLMetaElement>('meta[name="ogame-planet-id"]')?.content;
      if (!planetId) return;
      // cp=current ≈ no shift; skipRestore + bypassBusy keep periodic poll cheap.
      const resp = await fetchWithCp(
        `/game/index.php?page=fetchResources&ajax=1`,
        { credentials: "same-origin", headers: { "X-Requested-With": "XMLHttpRequest" } },
        planetId,
        { bypassBusy: true, skipRestore: true },
      );
      if (!resp.ok) return;
      const j = await resp.json() as Record<string, unknown> & {
        resources?: { metal?: { amount?: number; production?: number }; crystal?: { amount?: number; production?: number }; deuterium?: { amount?: number; production?: number }; energy?: { amount?: number } };
        techs?: Record<string, { count?: number }>;
        buildqueue?: Array<{ technologyId?: number; level?: number; endTime?: number; ends_at?: number; name?: string }>;
        researchqueue?: Array<{ technologyId?: number; level?: number; endTime?: number; name?: string }>;
        shipyardqueue?: Array<{ technologyId?: number; count?: number; endTime?: number; name?: string }>;
      };
      // (fetchResources top-level key dump silenced — schema stable.)
      const cur = store.state;
      const patch: Partial<typeof cur> = {};
      // Resources — route to ACTIVE planet (per-planet, like buildings/ships).
      // fetchResources returns whatever planet ogame is currently displaying;
      // writing it to home's slot would clobber colony data and vice-versa.
      const activeIdRaw = env.doc.querySelector<HTMLMetaElement>('meta[name="ogame-planet-id"]')?.content ?? "";
      const existing = activeIdRaw ? cur.planets[activeIdRaw] : undefined;
      if (j.resources && existing) {
        type PlanetT = typeof existing;
        const m = j.resources.metal?.amount ?? existing.resources?.m ?? 0;
        const c = j.resources.crystal?.amount ?? existing.resources?.c ?? 0;
        const d = j.resources.deuterium?.amount ?? existing.resources?.d ?? 0;
        const e = j.resources.energy?.amount ?? existing.resources?.e ?? 0;
        // Lifeform: population.storage = 生活空間 (living_space), food.capableToFeed = 酒足飯飽 (well_fed).
        // Operator rule: build residentialSector unless living_space > well_fed.
        const popJson = (j.resources as { population?: { amount?: number; storage?: number } }).population;
        const foodJson = (j.resources as { food?: { amount?: number; capableToFeed?: number } }).food;
        const lf_population = popJson?.amount ?? null;
        const lf_living_space = popJson?.storage ?? null;
        const lf_well_fed = foodJson?.capableToFeed ?? null;
        const lf_food_amount = foodJson?.amount ?? null;
        const lfExtra = (lf_living_space !== null || lf_well_fed !== null) ? {
          lifeform_resources: {
            population: lf_population, living_space: lf_living_space,
            well_fed: lf_well_fed, food: lf_food_amount,
          },
        } : {};
        let updatedPlanet: PlanetT = { ...existing, resources: { m, c, d, e }, ...lfExtra };
        // Production
        if (j.resources.metal?.production != null) {
          updatedPlanet = {
            ...updatedPlanet,
            production: {
              m_h: Math.round((j.resources.metal.production ?? 0) * 3600),
              c_h: Math.round((j.resources.crystal?.production ?? 0) * 3600),
              d_h: Math.round((j.resources.deuterium?.production ?? 0) * 3600),
            },
          };
        }
        // Build/Shipyard/Research queue: ONLY update if fetchResources
        // actually carries the field. This server doesn't include them;
        // clearing on absence would clobber the HTML-scraped truth.
        if (Array.isArray(j.buildqueue)) {
          const bq = j.buildqueue[0];
          if (bq && bq.technologyId) {
            const name = TECH_NAME_BY_ID[bq.technologyId];
            if (name) {
              updatedPlanet = {
                ...updatedPlanet,
                build_q: { building: name, technology_id: bq.technologyId, level: bq.level ?? 1, ends_at: (bq.endTime ?? bq.ends_at ?? 0) * 1000 } as PlanetT["build_q"],
              };
            }
          } else {
            updatedPlanet = { ...updatedPlanet, build_q: null };
          }
        }
        if (Array.isArray(j.shipyardqueue)) {
          const sq = j.shipyardqueue[0];
          if (sq && sq.technologyId) {
            const sname = TECH_NAME_BY_ID[sq.technologyId];
            if (sname) {
              updatedPlanet = {
                ...updatedPlanet,
                shipyard_q: { ship: sname, technology_id: sq.technologyId, count: sq.count ?? 1, ends_at: ((sq.endTime ?? 0) * 1000) } as PlanetT["shipyard_q"],
              };
            }
          } else {
            updatedPlanet = { ...updatedPlanet, shipyard_q: null };
          }
        }
        patch.planets = { ...cur.planets, [activeIdRaw]: updatedPlanet };
      }
      // Research queue — same field-presence guard.
      if (Array.isArray(j.researchqueue)) {
        const rq = j.researchqueue[0];
        if (rq && rq.technologyId) {
          const tname = TECH_NAME_BY_ID[rq.technologyId];
          // Carry BOTH canonical name (for display) AND numeric id (for
          // robust comparison) — see Pass 2 refactor 2026-05-21.
          if (tname) patch.research = { ...cur.research, queue: { tech: tname, technology_id: rq.technologyId, level: rq.level ?? 1, ends_at: ((rq.endTime ?? 0) * 1000) } as typeof cur.research.queue };
        } else if (cur.research?.queue) {
          patch.research = { ...cur.research, queue: null };
        }
      }
      if (Object.keys(patch).length > 0) {
        store.setPartial(patch);
        // (silenced — happens every 5s, expected steady-state)
      }
    } catch (e) {
      void e;
    }
  }
  // Boot seed + 30s safety net (was 5s — 12 req/min). 30s = 2/min, light.
  // ogame's own client polls /fetchResources every 5s for its resource bar;
  // we COULD parasite via eventbox_hook (isFetchResourcesURL filter wired)
  // — but the parser is tightly coupled to the fetch here. Lighter to just
  // slow our own poll than refactor parser into a callable. Operator
  // directive "改成事件觸發": event-driven via DOM mutation observers
  // already updates resources when user navigates; this 30s is just for
  // background-tab cases where mutations don't fire.
  scheduleBurst(() => { void pollFetchResources(); }, 1500);
  // Operator 2026-05-25: "不要用倒計時，都用事件驅動". Removed 30s
  // setInterval. Resources accumulate predictably (production rates +
  // delta T), DOM mutation observers update on navigation. Background-
  // tab drift is acceptable; planner re-derives from server.resources
  // when needed.

  const REFRESH_PAGES = ["research", "supplies", "facilities", "shipyard", "fleetdispatch", "lfbuildings", "lfresearch"];
  let refreshIdx = 0;
  // Per-component chunk usability — verified 2026-05-25 via live probe:
  //   fleetdispatch chunk returns 131KB with full inline data (var shipsOnPlanet)
  //   research/supplies/facilities/shipyard/lfbuildings chunks return ~1KB STUBS
  //     (200 OK but no data-technology elements, no inline data dump)
  // Only fleetdispatch is SPA-routable as componentOnly chunk; the rest must
  // go through page=ingame full-page to render building/research levels.
  const CHUNK_SUPPORTED = new Set<string>(["fleetdispatch"]);
  async function refreshOnePage(forcePage?: string, forcePlanetId?: string): Promise<void> {
    const page = forcePage ?? REFRESH_PAGES[refreshIdx % REFRESH_PAGES.length]!;
    if (!forcePage) refreshIdx += 1;
    try {
      // v0.0.616 — operator 2026-06-01 "不會後臺請求資料嗎?". Accept
      // explicit planetId for per-planet background sweeps. When provided,
      // use it as cp=<pid> (safe_fetch RESTORES afterward so session-cp
      // returns to whatever it was). Default = current planet meta.
      const planetId = forcePlanetId
        ?? env.doc.querySelector<HTMLMetaElement>('meta[name="ogame-planet-id"]')?.content;
      const useChunk = CHUNK_SUPPORTED.has(page);
      const baseUrl = useChunk
        ? `/game/index.php?page=componentOnly&component=${page}&ajax=1`
        : `/game/index.php?page=ingame&component=${page}`;
      const init = {
        credentials: "same-origin" as const,
        ...(useChunk ? { headers: { "X-Requested-With": "XMLHttpRequest" } } : {}),
      };
      // Default (cp=current): no shift, skipRestore safe, bypassBusy ok
      // (no foreign shift). Explicit foreign planet (forcePlanetId):
      //   - skipRestore: false → safe_fetch restores session-cp afterward
      //   - bypassBusy: false → safe_fetch DEFERS until operator idle, so
      //     boot-sync (which fires per-planet cp= shifts) doesn't fight
      //     owner clicks. v0.0.631 — owner 2026-06-01 "新代碼又沒有走
      //     標準接口?" — boot-sync 用 bypassBusy=true 把 awaitCpIdle 閘
      //     拆了, 看到切星球. 改成 foreign 時遵循 idle gate.
      const isForeign = forcePlanetId !== undefined
        && forcePlanetId !== env.doc.querySelector<HTMLMetaElement>('meta[name="ogame-planet-id"]')?.content;
      const resp = planetId
        ? await fetchWithCp(baseUrl, init, planetId, { bypassBusy: !isForeign, skipRestore: !isForeign })
        : await env.win.fetch(baseUrl, init);
      if (!resp.ok) {
        console.warn(`[OgameX/refreshOnePage] ${page} HTTP ${resp.status} (${useChunk ? "chunk" : "full"}) — abort`);
        return;
      }
      const html = await resp.text();
      // Defense in depth: if a "chunk-supported" component suddenly returns
      // a stub (<5KB, no DOM data), warn and abort rather than wipe store.
      if (useChunk && html.length < 5000) {
        console.warn(`[OgameX/refreshOnePage] ${page} chunk too small (${html.length}B) — ogame changed shape? skipping refresh`);
        return;
      }
      console.info(`[OgameX/refreshOnePage] ${page}: ${useChunk ? "chunk" : "full"} ${html.length}B`);
      // Parse via DOMParser into a detached document; reuse the same
      // extractors that run on env.doc by SWAPPING `env.doc` temporarily?
      // No — extractors close over env.doc. Run them inline against the
      // parsed doc using the same logic.
      const parser = new (env.win as unknown as { DOMParser: typeof DOMParser }).DOMParser();
      const parsedDoc = parser.parseFromString(html, "text/html");

      // v0.0.731 — operator 2026-06-03 "建造 核融合反應器 L14 (~709m)" 实际
      // L17 + 21min 剩余. ogame fetchResources JSON 在 Scorpius 不返
      // buildqueue 字段, build_q 只在 boot bursts 跑 harvestQueues 那一刻
      // 凝固后再也不刷新, 显示与现实越拉越远. 在 chunk 解析时同步抽
      // 活跃 build queue (用 parsedDoc + 这次 fetch 的 planetId) — 跟
      // harvestQueues 同语义, 但 source 是周期 chunk 而不是 env.doc.
      if ((page === "supplies" || page === "facilities" || page === "research" || page === "shipyard") && planetId) {
        try {
          const actives = parsedDoc.querySelectorAll<HTMLElement>('li.technology[data-status="active"]');
          for (const li of Array.from(actives)) {
            const numeric = li.getAttribute("data-technology") ?? "";
            const name = TECH_ID_TO_NAME[numeric];
            if (!name) continue;
            const timeEl = li.querySelector<HTMLElement>("[data-end], time, .time");
            let endsAt: number | null = null;
            const endAttr = timeEl?.getAttribute("data-end") ?? timeEl?.getAttribute("data-target-time");
            if (endAttr) {
              const n = Number(endAttr);
              if (Number.isFinite(n)) endsAt = n * (n < 1e12 ? 1000 : 1);
            }
            if (endsAt === null) {
              const txt = timeEl?.textContent ?? li.textContent ?? "";
              const m = txt.match(/(\d+)h\s*(\d+)m\s*(\d+)s/i) ?? txt.match(/(\d+):(\d+):(\d+)/);
              if (m) {
                const sec = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
                endsAt = Date.now() + sec * 1000;
              }
            }
            const techId = parseInt(numeric, 10);
            const kind = idKind(techId);
            const target = store.state.planets[planetId];
            if (!target) continue;
            if (kind === "research") {
              const cur = store.state.research ?? { levels: {}, queue: null };
              const tgtLvl = (cur.levels[name] ?? 0) + 1;
              store.setPartial({ research: { ...cur, queue: { tech: name, technology_id: techId, level: tgtLvl, ends_at: endsAt ?? Date.now() + 60000 } as typeof cur.queue } });
            } else if (kind === "ship" || kind === "defense") {
              const cnt = (target.ships?.[name] ?? 0);
              store.setPlanetsPatch({ [planetId]: { shipyard_q: { ship: name, technology_id: techId, count: cnt + 1, ends_at: endsAt ?? Date.now() + 60000 } as typeof target.shipyard_q } });
            } else {
              const tgtLvl = (target.buildings?.[name] ?? 0) + 1;
              store.setPlanetsPatch({ [planetId]: { build_q: { building: name, technology_id: techId, level: tgtLvl, ends_at: endsAt ?? Date.now() + 60000 } as typeof target.build_q } });
              console.info(`[OgameX/refreshOnePage/queue] planet ${planetId} ${name} L${tgtLvl} ends_at=${endsAt} (${endsAt ? Math.round((endsAt - Date.now()) / 60000) : "?"}min from now)`);
            }
          }
        } catch (e) { console.warn(`[OgameX/refreshOnePage/queue] scan failed:`, e); }
      }

      // 1) Tech levels (research/supplies/facilities → regular; lfbuildings → lifeform;
      //    lfresearch → lifeform_research per planet, v0.0.603)
      const buildingsModule = await import("./probes/extractors/buildings.js");
      const techMap = buildingsModule.extractTechLevels(parsedDoc);
      // v0.0.615 — operator 2026-06-01 "不要兜底，網頁上有名字". Harvest
      // localized labels from same DOM pass and merge into global
      // store.tech_labels (canonical → zh per server locale).
      const labelMap = buildingsModule.extractTechLabels(parsedDoc);
      if (Object.keys(labelMap).length > 0) {
        const existing = (store.state as { tech_labels?: Record<string, string> }).tech_labels ?? {};
        const merged = { ...existing, ...labelMap };
        // Only emit a patch when something actually changed (avoids spurious
        // state.updated events during repeated extractor runs).
        let changed = false;
        for (const k of Object.keys(labelMap)) {
          if (existing[k] !== labelMap[k]) { changed = true; break; }
        }
        if (changed) {
          store.setPartial({ tech_labels: merged } as Partial<typeof store.state>);
        }
      }
      if (Object.keys(techMap).length > 0) {
        const buildings: Record<string, number> = {};
        const research: Record<string, number> = {};
        const lifeform_buildings: Record<string, number> = {};
        const lifeform_research: Record<string, number> = {};
        // Pre-build set of all lifeform research names across species for O(1) lookup.
        const lfResearchNames = new Set<string>();
        for (const sp of ["humans", "rocktal", "mechas", "kaelesh"] as const) {
          const cat = (LIFEFORM_TECH as Record<string, { research?: Record<string, unknown> }>)[sp];
          for (const k of Object.keys(cat?.research ?? {})) lfResearchNames.add(k);
        }
        // Detect species from lifeform tech ID prefix:
        //   111xx = humans  121xx = rocktal  131xx = mechas  141xx = kaelesh
        let detectedSpecies: string | null = null;
        for (const [id, lvl] of Object.entries(techMap)) {
          const techId = TECH_ID_BY_NAME[id];
          if (techId !== undefined && idKind(techId) === "lifeform_building") {
            lifeform_buildings[id] = lvl;
            if (lvl > 0 && detectedSpecies === null) {
              const prefix = Math.floor(techId / 1000);
              detectedSpecies = prefix === 11 ? "humans"
                : prefix === 12 ? "rocktal"
                : prefix === 13 ? "mechas"
                : prefix === 14 ? "kaelesh"
                : null;
            }
            continue;
          }
          // v0.0.605 — operator 2026-06-01 "每個星球對應的生命形式科技也是
          // 不同的, 不是所有科技都有, 也可以有不同種族的科技, 要根據 ogame
          // 當前資料顯示". Page-aware bucket: when extracting from lfresearch
          // page, ALL entries are lifeform research (regardless of catalog
          // completeness or species — same planet may carry items from
          // multiple species due to historical switches).
          if (page === "lfresearch") { lifeform_research[id] = lvl; continue; }
          // For other pages (research/lfbuildings/etc), fall back to catalog
          // name match for lifeform research (rare cross-listed cases).
          if (lfResearchNames.has(id)) { lifeform_research[id] = lvl; continue; }
          const entry = (TECH_TREE as Record<string, { kind: string }>)[id];
          if (!entry) continue;
          if (entry.kind === "building") buildings[id] = lvl;
          else if (entry.kind === "research") research[id] = lvl;
        }
        const cur = store.state;
        const patch: Partial<typeof cur> = {};
        const targetPlanet = planetId ? cur.planets[planetId] : undefined;
        if (targetPlanet && planetId && (Object.keys(buildings).length > 0 || Object.keys(lifeform_buildings).length > 0 || Object.keys(lifeform_research).length > 0)) {
          const existingLf = (targetPlanet as { lifeform?: { species?: string } | null }).lifeform ?? null;
          const lifeformPatch = detectedSpecies !== null && (existingLf === null || existingLf.species !== detectedSpecies)
            ? { lifeform: { ...(existingLf ?? {}), species: detectedSpecies } }
            : {};
          // v0.0.620 — operator 2026-06-01 "已經切換了種族的星球老科技是
          // 無效的". When fetching lfresearch/lfbuildings pages, the
          // extracted set IS the complete current-species state. Old
          // species' entries from before a switch must be EVICTED, not
          // merged. So replace the whole field for this planet instead
          // of spread+merge. For OTHER pages (where lfresearch entries
          // could appear as accidental cross-listings), keep merge.
          const lifeformBuildingsField = page === "lfbuildings"
            ? { lifeform_buildings: lifeform_buildings }
            : (Object.keys(lifeform_buildings).length > 0 ? {
                lifeform_buildings: { ...((targetPlanet as { lifeform_buildings?: Record<string, number> }).lifeform_buildings ?? {}), ...lifeform_buildings }
              } : {});
          const lifeformResearchField = page === "lfresearch"
            ? { lifeform_research: lifeform_research }
            : (Object.keys(lifeform_research).length > 0 ? {
                lifeform_research: { ...((targetPlanet as { lifeform_research?: Record<string, number> }).lifeform_research ?? {}), ...lifeform_research }
              } : {});
          patch.planets = {
            ...cur.planets,
            [planetId]: {
              ...targetPlanet,
              buildings: { ...(targetPlanet.buildings ?? {}), ...buildings },
              ...lifeformBuildingsField,
              ...lifeformResearchField,
              ...lifeformPatch,
            } as typeof targetPlanet,
          };
          if (detectedSpecies !== null) {
            console.info(`[OgameX/species] planet ${planetId}: detected species=${detectedSpecies}`);
          }
        }
        if (Object.keys(research).length > 0) {
          patch.research = { ...cur.research, levels: { ...(cur.research?.levels ?? {}), ...research } };
        }
        if (Object.keys(patch).length > 0) store.setPartial(patch);
      }

      // 1.5) DISABLED — was parsing li.technology[data-technology=20X] from
      // shipyard/fleetdispatch HTML using `.amount, .level` selectors. But
      // those selectors hit WRONG elements (build-queue input, or level=1
      // tooltip), overwriting the CORRECT ship counts written by pollEmpire.
      //
      // Symptom: empire dumped lc=1500 for [2:279:8], but sidecar /state
      // showed lc=1. The refresh path overwrote 1500 with garbage 1.
      //
      // Empire endpoint is the single source of truth for ship inventory.
      // If shipyard/fleetdispatch DOM extraction is ever needed again, use
      // [data-amount="N"] attribute, NOT .amount/.level innerText.

      // 2) Active queue from this page (research_q / build_q / shipyard_q).
      //    Looking for li.technology[data-status="active"].
      const actives = parsedDoc.querySelectorAll<HTMLElement>('li.technology[data-status="active"]');
      let foundActive = false;
      for (const li of actives) {
        const numeric = li.getAttribute("data-technology") ?? "";
        const name = TECH_ID_TO_NAME[numeric];
        if (!name) continue;
        foundActive = true;
        const timeEl = li.querySelector<HTMLElement>("[data-end], time, .time");
        let ends_at = Date.now() + 60_000;
        const endAttr = timeEl?.getAttribute("data-end") ?? timeEl?.getAttribute("data-target-time");
        if (endAttr) {
          const n = Number(endAttr);
          if (Number.isFinite(n)) ends_at = n * (n < 1e12 ? 1000 : 1);
        } else {
          const txt = timeEl?.textContent ?? "";
          const m = txt.match(/(\d+)h\s*(\d+)m\s*(\d+)s/i) ?? txt.match(/(\d+):(\d+):(\d+)/);
          if (m) ends_at = Date.now() + (Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000;
        }
        const technology_id = parseInt(numeric, 10);
        const kind2 = idKind(technology_id);
        if (kind2 === "research") {
          const cur2 = store.state.research ?? { levels: {}, queue: null };
          const target_level = (cur2.levels[name] ?? 0) + 1;
          store.setPartial({ research: { ...cur2, queue: { tech: name, technology_id, level: target_level, ends_at } as typeof cur2.queue } });
          console.log(`[OgameX/bg] research queue refreshed: ${name} L${target_level}`);
        } else if (kind2 === "ship" || kind2 === "defense") {
          const target = planetId ? store.state.planets[planetId] : undefined;
          if (target && planetId) {
            const cnt = (target.ships?.[name] ?? 0);
            store.setPlanetsPatch({
              [planetId]: { shipyard_q: { ship: name, technology_id, count: cnt + 1, ends_at } as typeof target.shipyard_q },
            });
            console.log(`[OgameX/bg] shipyard queue refreshed (planet ${planetId}): ${name}`);
          }
        } else if (kind2 === "lifeform_building") {
          const target = planetId ? store.state.planets[planetId] : undefined;
          if (target && planetId) {
            const lfBldg = (target as { lifeform_buildings?: Record<string, number> }).lifeform_buildings ?? {};
            const target_level = (lfBldg[name] ?? 0) + 1;
            store.setPlanetsPatch({
              [planetId]: { lf_build_q: { building: name, technology_id, level: target_level, ends_at } } as Partial<typeof target & { lf_build_q: unknown }>,
            });
            console.log(`[OgameX/bg] lf queue refreshed (planet ${planetId}): ${name} L${target_level}`);
          }
        } else if (kind2 === "lifeform_research") {
          // v0.0.633 — owner 2026-06-01 "從0級往上升級的, 當然是有前置任務
          // 在跑, 爲什麼不等待前置任務完成, 在不斷重試幹嘛?". Without
          // surfacing the lf research queue, priority_merger's slotEmpty
          // detection defaulted to true → kept re-dispatching directives
          // ogame had to reject (queue busy). Track lf_research_q per
          // planet so sidecar can wait for the prereq research to finish.
          const target = planetId ? store.state.planets[planetId] : undefined;
          if (target && planetId) {
            const lfr = (target as { lifeform_research?: Record<string, number> }).lifeform_research ?? {};
            const target_level = (lfr[name] ?? 0) + 1;
            store.setPlanetsPatch({
              [planetId]: { lf_research_q: { tech: name, technology_id, level: target_level, ends_at } } as Partial<typeof target & { lf_research_q: unknown }>,
            });
            console.log(`[OgameX/bg] lf research queue refreshed (planet ${planetId}): ${name} L${target_level}`);
          }
        } else {
          const target = planetId ? store.state.planets[planetId] : undefined;
          if (target && planetId) {
            const target_level = (target.buildings?.[name] ?? 0) + 1;
            store.setPlanetsPatch({
              [planetId]: { build_q: { building: name, technology_id, level: target_level, ends_at } as typeof target.build_q },
            });
            console.log(`[OgameX/bg] build queue refreshed (planet ${planetId}): ${name} L${target_level}`);
          }
        }
      }
      // 3) If this page is research/supplies/facilities/lfbuildings and NO
      //    active li, clear stale queue. Stale q blocks dispatch
      //    indefinitely after operator cancels in ogame UI.
      if (!foundActive && (page === "research" || page === "supplies" || page === "facilities" || page === "lfbuildings" || page === "lfresearch")) {
        if (page === "research" && store.state.research?.queue) {
          const cur2 = store.state.research;
          store.setPartial({ research: { ...cur2, queue: null } });
          console.log(`[OgameX/bg] research queue CLEARED (page=${page}, no active)`);
        }
        if ((page === "supplies" || page === "facilities") && planetId) {
          const target = store.state.planets[planetId];
          if (target && target.build_q) {
            store.setPlanetsPatch({ [planetId]: { build_q: null } });
            console.log(`[OgameX/bg] build queue CLEARED (planet ${planetId}, page=${page}, no active)`);
          }
        }
        if (page === "lfbuildings" && planetId) {
          const target = store.state.planets[planetId] as (typeof store.state.planets[string] & { lf_build_q?: unknown }) | undefined;
          if (target && target.lf_build_q) {
            store.setPlanetsPatch({ [planetId]: { lf_build_q: null } as Partial<typeof target> });
            console.log(`[OgameX/bg] lf queue CLEARED (planet ${planetId}, page=${page}, no active)`);
          }
        }
        if (page === "lfresearch" && planetId) {
          // v0.0.633 — clear stale lf research queue when ogame says idle.
          const target = store.state.planets[planetId] as (typeof store.state.planets[string] & { lf_research_q?: unknown }) | undefined;
          if (target && target.lf_research_q) {
            store.setPlanetsPatch({ [planetId]: { lf_research_q: null } as Partial<typeof target> });
            console.log(`[OgameX/bg] lf research queue CLEARED (planet ${planetId}, page=${page}, no active)`);
          }
        }
      }
    } catch (e) {
      // Network or parse error — quiet.
      void e;
    }
  }
  // Track user activity — skip background refresh while the operator is
  // actively interacting with ogame (avoid stealing CPU / interfering
  // with their clicks). Only real (isTrusted) mouse/keyboard counts.
  let lastUserActivity = 0;
  const _markUserActive = (e: Event): void => { if (e.isTrusted) lastUserActivity = Date.now(); };
  env.doc.addEventListener("mousedown", _markUserActive, true);
  env.doc.addEventListener("keydown", _markUserActive, true);
  // First refresh after 8s, then every 10s. Respects the global userBusy
  // guard (60s window after any user click/key) so background refresh
  // doesn't compete with operator's own ogame POSTs.
  scheduleBurst(refreshOnePage, 8000);
  // v0.0.731 — operator 2026-06-03 "建造 核融合反應器 L14 (~709m)" 实际 L17
  // 还剩 21min. build_q 在 fetchResources JSON 不带 buildqueue 字段时永远
  // 不刷新 (Scorpius 实测), 只在 boot bursts 那一刻有数据然后永远过期.
  // periodic 10s force-supplies refresh + chunk-side build queue 抽取 =
  // build_q 跟 ogame 真值 ≤10s 偏差.
  setInterval(() => { void refreshOnePage("supplies"); }, 10_000);
  setInterval(() => { void refreshOnePage("facilities"); }, 15_000);

  // v0.0.635 — owner 2026-06-01 "要持久化 ogame 裏面的所有資料". Sidecar
  // now owns WorldState persistence (better-sqlite3 ogamex-world.db). The
  // userscript no longer needs a forced boot-sync sweep: sidecar hydrates
  // its mirror from disk on restart, and pollEmpire + per-page passive
  // harvest cover ongoing freshness. v0.0.634 TTL gate (lastFullLfSyncAt
  // 24h + 30min idle) removed — sidecar IS the truth.
  void lastUserActivity;

  // Empire view poller — direct ogame standalone empire endpoint.
  // Returns ALL planets ships + buildings in a single fetch. No per-planet
  // navigation needed. Most importantly, doesn't set session cp= cookie
  // (separate "standalone" viewport), so ApiExec session stays intact.
  // Used to populate state.planets[].ships across the entire empire.
  async function pollEmpire(opts: { force?: boolean } = {}): Promise<void> {
    // ApiExec preflight needs fresh data even when user is busy (otherwise
    // launching fleets relies on stale data the whole time user browses).
    // Periodic state-push poller passes no force=true so it still defers
    // to user activity for politeness; ApiExec helper passes force=true.
    if (!opts.force && userBusy()) return;
    // Operator 2026-05-25: "全有月球，你的資料有問題 ... 從api拿資料".
    // empire endpoint takes planetType param. v12: 0 = planets, 1 = moons.
    // We fetch BOTH and merge — every poll cycle. Without this, moons
    // never reach state.planets, case_decider's same-coord-moon lookup
    // always fails, every FS is Case C (debris) by default.
    await pollEmpireForType("planet", 0);
    await pollEmpireForType("moon", 1);
  }
  async function pollEmpireForType(typeLabel: "planet" | "moon", planetTypeParam: number): Promise<void> {
    try {
      // v0.0.556 — operator 2026-05-31 "sidecar empire 資料陳舊". ogame's
      // standalone&component=empire response is server-cached for a few
      // seconds → eventbox_hook fires pollEmpire after fleet arrival but
      // gets the SAME stale numbers (e.g. operator's planet 33666823 真實
      // LC=3092 vs sidecar LC=600 even after force refresh). Append a
      // cache-bust param so each force-refresh actually hits a fresh
      // backend computation.
      const url = `/game/index.php?page=standalone&component=empire&planetType=${planetTypeParam}&_=${Date.now()}`;
      const r = await env.win.fetch(url, { credentials: "same-origin", headers: { "X-Requested-With": "XMLHttpRequest" } });
      if (!r.ok) return;
      const html = await r.text();
      // ogame v12 empire format candidates — try until one parses.
      let data: Array<Record<string, unknown>> | null = null;
      let usedPattern = "";
      const tryPatterns: Array<[string, RegExp]> = [
        ["A:var planets",     /var\s+planets\s*=\s*(\[[\s\S]*?\]);/],
        ["B:var planetsData", /var\s+planetsData\s*=\s*(\[[\s\S]*?\]);/],
        ["C:Empire planets",  /Empire\.[\w]*planet[\w]*\s*=\s*(\[[\s\S]*?\]);/],
        ["D:data-planets",    /data-planets\s*=\s*"([^"]+)"/],
        ["E:planets json",    /"planets"\s*:\s*(\[[\s\S]*?\}\s*\])/],
      ];
      for (const [name, re] of tryPatterns) {
        const m = html.match(re);
        if (!m) continue;
        try {
          let raw = m[1]!;
          if (name.startsWith("D")) raw = raw.replace(/&quot;/g, '"').replace(/&amp;/g, "&");
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed) && parsed.length > 0) {
            data = parsed;
            usedPattern = name;
            break;
          }
        } catch { /* try next */ }
      }
      if (!data) {
        // Dump 'planet' context for operator to teach the real format.
        console.warn(`[OgameX/empire] all 5 parse patterns failed (${html.length}B). Dumping 'planet' contexts:`);
        let pos = 0;
        for (let i = 0; i < 3; i++) {
          const idx = html.indexOf("planet", pos);
          if (idx < 0) break;
          console.warn(`  @${idx}:`, html.slice(Math.max(0, idx - 40), idx + 250));
          pos = idx + 1;
        }
        return;
      }
      void usedPattern; // (silenced — happens every 5s, expected steady-state)
      // v0.0.490 debug: dump first body's full key list ONCE per type per
      // session — both to console AND to sidecar via fetch, so journalctl
      // can show ogame v12 empire schema without operator manual paste.
      // v0.0.553 — gate behind OGAMEX_FORENSIC=1. Default off; this dump
      // serialized 4-500 keys per body and ran on every page-nav re-init.
      try {
        const dumpKey = `__ogamexEmpireDump_${typeLabel}`;
        const dumped = (env.win as Window & Record<string, unknown>)[dumpKey];
        const forensicOn = env.win.localStorage?.getItem("OGAMEX_FORENSIC") === "1";
        if (forensicOn && !dumped && data.length > 0) {
          const sample = data[0]!;
          const keys = Object.keys(sample);
          const nonNumeric = keys.filter(k => !/^\d+$/.test(k));
          const lines: string[] = [];
          lines.push(`${typeLabel} sample (id=${sample["id"]} name=${sample["name"]}): ${keys.length} keys total, ${nonNumeric.length} non-numeric`);
          lines.push(`  non-numeric keys: ${nonNumeric.join(", ")}`);
          for (const k of nonNumeric) {
            const v = sample[k];
            const vstr = typeof v === "object" ? JSON.stringify(v).slice(0, 200) : String(v).slice(0, 100);
            lines.push(`  ${typeLabel}.${k} = ${vstr}`);
          }
          // Also dump tid keys with "metal-ish" names by value heuristics:
          // ogame uses tid<200 for buildings, tid 200-300 for ships. Check if
          // any tid maps to a metal-ish key by trying value ranges (resource
          // amounts usually 4-7 digits, level usually 1-99).
          const tidKeys = keys.filter(k => /^\d+$/.test(k));
          const highValTids = tidKeys.filter(k => {
            const v = sample[k];
            const n = typeof v === "number" ? v : parseInt(String(v).replace(/[.,\s]/g, ""), 10);
            return Number.isFinite(n) && n > 10000;
          });
          lines.push(`  high-value tid keys (>10k, possibly resources): ${highValTids.map(k => `${k}=${sample[k]}`).join(", ")}`);
          const dump = lines.join("\n");
          console.log(`[OgameX/empire DEBUG]\n${dump}`);
          // Send to sidecar so journalctl can show it without operator
          // pasting console — purely diagnostic, fire-and-forget.
          try {
            const bridgeBase = (env.win.localStorage.getItem("OGAMEX_BRIDGE_URL") ?? "https://ogame.anyfq.com");
            void env.win.fetch(`${bridgeBase.replace(/\/$/, "")}/ogamex/v1/debug/log`, {
              method: "POST", credentials: "omit", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ tag: "empire-dump", text: dump }),
            }).catch(() => {});
          } catch { /* */ }
          (env.win as Window & Record<string, unknown>)[dumpKey] = true;
        }
      } catch (e) { console.warn("[OgameX/empire DEBUG] dump failed", e); }
      const cur = store.state;
      const patchPlanets: Record<string, typeof cur.planets[string]> = { ...cur.planets };
      // Operator 2026-05-25: "遠征船不夠以後卡住了，有新船到達星球也沒有起飛".
      // Detect ship-count INCREASE between empire polls per planet — ships
      // returned. Prune __ogamexInflightLaunches[pid] so the next preflight
      // stops subtracting "in-flight" that's already landed. Empire-delta
      // is the authoritative arrival signal; 90min TTL alone was too lax.
      const inflightHandle = env.win as Window & {
        __ogamexInflightLaunches?: Map<string, Array<{ ships: Record<string, number>; ts: number }>>;
        __ogamexEmpireShipSnapshot?: Map<string, Record<string, number>>;
      };
      if (!inflightHandle.__ogamexEmpireShipSnapshot) inflightHandle.__ogamexEmpireShipSnapshot = new Map();
      const lastShipSnap = inflightHandle.__ogamexEmpireShipSnapshot;

      let updated = 0;
      for (const planet of data) {
        const pid = String(planet["id"] ?? "");
        if (!pid) continue;
        // If not in state yet (typical for moons — operator 2026-05-25
        // "全有月球, 你的資料有問題"), synthesize a minimal entry so the
        // case_decider's same-coord-moon lookup finds it. Coords + name
        // pulled from the empire row itself.
        if (!patchPlanets[pid]) {
          const g = Number(planet["galaxy"] ?? 0);
          const s = Number(planet["system"] ?? 0);
          const pos = Number(planet["position"] ?? 0);
          const nm = String(planet["name"] ?? (typeLabel === "moon" ? t("auto.118") : "殖民"));
          if (g > 0 && s > 0 && pos > 0) {
            patchPlanets[pid] = {
              id: pid, name: nm, coords: [g, s, pos] as const, type: typeLabel,
              resources: { m: 0, c: 0, d: 0, e: 0 },
              storage: { m_max: 0, c_max: 0, d_max: 0 },
              production: { m_h: 0, c_h: 0, d_h: 0 },
              buildings: {}, build_q: null, shipyard_q: null, defense_q: null,
              ships: {}, defense: {}, lifeform: null,
            } as typeof patchPlanets[string];
            updated += 1;
            console.log(`[OgameX/empire] new ${typeLabel} ${pid} ${nm}@${g}:${s}:${pos}`);
          } else {
            continue;
          }
        }
        const ships: Record<string, number> = {};
        // STRICT key match + thousand-separator-aware value parse.
        // Parse 3 tid ranges from empire response:
        //   < 200   → regular buildings (metalMine=1, crystalMine=2, ...)
        //   200-300 → ships (smallCargo=202, ...)
        //   11000-15000 → lifeform buildings (residentialSector=11101, sanctuary=14101, ...)
        // Operator: "已經 42 級了, 爲啥你的資料是 37 級" — empire was only
        // refreshing ships, so building/lifeform_building levels stayed stale
        // forever. Planner kept thinking sanctuary L37, kept queuing builds.
        const buildings: Record<string, number> = {};
        const lifeform_buildings: Record<string, number> = {};
        for (const [key, val] of Object.entries(planet)) {
          if (!/^\d+$/.test(key)) continue;
          const tid = parseInt(key, 10);
          const name = TECH_ID_TO_NAME[String(tid)];
          if (!name) continue;
          let n: number;
          if (typeof val === "number") {
            n = val;
          } else {
            const stripped = String(val).replace(/[.,\s]/g, "");
            n = parseInt(stripped, 10);
          }
          if (!Number.isFinite(n) || n < 0) continue;
          if (tid >= 200 && tid < 300) ships[name] = n;
          else if (tid >= 11000 && tid < 15000) lifeform_buildings[name] = n;
          else if (tid > 0 && tid < 200) buildings[name] = n;
        }
        // Empire-delta inflight pruning: if ship count INCREASED since
        // last poll, those ships landed. Subtract the increase from the
        // oldest inflight entries for this planet, removing entries that
        // become fully consumed.
        if (Object.keys(ships).length > 0 && inflightHandle.__ogamexInflightLaunches) {
          const prev = lastShipSnap.get(pid) ?? {};
          for (const [shipName, currentN] of Object.entries(ships)) {
            const prevN = prev[shipName] ?? currentN;
            const delta = currentN - prevN;
            if (delta <= 0) continue;  // not a return; could be hangar build
            // Subtract delta from this planet's inflight entries for this ship.
            let toReclaim = delta;
            const launches = inflightHandle.__ogamexInflightLaunches.get(pid) ?? [];
            for (const entry of launches) {
              if (toReclaim <= 0) break;
              const inflightN = entry.ships[shipName] ?? 0;
              if (inflightN <= 0) continue;
              const consume = Math.min(inflightN, toReclaim);
              entry.ships[shipName] = inflightN - consume;
              toReclaim -= consume;
            }
            // Drop entries that have no ships left at all (all returned).
            const compact = launches.filter((e) => Object.values(e.ships).some((v) => (v ?? 0) > 0));
            if (compact.length !== launches.length || launches.some((e, i) => e !== compact[i])) {
              inflightHandle.__ogamexInflightLaunches.set(pid, compact);
              if (compact.length < launches.length) {
                console.log(`[OgameX/empire] pruned ${launches.length - compact.length} inflight entry on ${pid} (ship returned: ${shipName} +${delta})`);
              }
            }
          }
          lastShipSnap.set(pid, { ...ships });
        }
        // v0.0.489 — operator 2026-05-30 "如果我不在線就不幹了?". empire 返回
        // 的 planet 對象除了 numeric tid 之外, 還帶 resources 字段 (用 string
        // key, 跟 fetchResources 同構)。 之前 parser 只看 numeric tid 漏抓
        // resources → 月球資源永遠走不進 sidecar (除非 operator 瀏覽器打開
        // 該月球頁觸發 fetchResources)。 現在 broad-net 抓常見 key 候選,
        // 命中任意一種就 patch resources / production / storage。
        const candResources = (() => {
          const r: { m?: number; c?: number; d?: number; e?: number } = {};
          const num = (v: unknown): number | undefined => {
            if (typeof v === "number" && Number.isFinite(v)) return v;
            if (typeof v === "string") {
              const stripped = v.replace(/[.,\s]/g, "");
              const n = parseInt(stripped, 10);
              if (Number.isFinite(n)) return n;
            }
            return undefined;
          };
          // v0.0.490 broader candidates: nested .amount / direct number / string forms.
          const nested = (root: unknown, ...keys: string[]): number | undefined => {
            let cur: unknown = root;
            for (const k of keys) {
              if (cur && typeof cur === "object") cur = (cur as Record<string, unknown>)[k];
              else return undefined;
            }
            return num(cur);
          };
          const res = planet["resources"];
          // ogame v12 candidates (各種 schema 都試):
          const m =
            num(planet["metal"]) ?? num(planet["m"]) ?? num(planet["metalAmount"]) ?? num(planet["metal_amount"])
            ?? nested(res, "metal") ?? nested(res, "metal", "amount") ?? nested(res, "metal", "value")
            ?? nested(planet, "metal", "amount") ?? nested(planet, "metal", "value");
          const c =
            num(planet["crystal"]) ?? num(planet["c"]) ?? num(planet["crystalAmount"]) ?? num(planet["crystal_amount"])
            ?? nested(res, "crystal") ?? nested(res, "crystal", "amount") ?? nested(res, "crystal", "value")
            ?? nested(planet, "crystal", "amount") ?? nested(planet, "crystal", "value");
          const d =
            num(planet["deuterium"]) ?? num(planet["d"]) ?? num(planet["deuteriumAmount"]) ?? num(planet["deuterium_amount"])
            ?? nested(res, "deuterium") ?? nested(res, "deuterium", "amount") ?? nested(res, "deuterium", "value")
            ?? nested(planet, "deuterium", "amount") ?? nested(planet, "deuterium", "value");
          const e =
            num(planet["energy"]) ?? num(planet["e"]) ?? num(planet["energyAmount"]) ?? num(planet["energy_amount"])
            ?? nested(res, "energy") ?? nested(res, "energy", "amount")
            ?? nested(planet, "energy", "amount");
          if (m !== undefined) r.m = m;
          if (c !== undefined) r.c = c;
          if (d !== undefined) r.d = d;
          if (e !== undefined) r.e = e;
          return r;
        })();
        const candBuildQ = (() => {
          // v0.0.495 — ogame standalone empire encodes build_q inside the
          // per-tid <tid>_html fields. Pattern when a building is upgrading:
          //   <span class='disabled'>N</span>
          //   <img title='X 將升級至 N+1 級!'>
          //   <a class="active" title="取消" onClick="doUpgrade(TID,BID,2,COST,false)">N+1</a>
          // When idle: only <span> + <a href onclick='doUpgrade(...)' title='升級'>.
          // Detect: html contains `class="active"` AND title='取消'.
          // Extract level from `<a class="active"...>N+1</a>` link text.
          // ends_at: empire doesn't expose; fall back to live build_q if
          // already set (preserve precise time set by fetchResources), else
          // placeholder Date.now()+12h (overwritten when fetchResources fires).
          const liveBody = patchPlanets[pid] as { build_q?: { ends_at?: number; building?: string; level?: number } | null } | undefined;
          const liveBq = liveBody?.build_q;
          for (const key of Object.keys(planet)) {
            const m = /^(\d+)_html$/.exec(key);
            if (!m) continue;
            const tid = parseInt(m[1]!, 10);
            // v0.0.497 — body build_q (per-planet/moon supplies/facilities)
            // only takes tid 1-50 (buildings). tid 100-199 = research (全
            // empire 單槽, goes to state.research.queue, NOT body build_q).
            // tid 200-300 = ships (goes to shipyard_q). tid 400+ = defense.
            // tid 11000+ = lifeform (separate lf_build_q).
            // Operator 2026-05-30: panel 顯示 "building astrophysics" 錯了,
            // astrophysics(tid124)是 research, 不該寫到 moon body build_q.
            if (tid >= 100) continue;
            const html = String(planet[key] ?? "");
            // v0.0.496 fix — match `class="active tooltipRight"` (multi-class).
            // Original `class="active"` substring miss caused build_q to
            // never be detected (operator 2026-05-30 實證: 41_html 有 active
            // 但 v0.0.495 沒抓). Use word-boundary regex inside the class attr.
            if (!/class=["'][^"']*\bactive\b/.test(html)) continue;
            // Distinguish "active = upgrading" from any other active class
            // by looking for the Chinese cancellation title; ogame uses
            // 取消 / cancel / Annuller / etc. depending on locale.
            if (!/title=["']取消|title=["']cancel|title=["']abbrechen|title=["']annul/i.test(html)) continue;
            const name = TECH_ID_TO_NAME[String(tid)];
            if (!name) continue;
            // Pull level from inside the <a class="active">...N+1...</a> tag.
            const lvlMatch = /<a[^>]*class=["'][^"']*active[^"']*["'][^>]*>(\d+)<\/a>/.exec(html);
            const level = lvlMatch ? parseInt(lvlMatch[1]!, 10) : 1;
            // Preserve precise ends_at if live build_q matches the same
            // building+level (operator visited the body, fetchResources wrote
            // it). Otherwise estimate +12h placeholder.
            const ends_at = (liveBq && liveBq.building === name && liveBq.level === level && (liveBq.ends_at ?? 0) > Date.now())
              ? liveBq.ends_at!
              : Date.now() + 12 * 3600 * 1000;
            return { building: name, technology_id: tid, level, ends_at };
          }
          return undefined;
        })();
        const hasResources = Object.keys(candResources).length > 0;
        // v0.0.499 — pollEmpire is the authoritative source for body build_q.
        // Always set it (valid object OR null). Without this, after parser
        // tightens (v0.0.497 skipped research tids), the OLD bad build_q
        // value stayed in store because we didn't explicitly clear it.
        // Operator 2026-05-30 實證: moon 3:260:8 stuck on astrophysics build_q
        // even after parser stopped writing it.
        const buildQEffective: typeof candBuildQ | null = candBuildQ ?? null;
        const hasAny = true; // always patch — even if just to clear stale build_q
        if (hasAny) {
          const cur = patchPlanets[pid];
          const curResources = (cur as { resources?: { m?: number; c?: number; d?: number; e?: number } }).resources ?? { m: 0, c: 0, d: 0, e: 0 };
          // v0.0.610 — operator 2026-06-01 "選種族的時候, 只有對應種族的
          // 星球亮起 — 這個問題修了 5 次了". Root cause: pollEmpire's
          // empire/standalone page doesn't include lifeform building
          // data-technology entries — refreshOnePage (lfbuildings page)
          // is what actually populates lifeform_buildings. pollEmpire's
          // detection block saw an empty local map → detectedSpecies null
          // → lifeform.species never written. Fix: read existing store
          // lifeform_buildings as fallback when the local extract is empty.
          // v0.0.611 — `cur` here is patchPlanets[pid], not live store —
          // it's a fresh patch being built this cycle and doesn't carry
          // historical lifeform_buildings. Pull from store.state.planets
          // directly so the fallback actually has data.
          const storePlanet = store.state.planets[pid] as { lifeform_buildings?: Record<string, number> } | undefined;
          const lfbForDetection: Record<string, number> = Object.keys(lifeform_buildings).length > 0
            ? lifeform_buildings
            : (storePlanet?.lifeform_buildings ?? {});
          const speciesMaxLevel: Record<string, number> = {};
          for (const [name, lvl] of Object.entries(lfbForDetection)) {
            if (lvl <= 0) continue;
            const tid = TECH_ID_BY_NAME[name];
            if (typeof tid !== "number") continue;
            const prefix = Math.floor(tid / 1000);
            const sp = prefix === 11 ? "humans" : prefix === 12 ? "rocktal" : prefix === 13 ? "mechas" : prefix === 14 ? "kaelesh" : null;
            if (!sp) continue;
            speciesMaxLevel[sp] = Math.max(speciesMaxLevel[sp] ?? 0, lvl);
          }
          let detectedSpecies: string | null = null;
          let bestMax = 0;
          for (const [sp, mx] of Object.entries(speciesMaxLevel)) {
            if (mx > bestMax) { bestMax = mx; detectedSpecies = sp; }
          }
          const existingLf = (cur as { lifeform?: { species?: string } | null }).lifeform ?? null;
          const lifeformPatch = detectedSpecies !== null && (existingLf === null || existingLf.species !== detectedSpecies)
            ? { lifeform: { ...(existingLf ?? {}), species: detectedSpecies } }
            : {};
          const merged = {
            ...cur,
            ships: { ...((cur as { ships?: Record<string, number> }).ships ?? {}), ...ships },
            ...(Object.keys(buildings).length > 0 ? {
              buildings: { ...((cur as { buildings?: Record<string, number> }).buildings ?? {}), ...buildings },
            } : {}),
            ...(Object.keys(lifeform_buildings).length > 0 ? {
              lifeform_buildings: { ...((cur as { lifeform_buildings?: Record<string, number> }).lifeform_buildings ?? {}), ...lifeform_buildings },
            } : {}),
            ...lifeformPatch,
            ...(hasResources ? { resources: { ...curResources, ...candResources } } : {}),
            build_q: buildQEffective, // ALWAYS present (no `... ? : {}` gate)
          };
          patchPlanets[pid] = merged as typeof patchPlanets[string];
          updated += 1;
        }
      }
      if (updated > 0) {
        // RACE FIX 2026-05-27: pollEmpire's fetch is async (~1-3s). Use the
        // race-safe setPlanetsPatch API — per-planet partials are spread over
        // LIVE state at write time, so any concurrent commitCooldown writes
        // (jumpgate fields) survive.
        const patchByPid: Record<string, Partial<typeof store.state.planets[string]>> = {};
        for (const [pid, patched] of Object.entries(patchPlanets)) {
          const live = store.state.planets[pid];
          const p = patched as Partial<typeof store.state.planets[string]> & { ships?: Record<string, number>; buildings?: Record<string, number>; lifeform_buildings?: Record<string, number> };
          if (!live) {
            // Brand-new planet synthesized in this poll — pass full record.
            patchByPid[pid] = patched as Partial<typeof store.state.planets[string]>;
          } else {
            // Only the fields pollEmpire actually patched.
            // v0.0.491 — operator 2026-05-30: previously the filter dropped
            // resources + build_q because pollEmpire only used to set
            // ships/buildings/lifeform. v0.0.489 + .490 extended pollEmpire
            // to extract resources + build_q too, but this filter still
            // stripped them out. Result: moon resources from empire dump
            // looked correct in parsing, but never reached store.
            const pp = p as Partial<typeof store.state.planets[string]> & {
              ships?: Record<string, number>;
              buildings?: Record<string, number>;
              lifeform_buildings?: Record<string, number>;
              resources?: { m?: number; c?: number; d?: number; e?: number };
              build_q?: unknown;
            };
            patchByPid[pid] = {
              ...(pp.ships !== undefined ? { ships: pp.ships } : {}),
              ...(pp.buildings !== undefined ? { buildings: pp.buildings } : {}),
              ...(pp.lifeform_buildings !== undefined ? { lifeform_buildings: pp.lifeform_buildings } : {}),
              ...(pp.resources !== undefined ? { resources: pp.resources } : {}),
              ...(pp.build_q !== undefined ? { build_q: pp.build_q } : {}),
            } as Partial<typeof store.state.planets[string]>;
          }
        }
        store.setPlanetsPatch(patchByPid);
        // v0.0.492 — diagnostic: push version + moon 1:486:7 resources to
        // sidecar journal after each pollEmpire so we can verify v0.0.491+
        // filter fix is REALLY running (operator: v0.0.491 deploy 沒動).
        // v0.0.508 — pollEmpire-tick POST 砍掉 (operator 2026-05-31 chrome 崩),
        // 每秒級觸發, 累積太多 fetch + journal 噪音。 保留 empire-dump 一次性
        // 診斷和 fleet-strip 罕見事件。 整段保護在 if (false) 裏方便以後開。
        if (false as boolean) {
        try {
          const debugMoonId = "33650177"; // moon 1:486:7
          const dbgPatch = patchByPid[debugMoonId];
          const dbgLive = store.state.planets[debugMoonId];
          // v0.0.493 — also dump the lunarBase (tid 41) raw HTML for the
          // monitored moon so we can see how empire encodes "in progress"
          // (operator: resources went to 0 but build_q still None — encoding
          // is in <tid>_html with <img> after <span>).
          let lbHtml = "";
          if (typeLabel === "moon" && data) {
            const moonRow = data.find((p) => String(p["id"] ?? "") === debugMoonId);
            if (moonRow) {
              lbHtml = String(moonRow["41_html"] ?? "").slice(0, 600);
            }
          }
          const bridgeBase = (env.win.localStorage.getItem("OGAMEX_BRIDGE_URL") ?? "https://ogame.anyfq.com");
          void env.win.fetch(`${bridgeBase.replace(/\/$/, "")}/ogamex/v1/debug/log`, {
            method: "POST", credentials: "omit", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              tag: "pollEmpire-tick",
              text: `v=${((env.win as Window & { __ogamexVersion?: string }).__ogamexVersion ?? "?")} updated=${updated} type=${typeLabel} moon1:486:7.patchKeys=[${dbgPatch ? Object.keys(dbgPatch).join(",") : "MISSING"}] patch.resources=${JSON.stringify((dbgPatch as { resources?: unknown } | undefined)?.resources)} patch.build_q=${JSON.stringify((dbgPatch as { build_q?: unknown } | undefined)?.build_q)} live.resources=${JSON.stringify(dbgLive?.resources)} live.build_q=${JSON.stringify(dbgLive?.build_q)}${lbHtml ? ` moon1:486:7.41_html=${lbHtml}` : ""}`,
            }),
          }).catch(() => {});
        } catch { /* */ }
        } // end if(false) — v0.0.508 forensic gated
        // Expose to BOTH sandboxed window AND page's real window (unsafeWindow)
        // so devtools console eval can read/write the store directly.
        (env.win as Window & { __ogamexStore?: typeof store }).__ogamexStore = store;
        const pw = (typeof unsafeWindow !== "undefined" ? unsafeWindow : env.win) as Window & { __ogamexStore?: typeof store };
        pw.__ogamexStore = store;
      }
    } catch (e) {
      console.warn(`[OgameX/empire] fetch failed:`, e);
    }
  }
  // Operator 2026-05-25: "不要用倒計時，都用事件驅動". Removed periodic
  // pollEmpire setInterval. Triggers that refresh empire now:
  //   1. Boot seed +12s (initial state hydration).
  //   2. eventbox_hook friendly-fleet-count delta DECREASE → fleet
  //      returned, fresh ship counts arriving.
  //   3. ApiExec sendFleet success → fresh launch, update inventory.
  //   4. ApiExec scheduleEntry capture (build queued) → state.snapshot
  //      delta picks up new queue entry.
  //   5. wire.ts data.refresh downstream from sidecar.
  // Build/research level updates rely on events 2-5 organically (fleet
  // launches happen daily, builds complete around them). If state ever
  // drifts, daemon's data.refresh enqueues a force pull.
  scheduleBurst(pollEmpire, 12_000);
  // Expose globally so ApiExec can request a refresh on demand.
  (env.win as Window & { __ogamexPollEmpire?: () => Promise<void> }).__ogamexPollEmpire = pollEmpire;
  // v0.0.606 — expose forced refreshOnePage for event-driven sniffer signals.
  // v0.0.625 — extended to forward forcePlanetId so the goals panel's
  // "🔄 同步該星球" button can target a specific planet without changing
  // operator's current session cp.
  (env.win as Window & { __ogamexRefreshOnePage?: (forcePage?: string, forcePlanetId?: string) => Promise<void> }).__ogamexRefreshOnePage = refreshOnePage;
  // Diagnostic helper — operator calls __ogamexDebugGalaxy(g,s) in DevTools.
  // CRITICAL: Tampermonkey sandboxes env.win. DevTools console sees PAGE
  // window (unsafeWindow). Must dual-expose for console access.
  const debugGalaxyFn = async (g: number, s: number): Promise<string> => {
    const url = `/game/index.php?page=ingame&component=galaxy&action=fetchGalaxyContent&ajax=1&asJson=1`;
    const body = new URLSearchParams({ galaxy: String(g), system: String(s) }).toString();
    const r = await env.win.fetch(url, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Requested-With": "XMLHttpRequest" },
      body,
    });
    const t = await r.text();
    console.info(`[__ogamexDebugGalaxy] ${g}:${s} HTTP ${r.status} len=${t.length}`);
    console.info(`[__ogamexDebugGalaxy] resp[0:2000]=`, t.slice(0, 2000));
    try { void navigator.clipboard?.writeText(t); } catch { /* */ }
    return t;
  };
  (env.win as Window & { __ogamexDebugGalaxy?: typeof debugGalaxyFn }).__ogamexDebugGalaxy = debugGalaxyFn;
  // Page-world expose for DevTools console access (cross-sandbox bridge).
  const pageWinForDbg = (typeof unsafeWindow !== "undefined" ? unsafeWindow : env.win) as Window & {
    __ogamexDebugGalaxy?: typeof debugGalaxyFn;
    __ogamexDbgMis?: (g: number, s: number, p: number) => Promise<unknown>;
  };
  pageWinForDbg.__ogamexDebugGalaxy = debugGalaxyFn;
  // Ultra-short helper: __ogamexDbgMis(1,484,5) returns position's full
  // data + logs availableMissions array. Operator's DevTools wraps long
  // chained .then() — separate helper avoids that.
  const debugMissionsFn = async (g: number, s: number, p: number): Promise<unknown> => {
    const t = await debugGalaxyFn(g, s);
    try {
      const j = JSON.parse(t) as { system?: { galaxyContent?: Array<{ position?: number; availableMissions?: unknown[] }> } };
      const row = j.system?.galaxyContent?.find((c) => c.position === p);
      if (!row) { console.warn(`[__ogamexDbgMis] no position=${p} in ${g}:${s}`); return null; }
      console.info(`[__ogamexDbgMis] ${g}:${s}:${p} availableMissions:`, JSON.stringify(row.availableMissions, null, 2));
      console.info(`[__ogamexDbgMis] ${g}:${s}:${p} full:`, JSON.stringify(row, null, 2));
      return row;
    } catch (e) {
      console.warn(`[__ogamexDbgMis] JSON parse failed`, e);
      return null;
    }
  };
  (env.win as Window & { __ogamexDbgMis?: typeof debugMissionsFn }).__ogamexDbgMis = debugMissionsFn;
  pageWinForDbg.__ogamexDbgMis = debugMissionsFn;
  // Also expose a focused helper: refresh empire then return THIS planet's
  // ship counts. ApiExec calls this RIGHT BEFORE each expedition so the
  // launch decision is based on data fetched microseconds ago. Owner's
  // explicit requirement: "每次遠征之前從 api 拿最新的艦船數量".
  (env.win as Window & { __ogamexFetchPlanetShips?: (pid: string) => Promise<Record<string, number>> })
    .__ogamexFetchPlanetShips = async (pid: string): Promise<Record<string, number>> => {
    // GROUND TRUTH = fleetdispatch SPA chunk. Endpoint chosen 2026-05-25
    // via live probe: `componentOnly&component=fleetdispatch&ajax=1` is the
    // exact endpoint ogame's own SPA uses when navigating to /fleetdispatch
    // — returns 131KB chunk vs 352KB full-page (63% smaller) with identical
    // inline data block. /empire endpoint counts in-transit ships as owned,
    // so we can't use it for hangar-only ground truth.
    //
    // Primary parser: inline JS `var shipsOnPlanet = [{"id":203,"number":N}, ...]`
    //   This is ogame's own structured data dump (not DOM). Same pattern we
    //   use for /movement slot harvest. Missing ship id == 0 in hangar.
    // Fallbacks: `data-max-amount` DOM regex (legacy DOM scrape) kept for
    //   resilience if ogame ever refactors the inline JS block.
    try {
      // pid is target planet (might differ from operator's current cp). Use
      // helper for proper busy gate + restore. bypassBusy because this is
      // pre-flight resource check for FS emergency, not visible to operator.
      const r = await fetchWithCp(
        `/game/index.php?page=componentOnly&component=fleetdispatch&ajax=1`,
        { credentials: "same-origin", headers: { "X-Requested-With": "XMLHttpRequest" } },
        pid,
        { bypassBusy: true },
      );
      if (!r.ok) {
        console.warn(`[OgameX/fetchShips] fd-chunk HTTP ${r.status} for ${pid} → ABORT preflight`);
        return {};
      }
      const html = await r.text();
      const ships: Record<string, number> = {};
      // PRIMARY: inline JS shipsOnPlanet block (ogame's official data dump).
      // Format: `var shipsOnPlanet = [{"id":203,"number":4500}, ...];`
      // IDs not listed = 0 ships (write zeros so downstream `have < need`
      // comparisons work correctly).
      const onPlanetMatch = html.match(/var\s+shipsOnPlanet\s*=\s*(\[[\s\S]*?\])\s*;/);
      if (onPlanetMatch) {
        try {
          const arr = JSON.parse(onPlanetMatch[1]!) as Array<{ id?: number; number?: number }>;
          // Initialize all ship ids to 0; populate from response. ogame ship
          // tech IDs are 3-digit 202-219; buildings 21..24 also startsWith("2")
          // but with length 2 — gate strictly on 3-digit numeric.
          for (const tid of Object.keys(TECH_ID_TO_NAME)) {
            if (tid.length === 3 && tid.startsWith("2")) {
              const name = TECH_ID_TO_NAME[tid]!;
              ships[name] = 0;
            }
          }
          for (const entry of arr) {
            const tid = String(entry.id ?? "");
            const n = typeof entry.number === "number" ? entry.number : 0;
            const name = TECH_ID_TO_NAME[tid];
            if (name) ships[name] = n;
          }
          console.info(`[OgameX/fetchShips] ${pid} via inline shipsOnPlanet: ${arr.length} ship types listed`);
        } catch (e) {
          console.warn(`[OgameX/fetchShips] inline shipsOnPlanet JSON parse failed:`, e);
          for (const k of Object.keys(ships)) delete ships[k];
        }
      }
      // FALLBACK A: name="am2XX" ... data-max-amount="N"
      if (Object.keys(ships).length === 0) {
        const patternA = /name="am(\d+)"[^>]*data-max-amount="(\d+)"/g;
        for (const m of html.matchAll(patternA)) {
          const tid = String(m[1] ?? ""); const max = parseInt(m[2] ?? "0", 10);
          const name = TECH_ID_TO_NAME[tid];
          if (name && tid.startsWith("2")) ships[name] = max;
        }
      }
      // FALLBACK B: data-max-amount="N" ... name="am2XX" (attr order reversed)
      if (Object.keys(ships).length === 0) {
        const patternB = /data-max-amount="(\d+)"[^>]*name="am(\d+)"/g;
        for (const m of html.matchAll(patternB)) {
          const max = parseInt(m[1] ?? "0", 10); const tid = String(m[2] ?? "");
          const name = TECH_ID_TO_NAME[tid];
          if (name && tid.startsWith("2")) ships[name] = max;
        }
      }
      if (Object.keys(ships).length === 0) {
        const patternC = /data-amount="(\d+)"[^>]*data-technology="(2\d+)"/g;
        for (const m of html.matchAll(patternC)) {
          const max = parseInt(m[1] ?? "0", 10); const tid = String(m[2] ?? "");
          const name = TECH_ID_TO_NAME[tid];
          if (name) ships[name] = max;
        }
      }
      // Last resort: parse the lifeform-style amount spans, e.g.
      //   <span class="amount" data-value="N" ...> within technology2XX
      if (Object.keys(ships).length === 0) {
        const patternD = /technology[^"]*?(2\d{2})[^>]*>[\s\S]{0,500}?data-value="(\d+)"/g;
        for (const m of html.matchAll(patternD)) {
          const tid = String(m[1] ?? ""); const max = parseInt(m[2] ?? "0", 10);
          const name = TECH_ID_TO_NAME[tid];
          if (name) ships[name] = max;
        }
      }
      // If empty parse — disambiguate:
      //   - SPA chunk (>5KB) with fleetdispatch markers but NO ship inputs
      //     = planet truly has 0 ships. Write zeros to store, return zeros.
      //   - Small response or no chunk markers = unknown, fall back to store.
      if (Object.keys(ships).length === 0) {
        // SPA chunk endpoint does NOT carry <meta name="ogame-planet-id">
        // (that lives in the full-page chrome only). Verify response is a
        // valid fleetdispatch chunk via the `<div id='fleetdispatch'>` marker
        // ogame always emits. cp=PID drives session for this endpoint
        // reliably (it's the SPA's own path; no leaky session-cp mode).
        const isValidChunk = /id=['"]fleetdispatch['"]/.test(html);
        const isSubstantial = html.length > 5000;
        const hasAmAny = /\bam20\d\b|\bam21\d\b|\bam22\d\b/.test(html);
        if (!isValidChunk) {
          // Not a fleetdispatch chunk at all (maybe ogame redirect / error)
          // — can't trust this for hangar count. Abort preflight.
          console.warn(`[OgameX/fetchShips] ${pid}: response missing fleetdispatch chunk marker (${html.length}B) → ABORT preflight`);
          return {};
        }
        if (isSubstantial && !hasAmAny) {
          // 0 am2XX inputs in full fd page (ogame v12 may render via JS).
          // Fallback: use empire data (just refreshed by ApiExec's pre-
          // preflight pollEmpire) MINUS in-transit ships from fleets_outbound
          // = true launchable count.
          const empireShips = store.state.planets[pid]?.ships ?? {};
          const p = store.state.planets[pid];
          const coordStr = p?.coords ? p.coords.join(":") : "";
          const inTransit: Record<string, number> = {};
          // Source 1: state.fleets_outbound (from /movement scrape). Each
          // entry's `ships` field is usually empty {} for synthetic fleets,
          // so this source rarely contributes. Kept defensively.
          for (const f of store.state.fleets_outbound ?? []) {
            const fOrig = Array.isArray(f.origin) ? f.origin.join(":") : "";
            if (fOrig !== coordStr || !coordStr) continue;
            const fs = (f as { ships?: Record<string, number> }).ships ?? {};
            for (const [s, n] of Object.entries(fs)) {
              if (typeof n !== "number") continue;
              inTransit[s] = (inTransit[s] ?? 0) + n;
            }
          }
          // Source 2: __ogamexInflightLaunches — populated by ApiExec right
          // after a successful sendFleet POST. This is the AUTHORITATIVE
          // count of ships we just launched from this planet but haven't
          // seen reflected in empire yet. Operator 2026-05-25: "派了缺船的
          // 艦隊" — empire reports owned ships (= still counts in-flight as
          // owned), state.fleets_outbound has empty ships{}, so preflight
          // over-estimated. Track our own launches as ground truth.
          const inflight = (env.win as Window & {
            __ogamexInflightLaunches?: Map<string, Array<{ ships: Record<string, number>; ts: number }>>;
          }).__ogamexInflightLaunches;
          if (inflight) {
            const launches = inflight.get(pid) ?? [];
            const TTL_MS = 90 * 60 * 1000;  // 90min: longest realistic exp round-trip
            const fresh = launches.filter((x) => Date.now() - x.ts < TTL_MS);
            inflight.set(pid, fresh);
            for (const x of fresh) {
              for (const [s, n] of Object.entries(x.ships)) {
                if (typeof n !== "number" || n <= 0) continue;
                inTransit[s] = (inTransit[s] ?? 0) + n;
              }
            }
          }
          const launchable: Record<string, number> = {};
          for (const [s, n] of Object.entries(empireShips)) {
            if (typeof n !== "number") continue;
            launchable[s] = Math.max(0, n - (inTransit[s] ?? 0));
          }
          console.warn(`[OgameX/fetchShips] ${pid}: chunk has no am2XX/shipsOnPlanet, fallback empire-minus-transit: launchable=${JSON.stringify(launchable)} inTransit=${JSON.stringify(inTransit)}`);
          return launchable;
        }
        // Chunk too small but has marker — partial render. Fall back to store.
        console.warn(`[OgameX/fetchShips] PARSE failed for ${pid} (${html.length}B); using fresh store ships`);
        return store.state.planets[pid]?.ships ?? {};
      }
      console.info(`[OgameX/fetchShips] ${pid}: ${JSON.stringify(ships)}`);
      // Mirror hangar truth into store (race-safe via setPlanetsPatch).
      const p = store.state.planets[pid];
      if (p) {
        store.setPlanetsPatch({ [pid]: { ships: { ...p.ships, ...ships } } });
      }
      return ships;
    } catch (e) {
      // Network error → CONSERVATIVE ABORT (was: return store stale data which
      // led to "發了缺船的遠征"). Daemon retries next tick.
      console.warn(`[OgameX/fetchShips] fd fetch failed for ${pid} → ABORT preflight:`, e);
      return {};
    }
  };
  // Dual-expose to page world (unsafeWindow) so DevTools console can call it
  // for verification. Tampermonkey sandbox isolates env.win from page-world
  // window; ApiExec calls work fine via env.win, but operator's DevTools
  // sees the bare page-world window. Mirror to both.
  try {
    const pwShips = (typeof unsafeWindow !== "undefined" ? unsafeWindow : env.win) as Window & {
      __ogamexFetchPlanetShips?: (pid: string) => Promise<Record<string, number>>;
    };
    pwShips.__ogamexFetchPlanetShips = (env.win as Window & {
      __ogamexFetchPlanetShips?: (pid: string) => Promise<Record<string, number>>;
    }).__ogamexFetchPlanetShips;
  } catch { /* unsafeWindow may be undefined in tests */ }

  // One-shot prereq discovery — fetch technologyDetails for every lifeform
  // building on boot and dump real requirements to console. Operator
  // copies this into shared/lifeform/humans_tech.ts. Removes the guessing.
  // v0.0.674 — operator 2026-06-03 cp/token audit: this loop used to call
  // env.win.fetch directly with cp written into the POST body, fully
  // bypassing safe_fetch's cp mutex + restore + click_lock. Routed through
  // fetchWithCp (the only sanctioned cp= entry; the check-no-raw-cp gate
  // missed it because cp was in body, not URL). cp now goes in URL via
  // safe_fetch; bypassBusy + skipRestore keeps the 12-shot loop from
  // shifting the operator's session-cp view for each request.
  scheduleBurst(async () => {
    const LF_IDS = [11101, 11102, 11103, 11104, 11105, 11106, 11107, 11108, 11109, 11110, 11111, 11112];
    const planetId = env.doc.querySelector<HTMLMetaElement>('meta[name="ogame-planet-id"]')?.content;
    if (!planetId) {
      console.warn("[OgameX/lf-prereq] no planet id, skipping prereq dump");
      return;
    }
    // ogame's own technologydetails endpoint pattern (from page HTML):
    //   POST /game/index.php?page=ingame&component=technologydetails&ajax=1&action=getDetails
    //   body: technology=<id>&token=<jsToken>   (cp moved to URL via fetchWithCp)
    const win = env.win as Window & { token?: string };
    const jsToken = win.token ?? "";
    const { fetchWithCpBypassBusy } = await import("./api/safe_fetch.js");
    for (const tid of LF_IDS) {
      try {
        const url = `/game/index.php?page=ingame&component=technologydetails&ajax=1&action=getDetails`;
        const body = new URLSearchParams();
        body.set("technology", String(tid));
        if (jsToken) body.set("token", jsToken);
        const r = await fetchWithCpBypassBusy(
          url,
          {
            method: "POST",
            credentials: "same-origin",
            headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Requested-With": "XMLHttpRequest" },
            body,
          },
          planetId,
          { skipRestore: true },
        );
        if (!r.ok) { console.warn(`[OgameX/lf-prereq] tid=${tid} HTTP ${r.status}`); continue; }
        const txt = await r.text();
        // (silent — body content already used for prereq table; no spam)
        void txt;
      } catch (e) {
        console.warn(`[OgameX/lf-prereq] tid=${tid} fetch failed`, e);
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    // (lf-prereq discovery-complete silenced — one-shot boot diagnostic, done)
  }, 15_000);
  // refreshOnePage periodic timer REMOVED (operator: "ogame 的改成事件觸發").
  // The function is still called from DOM mutation handler when ogame's
  // ajaxNavigation actually loads a research/supplies/etc page — which
  // means data refreshes when it CAN change (operator visits page) rather
  // than 6 req/min unconditionally. Was 6/min, now event-driven (≈0 idle).

  // 7. Persist on every state.updated, debounced loosely
  let persistTimer: ReturnType<typeof setTimeout> | null = null;
  // Event-driven expedition trigger — when fleets_outbound drops (a fleet
  // returned), force sidecar to fire its expedition tick immediately
  // instead of waiting for the daemon's safety-net periodic tick. Sidecar
  // ALSO does this on its end (state.snapshot handler), but firing from
  // userscript shortcuts the round-trip — sidecar might receive a state
  // push with delta only every 5s. Combined: detection ≤ 1s end-to-end.
  let lastFleetCount = Array.isArray(store.state.fleets_outbound) ? store.state.fleets_outbound.length : 0;
  function maybeFireExpeditionTrigger(): void {
    const cur = store.state.fleets_outbound;
    const n = Array.isArray(cur) ? cur.length : 0;
    if (n < lastFleetCount) {
      try {
        const bridgeBase = (env.win.localStorage.getItem("OGAMEX_BRIDGE_URL") ?? "https://ogame.anyfq.com");
        void env.win.fetch(`${bridgeBase.replace(/\/$/, "")}/ogamex/v1/expedition/trigger`, {
          method: "POST",
          credentials: "omit",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        }).catch(() => { /* sidecar may be down; safety net catches */ });
      } catch { /* */ }
      // v0.0.489 — operator 2026-05-30 "有船到了要更新資源" event-driven.
      // Fleet count dropped = a fleet returned OR arrived at its destination
      // (cargo unloaded there). Either way the destination/source body's
      // resources just changed. Trigger immediate pollEmpire(force) to refresh
      // resources for ALL bodies (now that pollEmpire extracts resources via
      // the v0.0.489 broad-net parser). Without this, sidecar lags by the
      // periodic poll interval (~30s+).
      void pollEmpire({ force: true }).catch((e) => console.warn("[OgameX] event-driven pollEmpire failed", e));
    }
    lastFleetCount = n;
  }
  const offState = bus.on("state.updated", () => {
    maybeFireExpeditionTrigger();
    if (persistTimer) return;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      void store.persist().catch((e) => console.warn("[OgameX] persist failed", e));
    }, 1000);
  });

  const summary: BootSummary = {
    resources_ok: resources !== null,
    storage_ok: storage !== null,
    production_ok: production !== null,
    lifeform_resources_ok: lifeform_resources !== null,
    events_count: events.length,
    planets_count: planets.length,
    fleet_movements_count: fleets.length,
    token_present: token !== null,
    ogame_meta,
  };

  // Expose store EARLY (at boot return) so devtools console eval works
  // immediately — operator's emergency drills inject events_incoming via
  // __ogamexStore.setPartial({...}), no need to wait for first empire poll.
  (env.win as Window & { __ogamexStore?: typeof store }).__ogamexStore = store;
  try {
    const pw = (typeof unsafeWindow !== "undefined" ? unsafeWindow : env.win) as Window & { __ogamexStore?: typeof store };
    pw.__ogamexStore = store;
  } catch { /* unsafeWindow may be undefined in non-Tampermonkey contexts (tests) */ }

  // v0.0.754 — operator "ogame 服务器时间还是不对". evidence-driven:
  // sidecar fleet arrival_at=1780562066000 ms (UTC 08:34:26) vs ogame UI
  // 显示 "09:34:26 小時" → 服务器实际 UTC+1 (CET) 全年, **不应用 DST**.
  // v0.0.752 用 Europe/Berlin IANA 在夏天自动 CEST=UTC+2, panel 比 ogame
  // 快 1h. 改 fixed UTC+1 offset (匹配 gameforge .org/.gameforge.com 服务器).
  // localStorage `ogamex.server.tz_offset_hours` 可 override (其他时区 universe).
  const tsMetaStr = env.doc.querySelector<HTMLMetaElement>('meta[name="ogame-timestamp"]')?.content ?? "";
  const tsMeta = parseInt(tsMetaStr, 10);
  const tsMetaPerfMs = performance.now(); // baseline at boot
  if (Number.isFinite(tsMeta) && tsMeta > 0) {
    let tzOffsetHours = 1; // fixed CET (gameforge default)
    try {
      const override = env.win.localStorage.getItem("ogamex.server.tz_offset_hours");
      if (override !== null) {
        const parsed = parseFloat(override);
        if (Number.isFinite(parsed)) tzOffsetHours = parsed;
      }
    } catch { /* localStorage blocked = use default */ }
    const tzOffsetSec = Math.floor(tzOffsetHours * 3600);
    env.win.setInterval(() => {
      try {
        const tgt = env.doc.querySelector("#ogamex-server-time");
        if (!tgt) return;
        const elapsedSec = Math.floor((performance.now() - tsMetaPerfMs) / 1000);
        const serverNow = tsMeta + elapsedSec + tzOffsetSec;
        const d = new Date(serverNow * 1000);
        const hh = String(d.getUTCHours()).padStart(2, "0");
        const mm = String(d.getUTCMinutes()).padStart(2, "0");
        const ss = String(d.getUTCSeconds()).padStart(2, "0");
        tgt.textContent = `${hh}:${mm}:${ss}`;
      } catch { /* tick failure non-fatal */ }
    }, 1000);
  }

  // Cargo Calc pending-fill — operator 2026-05-26: "從本星球準備多少船去拉資源".
  // Panel "📤 Fill" navigates to CURRENT planet's fleetdispatch (source = current
  // planet, has ships). pending-fill carries {shipId, n}; planetId is the cp we
  // navigated to (current cp). Apply if numeric n > 0, regardless of cp match.
  if (/component=fleetdispatch/.test(env.win.location?.href ?? "")) {
    try {
      const raw = env.win.sessionStorage.getItem("ogamex.fleet.pending-fill");
      if (raw) {
        const { shipId, n } = JSON.parse(raw) as { shipId: number; n: number; planetId: string };
        if (shipId && n > 0) {
          // ogame fleetdispatch DOM may render lazily; retry up to 10× over 5s.
          let attempts = 0;
          const tryFill = (): void => {
            attempts++;
            // Live DOM 2026-05-26: ogame v12 input is <input id="ship203" name="ship[203]">.
            // Use page-world script injection so ogame's own jQuery handlers
            // (which manage internal selectedShips model) receive the change —
            // sandbox dispatchEvent doesn't reach them.
            const input = env.doc.querySelector<HTMLInputElement>(`#ship${shipId}`);
            if (input) {
              const script = env.doc.createElement("script");
              script.textContent = `
                (function() {
                  var inp = document.getElementById('ship${shipId}');
                  if (!inp) return;
                  inp.focus();
                  if (window.jQuery) {
                    window.jQuery(inp).val('${n}').trigger('input').trigger('change').trigger('keyup').trigger('blur');
                  } else {
                    inp.value = '${n}';
                    inp.dispatchEvent(new Event('input', { bubbles: true }));
                    inp.dispatchEvent(new Event('change', { bubbles: true }));
                    inp.dispatchEvent(new Event('keyup', { bubbles: true }));
                  }
                })();
              `;
              env.doc.body.appendChild(script);
              env.doc.body.removeChild(script);
              env.win.sessionStorage.removeItem("ogamex.fleet.pending-fill");
              console.info(`[OgameX/cargo-fill] filled ship[${shipId}]=${n} via page-world jQuery`);
            } else if (attempts < 10) {
              setTimeout(tryFill, 500);
            } else {
              console.warn(`[OgameX/cargo-fill] gave up — input ship[${shipId}] not found after ${attempts} attempts`);
              env.win.sessionStorage.removeItem("ogamex.fleet.pending-fill");
            }
          };
          setTimeout(tryFill, 300);
        }
      }
    } catch (e) { console.warn("[OgameX/cargo-fill] failed:", e); }
  }

  return {
    bus,
    store,
    summary,
    stop() {
      stopMO();
      offDomChanged();
      offState();
      if (persistTimer) clearTimeout(persistTimer);
      clearTimeout(lateExtract1);
      clearTimeout(lateExtract2);
    },
  };
}
