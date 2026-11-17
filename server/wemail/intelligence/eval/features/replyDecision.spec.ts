import {
  REPLY_DECISION_SYSTEM_PROMPT,
  REPLY_DECISION_JSON_SCHEMA,
  buildReplyDecisionUserMessage,
} from "../../../ai/prompts/replyDecisionPrompt.js";
import { REPLY_DECISION_PROCESSOR_VERSION } from "../../processors/ReplyDecisionProcessor.js";
import { parseJsonWithFallbacks } from "../FeatureSpec.js";
import { defineSingleTurnSpec, type SingleTurnPromptSpec } from "../SingleTurnPromptSpec.js";
import { scoreFormat, scoreAccuracy, scoreSafety } from "../scoring/RuleScorer.js";

const QUALITY_RUBRIC =
  'Quality means: shouldReply matches the email\'s actual conversational pull (a direct ask → reply; a notification → no reply); the reason is observable ("asks for confirmation" vs vague "important email").';

export const replyDecisionSpec: SingleTurnPromptSpec = defineSingleTurnSpec<unknown>({
  kind: "single-turn",
  id: "replyDecision",
  description: "Decide whether the user should reply to this email.",
  promptVersion: String(REPLY_DECISION_PROCESSOR_VERSION),
  systemPrompt: REPLY_DECISION_SYSTEM_PROMPT,
  jsonSchema: REPLY_DECISION_JSON_SCHEMA,

  buildUserMessage(sample) {
    return buildReplyDecisionUserMessage(
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
    format: (parsed, raw) => scoreFormat("replyDecision", parsed, raw),
    accuracy: (parsed, sample) => scoreAccuracy("replyDecision", parsed, sample),
    safety: (parsed, raw, sample) => scoreSafety("replyDecision", parsed ?? null, raw, sample),
    qualityRubric: QUALITY_RUBRIC,
  },
});
