/**
 * Userscript panel UI strings, by ogame locale.
 *
 * Layout rule (matches ogame-next's en.json single-source-of-truth):
 *   - `en` is the canonical set. EVERY key must exist here.
 *   - Other locales (zh-TW / "tw", de, fr, …) translate a subset.
 *   - Missing translation falls back to `en` automatically via `t()`.
 *
 * Operator directive 2026-06-02:
 *   - ogame proprietary terms (mission names, building/ship/research
 *     names) DO NOT live in this file. They flow through
 *     `ogame_terms.ts` from ogame's own /api/localization.xml.
 *   - This file only holds UI-shell strings (button labels, modal
 *     titles, error messages, etc.) that ogame doesn't translate.
 *
 * Adding a new key:
 *   1. Add it to `en` first.
 *   2. Optionally translate into `tw` (or any other locale section).
 *   3. Replace the hardcoded literal in panel code with `t("your.key")`.
 *
 * Adding a new locale:
 *   - Drop a new top-level entry mapping `<ogame_slug>: { ...keys }`.
 *   - Untranslated keys silently fall back to English.
 */

export type StringRegistry = Readonly<Record<string, Readonly<Record<string, string>>>>;

export const STRINGS: StringRegistry = {
  en: {
    // Panel header / drag handle
    "panel.title_prefix": "🪐",
    "panel.btn.audit": "Audit log — sidecar persisted events",
    "panel.btn.update": "🔄 v{version}",
    "panel.btn.update_tooltip": "v{version} available — click to install",
    "panel.btn.collapse_expand": "Expand",
    "panel.btn.collapse_collapse": "Collapse",
    "panel.btn.close": "Close (panel will re-mount on next page load)",
    "panel.counter.active": "{n} active",

    // Section toggle / generic
    "panel.section.no_active": "(no active goals)",
    "panel.action.set_main": "★ Set",
    "panel.action.pause": "Pause",
    "panel.action.resume": "Resume",
    "panel.action.cancel": "Cancel",

    // Modal — emergency settings
    "modal.emergency.title": "🚨 Emergency settings",
    "modal.emergency.global_enable": "Global enable",
    "modal.emergency.global_enable_hint": "OFF = globally pause auto fleet-save (manual operations unaffected)",
    "modal.emergency.spy_trigger": "Spy triggers FS",
    "modal.emergency.spy_trigger_hint": "ON = spy events also route through FS chain (default); OFF = only attack triggers",

    // Modal — goals
    "modal.goals.title": "🪐 Regular goals settings",

    // Modal — expedition
    "modal.expedition.title": "🚀 Expedition settings",
    "modal.expedition.tab_planets": "Dispatch planets",
    "modal.expedition.tab_ships": "Fleet template",

    // Modal — transport
    "modal.transport.title": "🚚 Transport task",
    "modal.transport.legend_same_as": "Same as above",

    // Common
    "common.select_planet": "Select a planet",
    "common.select_building": "Select a building",
    "common.select_research": "Select a research",
    "common.creating": "Creating…",
    "common.not_set": "(not set)",
    "common.idle": "Idle",
    "common.moon": "Moon",
    "common.planet": "Planet",
    "common.all_planets": "All planets",
    "common.idle_planet_only": "Idle planets only",
    "common.no_idle_planets": "No idle planets — can't pick 'idle planets only'",
    "common.example_n": "e.g. {n}",
    "common.level_range_1_50": "Level must be 1–50",

    // Update flow
    "panel.update.confirm": "Install OgameX v{version}? Refresh ogame tab after.",
  },

  tw: {
    "panel.title_prefix": "🪐",
    "panel.btn.audit": "稽核日誌 — sidecar 持久化事件",
    "panel.btn.update": "🔄 v{version}",
    "panel.btn.update_tooltip": "新版 v{version} 可用 — 點擊安裝",
    "panel.btn.collapse_expand": "展開",
    "panel.btn.collapse_collapse": "收合",
    "panel.btn.close": "關閉（下次載入頁面時面板會重新出現）",
    "panel.counter.active": "{n} 個進行中",

    "panel.section.no_active": "（沒有進行中的任務）",
    "panel.action.set_main": "★ 設為主要",
    "panel.action.pause": "暫停",
    "panel.action.resume": "繼續",
    "panel.action.cancel": "取消",

    "modal.emergency.title": "🚨 緊急任務設定",
    "modal.emergency.global_enable": "整體啟用",
    "modal.emergency.global_enable_hint": "OFF = 全域暫停 FS 自動起飛（手動操作不受影響）",
    "modal.emergency.spy_trigger": "偵察觸發 FS",
    "modal.emergency.spy_trigger_hint": "ON = 偵察事件也走 FS 鏈路（預設開）；OFF = 僅攻擊觸發",

    "modal.goals.title": "🪐 一般任務設定",

    "modal.expedition.title": "🚀 遠征探險設定",
    "modal.expedition.tab_planets": "發船星球",
    "modal.expedition.tab_ships": "艦隊模板",

    "modal.transport.title": "🚚 運輸任務",
    "modal.transport.legend_same_as": "同上",

    "common.select_planet": "請選星球",
    "common.select_building": "請選建築",
    "common.select_research": "請選研究項目",
    "common.creating": "建立中…",
    "common.not_set": "（未設定）",
    "common.idle": "空閒",
    "common.moon": "月球",
    "common.planet": "星球",
    "common.all_planets": "所有星球",
    "common.idle_planet_only": "空閒星球",
    "common.no_idle_planets": "無空閒星球，無法選「空閒星球」",
    "common.example_n": "例：{n}",
    "common.level_range_1_50": "等級須 1–50",

    "panel.update.confirm": "安裝 OgameX v{version}？安裝後請重新整理 ogame 頁面。",
  },
} as const;
