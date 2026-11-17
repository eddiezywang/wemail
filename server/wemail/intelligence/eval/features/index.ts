/**
 * Built-in feature registry — wires every shipped spec into the
 * registry at static-import time so unit tests and the harness don't
 * need to know individual spec module paths.
 *
 * Phase 5/6 will append composeDraft / threadSummary / todoExtraction /
 * translation / piPlanner / curatorSafety here.
 */

import type { FeatureRegistry } from "../FeatureRegistry.js";

import { summarySpec } from "./summary.spec.js";
import { tagsSpec } from "./tags.spec.js";
import { replyDraftSpec } from "./replyDraft.spec.js";
import { replyDecisionSpec } from "./replyDecision.spec.js";
import { linkExtractionSpec } from "./linkExtraction.spec.js";
import { todoExtractionSpec } from "./todoExtraction.spec.js";
import { piPlannerSpec } from "./piPlanner.spec.js";
import { curatorSafetySpec } from "./curatorSafety.spec.js";

export const BUILTIN_SPECS = [
  summarySpec,
  tagsSpec,
  replyDraftSpec,
  replyDecisionSpec,
  linkExtractionSpec,
  todoExtractionSpec,
  piPlannerSpec,
  curatorSafetySpec,
] as const;

export function registerBuiltins(registry: FeatureRegistry): void {
  for (const spec of BUILTIN_SPECS) {
    registry.registerBuiltin(spec);
  }
}
