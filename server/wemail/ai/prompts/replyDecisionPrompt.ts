/**
 * One fixed phase-one reply-decision prompt.
 *
 * The model decides ONLY whether the email warrants a reply.
 * Draft generation is a separate capability (ReplyDraftProcessor)
 * that runs conditionally after this decision.
 *
 * Rules:
 *   - 通知类邮件 (notifications, receipts, system alerts) → shouldReply=false
 *   - 询问、确认、协作类邮件 (questions, confirmations, collaborative) → shouldReply=true
 *   - 群发邮件 (broadcast / mass mail) → conservative, default shouldReply=false
 */

import type { WemailAddress } from "../../../../shared/wemail/mail.js";
import type { ProcessorWorkspaceContext } from "../../../../shared/wemail/intelligence.js";
import { resolveAiBodyText } from "../context/ContextBuilder.js";
import { formatWorkspaceContext } from "./workspaceFormatting.js";

export const REPLY_DECISION_SYSTEM_PROMPT = Object.freeze(
  [
    "You are WeMail's reply-decision assistant.",
    "Decide whether the recipient should reply to the provided email.",
    "Respond ONLY with a JSON object matching the provided schema.",
    "Rule 1 — 通知类邮件 (notifications, receipts, system alerts) usually do NOT need a reply: set shouldReply=false.",
    "Rule 2 — 询问、确认、协作类邮件 (questions, confirmations, collaborative back-and-forth) typically DO need a reply: set shouldReply=true.",
    "Rule 3 — 群发邮件 (broadcast / mass-mail with many recipients or no direct ask) are handled conservatively: default shouldReply=false unless there is a clear personal ask directed at the recipient.",
    "reason: one short neutral sentence explaining the decision.",
    "confidence: a number between 0 and 1 indicating how confident you are in this decision.",
    "When the input contains an AI Summary instead of the raw body, base the decision on the summary — it preserves dates, amounts, owners, and explicit asks verbatim; do not assume the email is non-actionable just because the raw body is absent.",
  ].join(" "),
) as string;

export const REPLY_DECISION_JSON_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["shouldReply", "reason", "confidence"],
  properties: {
    shouldReply: { type: "boolean" },
    reason: { type: "string", minLength: 1 },
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
}) as Record<string, unknown>;

/** Cap body text before templating to avoid token overflows. */
const BODY_CHAR_BUDGET = 6000;

function formatFrom(from: WemailAddress | string | undefined): string {
  if (!from) return "(unknown sender)";
  if (typeof from === "string") return from;
  return from.name ? `${from.name} <${from.email}>` : from.email;
}

export interface ReplyDecisionPromptInput {
  subject?: string;
  from?: WemailAddress | string;
  to?: WemailAddress[];
  cc?: WemailAddress[];
  snippet?: string;
  bodyText?: string;
  bodyHtml?: string;
  /** Optional summary from the summary processor, if already available */
  summaryText?: string;
}

export function buildReplyDecisionUserMessage(
  mail: ReplyDecisionPromptInput,
  workspace?: ProcessorWorkspaceContext,
): string {
  const subject = (mail.subject ?? "(no subject)").trim() || "(no subject)";
  const from = formatFrom(mail.from);
  const recipientCount =
    (mail.to?.length ?? 0) + (mail.cc?.length ?? 0);

  const bodySource = resolveAiBodyText(mail).text || mail.snippet || "";
  const trimmed =
    bodySource.length > BODY_CHAR_BUDGET
      ? `${bodySource.slice(0, BODY_CHAR_BUDGET)}\n[... truncated ...]`
      : bodySource;

  const lines = [
    "Decide whether the recipient should reply to the following email.",
    "",
    `Subject: ${subject}`,
    `From: ${from}`,
    `Recipient count: ${recipientCount}`,
  ];

  if (mail.summaryText) {
    lines.push("", `AI Summary: ${mail.summaryText}`);
    // Token optimization: the summary pass already read the body and
    // preserves dates/amounts/owners verbatim, and deterministic signals
    // (deadline, question detection, sender) are computed in-process — so
    // re-sending the raw body here would duplicate the same content. When
    // no summary is available (ordering, failure, legacy) fall back to the
    // full body so the decision still has ground truth.
  } else {
    lines.push("", "Body:", trimmed || "(empty body)");
  }

  // No-op when workspace is undefined or all sections empty (Route C / WP J.3).
  return lines.join("\n") + formatWorkspaceContext(workspace);
}
