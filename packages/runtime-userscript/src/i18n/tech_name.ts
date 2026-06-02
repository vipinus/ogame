/**
 * AUTO-GENERATED — DO NOT EDIT BY HAND.
 * Source: shared/tech_ids.ts (camelCase → numeric) ∩
 *         ogame-next/src/data/ogame_terms/tw.json (numeric → tw name)
 * Generated 2026-06-02 (v0.0.656).
 *
 * Operator directive 2026-05-30: "ogame 专有名词从 ogame 网站 api 获取".
 * This map embeds the gameforge-official tw names from ogame's
 * /api/localization.xml so panel rendering of cs.tech / bq.tech /
 * targetStr shows what TW players actually see ingame.
 *
 * Lifeform tech (id >= 11000) is NOT covered here — those need to
 * route through shared/lifeform/*_tech.ts display_name_zh (which
 * v0.0.652 STC-converted to Traditional).
 */

import { getOgameLocaleWithOverride } from "./locale.js";

const CAMEL_TO_TW: Record<string, string> = {
  "metalMine": "金屬礦",
  "crystalMine": "晶體礦",
  "deuteriumSynth": "重氫合成器",
  "solarPlant": "太陽能發電廠",
  "fusionReactor": "核融合反應器",
  "roboticsFactory": "機器人工廠",
  "naniteFactory": "奈米機器人工廠",
  "shipyard": "造船廠",
  "metalStorage": "金屬儲存器",
  "crystalStorage": "晶體儲存器",
  "deuteriumTank": "重氫儲存槽",
  "researchLab": "研究實驗室",
  "allianceDepot": "聯盟太空站",
  "missileSilo": "導彈發射井",
  "lunarBase": "月球基地",
  "sensorPhalanx": "感應陣列",
  "jumpgate": "空間跳躍門",
  "espionageTech": "間諜偵察技術",
  "computerTech": "電腦技術",
  "weapons": "武器技術",
  "shielding": "防禦盾技術",
  "armor": "裝甲技術",
  "energyTech": "能源技術",
  "hyperspaceTech": "超空間科技",
  "combustion": "燃燒引擎",
  "impulseDrive": "脈衝引擎",
  "hyperspaceDrive": "超空間引擎",
  "laserTech": "雷射技術",
  "ionTech": "離子技術",
  "plasmaTech": "電漿技術",
  "intergalactic": "星際研究網路",
  "astrophysics": "天體物理學",
  "gravitonTech": "重子技術",
  "smallCargo": "小型運輸艦",
  "largeCargo": "大型運輸艦",
  "lightFighter": "輕型戰鬥機",
  "heavyFighter": "重型戰鬥機",
  "cruiser": "巡洋艦",
  "battleship": "戰列艦",
  "colonyShip": "殖民船",
  "recycler": "回收船",
  "espionageProbe": "間諜衛星",
  "bomber": "導彈艦",
  "solarSatellite": "太陽能衛星",
  "destroyer": "毀滅者",
  "deathstar": "死星",
  "battlecruiser": "戰鬥巡洋艦",
  "crawler": "履帶車",
  "reaper": "惡魔飛船",
  "explorer": "探路者"
};

/** Translate a camelCase tech identifier to the current locale's display name.
 *  Falls back to the raw camelCase identifier when no mapping is found
 *  (lifeform tech, custom strings, unknown ids).
 */
export function techName(camelCaseId: string): string {
  const locale = getOgameLocaleWithOverride();
  if (locale === "tw") {
    return CAMEL_TO_TW[camelCaseId] ?? camelCaseId;
  }
  return camelCaseId;
}
