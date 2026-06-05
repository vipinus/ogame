/**
 * Phase 10 (v0.0.785) — operator memory `planner_simulate_shared_helper` SOP:
 * "planner 动态 prereq (energy/storage/etc) 必须 export helper 给 simulate
 * 复用; 双字段 `{level, targetLevel}` 让 planner 用单级 dispatch 用 level /
 * simulate 用 targetLevel 全展开".
 *
 * 这里抽 lifeform population/food balance — kaelesh sanctuary↔
 * antimatterCondenser, humans residentialSector↔biosphereFarm. planner.ts
 * 跟 sidecar/index.ts 之前各持一份 inline POPULATION_FOOD_BY_SPECIES, 不再.
 *
 * Living-space / well-fed resource fields 在 userscript lifeform_resources
 * 提取器里是 species-agnostic — 每个 species 自己 buildings 驱动数值,
 * helper 只比较数. Food 是 supporter — housing > food 时 emit food child.
 */

export interface PopulationFoodRule {
  population: readonly string[];
  food: string;
}

export const POPULATION_FOOD_BY_SPECIES: Record<string, PopulationFoodRule> = {
  humans: {
    population: ["residentialSector", "skyscraper", "metropolis"],
    food: "biosphereFarm",
  },
  kaelesh: {
    // Sanctuary (圣殿) is kaelesh's primary housing; antimatterCondenser
    // (反物质凝聚器) is the satiety counterpart. Other kaelesh buildings
    // can be added here later if/when they also drive living_space.
    population: ["sanctuary"],
    food: "antimatterCondenser",
  },
  // rocktal / mechas — not yet wired (no operator goals against them yet).
};

/**
 * Check if a population building should emit a food building child.
 * Returns `null` if no balance rule applies OR conditions not met,
 * otherwise `{ rule, currentFoodLevel }` for caller to build cascade child.
 *
 * Caller — planner emits subGoal (dispatch); simulate emits child node
 * (prereq tree display). Both use this same check so they stay in sync.
 */
export function needsFoodCascade(
  techName: string,
  species: string,
  lifeformBuildings: Record<string, number>,
  lifeformResources: { living_space?: number | null; well_fed?: number | null } | null | undefined,
  current: number,
  targetLevel: number,
): { rule: PopulationFoodRule; currentFoodLevel: number } | null {
  // Operator 2026-06-05 stack overflow fix: 必须 current < targetLevel
  // (unmet) 才 emit. 否则 antimatterCondenser 之 requires {sanctuary:1}
  // 又递归到 sanctuary L1 (met) → food gate 再 trigger → 死循环.
  if (current >= targetLevel) return null;
  const rule = POPULATION_FOOD_BY_SPECIES[species];
  if (!rule) return null;
  if (!rule.population.includes(techName)) return null;
  const livingSpace = lifeformResources?.living_space ?? null;
  const wellFed = lifeformResources?.well_fed ?? null;
  if (livingSpace === null || wellFed === null) return null;
  if (livingSpace <= wellFed) return null; // food still adequate
  const currentFoodLevel = lifeformBuildings[rule.food] ?? 0;
  return { rule, currentFoodLevel };
}
