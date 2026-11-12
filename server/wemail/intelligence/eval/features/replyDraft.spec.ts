import {
  REPLY_DRAFT_SYSTEM_PROMPT,
  REPLY_DRAFT_JSON_SCHEMA,
  buildReplyDraftUserMessage,
} from "../../../ai/prompts/replyDraftPrompt.js";
import { parseJsonWithFallbacks } from "../FeatureSpec.js";
import { defineSingleTurnSpec, type SingleTurnPromptSpec } from "../SingleTurnPromptSpec.js";
import { scoreFormat, scoreAccuracy, scoreSafety } from "../scoring/RuleScorer.js";

const REPLY_DRAFT_PROMPT_VERSION = 2; // mirrors composition/intelligence.ts

const QUALITY_RUBRIC =
  "Quality means: the medium variant is a fluent, business-direct reply that addresses what the email actually asks; tone variants meaningfully differ; nothing is auto-sent; nothing fabricates commitments. Does NOT mean: JSON shape.";

export const replyDraftSpec: SingleTurnPromptSpec = defineSingleTurnSpec<unknown>({
  kind: "single-turn",
  id: "replyDraft",
  description: "Three-variant reply draft (short / medium / long).",
  promptVersion: String(REPLY_DRAFT_PROMPT_VERSION),
  systemPrompt: REPLY_DRAFT_SYSTEM_PROMPT,
  jsonSchema: REPLY_DRAFT_JSON_SCHEMA,

  buildUserMessage(sample) {
    return buildReplyDraftUserMessage(
      {
        subject: sample.mail.subject,
        from: sample.mail.from,
        to: sample.mail.to,
        cc: sample.mail.cc,
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
    format: (parsed, raw) => scoreFormat("replyDraft", parsed, raw),
    accuracy: (parsed, sample) => scoreAccuracy("replyDraft", parsed, sample),
    safety: (parsed, raw, sample) => scoreSafety("replyDraft", parsed ?? null, raw, sample),
    qualityRubric: QUALITY_RUBRIC,
  },

  // Production only invokes this when shouldReply=true.
  sampleFilter: (sample) => sample.expected?.shouldReply !== false,
});
