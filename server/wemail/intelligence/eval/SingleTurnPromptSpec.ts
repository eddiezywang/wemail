/**
 * Single-turn prompt spec — one LLM call per sample.
 *
 * Used by all the JSON-output features in `features/`:
 *   summary / tags / replyDraft / replyDecision / linkExtraction
 *   (Phase 5: composeDraft / threadSummary / todoExtraction / translation)
 *
 * Scoring contract:
 *   - `format`   : rule-based, deterministic. Schema/field shape only.
 *   - `accuracy` : rule-based against MailSampleEntry.expected ground truth.
 *   - `safety`   : rule-based; default catches injection-bypass + fence echo.
 *   - `quality`  : LLM-judge using `qualityRubric` (Phase 3 parameterizes).
 *   - `customAxes` : optional extra axes (rule or judge).
 */

import type { MailSampleEntry } from "../../testing/mailSamples.js";
import type {
  AxisScore,
  AxisWeights,
  CustomAxisDef,
  PerStratumGates,
} from "./FeatureSpec.js";
import { computePromptHash } from "./FeatureSpec.js";

export interface SingleTurnPromptSpec<TParsed = unknown> {
  kind: "single-turn";
  id: string;
  description: string;

  /** Production prompt version constant (e.g. SUMMARY_PROCESSOR_VERSION). */
  promptVersion: string;
  /** Stable hash of (systemPrompt + jsonSchema) — registry recomputes & checks. */
  promptHash: string;
  systemPrompt: string;
  jsonSchema?: Record<string, unknown>;

  /** Build the user message for one sample. Reuse production helpers. */
  buildUserMessage(sample: MailSampleEntry): string;

  /** Parse raw LLM output. Must include markdown-fence/first-brace fallbacks. */
  parseOutput(
    raw: string,
  ): { ok: true; data: TParsed } | { ok: false; reason: string };

  /** Per-axis scoring functions. */
  scoring: {
    format: (parsed: TParsed | null, raw: string) => AxisScore;
    accuracy: (parsed: TParsed, sample: MailSampleEntry) => AxisScore;
    safety?: (
      parsed: TParsed | null,
      raw: string,
      sample: MailSampleEntry,
    ) => AxisScore;
    /** Rubric handed to the LLM judge for the quality axis. */
    qualityRubric: string;
    customAxes?: CustomAxisDef<TParsed, MailSampleEntry>[];
  };

  /** Override default weights (must still sum to 1.0 incl. custom axes). */
  weights?: Partial<AxisWeights>;
  acceptanceGates?: PerStratumGates;

  /** Run only on samples matching this filter (e.g. shouldReply=true). */
  sampleFilter?: (sample: MailSampleEntry) => boolean;
}

/**
 * Helper for spec authors: takes the spec without `promptHash`, computes
 * the hash, and returns a fully-formed spec. Avoids hand-rolling hashes
 * in every feature file and keeps registry validation honest.
 */
export function defineSingleTurnSpec<TParsed>(
  spec: Omit<SingleTurnPromptSpec<TParsed>, "promptHash">,
): SingleTurnPromptSpec<TParsed> {
  const promptHash = computePromptHash({
    systemPrompt: spec.systemPrompt,
    promptVersion: spec.promptVersion,
    jsonSchema: spec.jsonSchema,
  });
  return { ...spec, promptHash };
}
