/**
 * summary spec — bullets / actionItems / urgency JSON output.
 *
 * Phase 1 thin wrapper: delegates per-axis scoring to the existing
 * RuleScorer entry points, copies the LlmJudge rubric for inspection,
 * and exposes the spec via the registry. No behavior change vs. the
 * pre-refactor switch path.
 */

import {
  SUMMARY_SYSTEM_PROMPT,
  SUMMARY_JSON_SCHEMA,
  buildSummaryUserMessage,
} from "../../../ai/prompts/summaryPrompt.js";
import { SUMMARY_PROCESSOR_VERSION } from "../../processors/SummaryProcessor.js";
import { parseJsonWithFallbacks } from "../FeatureSpec.js";
import { defineSingleTurnSpec, type SingleTurnPromptSpec } from "../SingleTurnPromptSpec.js";
import { scoreFormat, scoreAccuracy, scoreSafety } from "../scoring/RuleScorer.js";

const QUALITY_RUBRIC =
  "Quality means: bullets capture the email's actual asks/decisions (not background); urgency reflects what the email actually demands; nothing is fabricated; numbers/dates are preserved verbatim from the source. Does NOT mean: JSON validity (already scored elsewhere).";

export const summarySpec: SingleTurnPromptSpec = defineSingleTurnSpec<unknown>({
  kind: "single-turn",
  id: "summary",
  description: "Single-mail summary — bullets, actionItems, urgency.",
  promptVersion: String(SUMMARY_PROCESSOR_VERSION),
  systemPrompt: SUMMARY_SYSTEM_PROMPT,
  jsonSchema: SUMMARY_JSON_SCHEMA,

  buildUserMessage(sample) {
    return buildSummaryUserMessage(
      {
        subject: sample.mail.subject,
        from: sample.mail.from,
        bodyText: sample.mail.bodyText,
        bodyHtml: sample.mail.bodyHtml,
      },
      undefined,
    );
  },

  parseOutput(raw) {
    const parsed = parseJsonWithFallbacks(raw);
    if (parsed === null || typeof parsed !== "object") {
      return { ok: false, reason: raw.length === 0 ? "empty" : "unparseable-json" };
    }
    return { ok: true, data: parsed };
  },

  scoring: {
    format: (parsed, raw) => scoreFormat("summary", parsed, raw),
    accuracy: (parsed, sample) => scoreAccuracy("summary", parsed, sample),
    safety: (parsed, raw, sample) => scoreSafety("summary", parsed ?? null, raw, sample),
    qualityRubric: QUALITY_RUBRIC,
  },
});
