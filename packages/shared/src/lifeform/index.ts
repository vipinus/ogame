import type { LifeformSpecies } from "../types.js";
import type { LifeformTechCatalog } from "./types.js";
import humans from "./humans_tech.js";
import rocktal from "./rocktal_tech.js";
import mechas from "./mechas_tech.js";
import kaelesh from "./kaelesh_tech.js";

export * from "./types.js";
export * from "./artifacts.js";

export const LIFEFORM_TECH: Record<LifeformSpecies, LifeformTechCatalog> = {
  humans,
  rocktal,
  mechas,
  kaelesh,
};
