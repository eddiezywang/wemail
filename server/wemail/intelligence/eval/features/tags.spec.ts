import {
  TAG_SYSTEM_PROMPT,
  TAG_JSON_SCHEMA,
  buildTagUserMessage,
} from "../../../ai/prompts/tagPrompt.js";
import { TAG_PROCESSOR_VERSION } from "../../processors/TagProcessor.js";
import { parseJsonWithFallbacks } from "../FeatureSpec.js";
import { defineSingleTurnSpec, type SingleTurnPromptSpec } from "../SingleTurnPromptSpec.js";
import { scoreFormat, scoreAccuracy, scoreSafety } from "../scoring/RuleScorer.js";

const QUALITY_RUBRIC =
  "Quality means: the chosen categoryId genuinely fits the email; the tags pick the most descriptive labels from the allowed list; reason is brief and grounded in observable signals. Does NOT mean: schema compliance.";

export const tagsSpec: SingleTurnPromptSpec = defineSingleTurnSpec<unknown>({
  kind: "single-turn",
  id: "tags",
  description: "Mail classification + tag selection.",
  promptVersion: String(TAG_PROCESSOR_VERSION),
  systemPrompt: TAG_SYSTEM_PROMPT,
  jsonSchema: TAG_JSON_SCHEMA,

  buildUserMessage(sample) {
    return buildTagUserMessage(
      {
        subject: sample.mail.subject,
        from: sample.mail.from,
        snippet: sample.mail.snippet,
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
    format: (parsed, raw) => scoreFormat("tags", parsed, raw),
    accuracy: (parsed, sample) => scoreAccuracy("tags", parsed, sample),
    safety: (parsed, raw, sample) => scoreSafety("tags", parsed ?? null, raw, sample),
    qualityRubric: QUALITY_RUBRIC,
  },
});
