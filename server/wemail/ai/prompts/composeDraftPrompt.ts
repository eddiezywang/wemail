/**
 * Generic compose-draft prompt. One template handles three modes:
 *   - NEW: write a fresh email from the user's intent.
 *   - REPLY: write a contextual reply, addressing the original sender's
 *     points without quoting them verbatim.
 *   - POLISH (intent + currentBody): treat intent as instructions for
 *     editing the existing draft (rewrite / shorten / extend / fix).
 *
 * The model returns body markdown plus structured envelope and scheduling
 * intent. Employee addresses are resolved by the caller, never guessed here.
 */

import type { WritingStyle } from "../../../../shared/wemail/settings.js";
import type { WemailAddress, WemailMessage } from "../../../../shared/wemail/mail.js";
import type { ProcessorWorkspaceContext } from "../../../../shared/wemail/intelligence.js";
import { resolveAiBodyText } from "../context/ContextBuilder.js";
import { formatWorkspaceContext } from "./workspaceFormatting.js";

export const COMPOSE_DRAFT_SYSTEM_PROMPT = Object.freeze(
  [
    "You are WeMail's draft-writing assistant.",
    "Write a complete email BODY suitable for sending after the user's review.",
    "A complete reply normally includes an appropriate greeting, a context-aware response, and a natural closing sentence. Do not output the user's instruction as the email.",
    "If the instruction is ambiguous enough that writing would require guessing, return a clarification question and leave draftMarkdown empty.",
    "Strict rules:",
    "  1. The draftMarkdown field contains body markdown only. Put a proposed subject in the subject field; do NOT include headers or 'From:'/'To:' lines in the body.",
    "  2. Do NOT include a signature block (no 'Best,' / 'Thanks,' followed by a name) unless the user's intent explicitly asks for one. The user's signature is appended automatically.",
    "  3. If a 'CURRENT DRAFT' block is provided, treat the user's intent as edit instructions and produce the revised draft. Preserve the user's voice; only change what the intent asks for.",
    "  4. If an 'ORIGINAL EMAIL' block is provided, this is a reply. Address the sender's specific points; do not quote the original verbatim.",
    "  5. Match the requested target language when given. Match the requested writing style's tone when given.",
    "  6. Stay concise — under ~1500 characters of body text unless the intent specifically asks for more.",
    "  7. You only draft. The user reviews and sends; never include 'sending now' or auto-send phrasing.",
    "  8. Do not invent facts, attachments, dates, decisions, or commitments that are absent from the user's instruction and the original email.",
    "  9. Never guess an employee email address. Put colleague names or explicit addresses in recipientChanges for server-side directory resolution.",
    "  10. Recipient operations default to add. Use replace or remove only when the user explicitly asks to replace, exclusively address, or remove recipients.",
    "  11. If the user requests a precise future send time, return an ISO-8601 timestamp in suggestedSendAt using CLIENT NOW and CLIENT TIMEZONE. Otherwise leave it empty or ask for clarification.",
    "Return only the structured JSON object described by the schema.",
  ].join(" "),
) as string;

export const COMPOSE_DRAFT_JSON_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["status", "subject", "draftMarkdown", "recipientChanges", "suggestedSendAt", "questions", "missingFields"],
  properties: {
    status: {
      type: "string",
      enum: ["draft", "needsClarification"],
    },
    draftMarkdown: { type: "string" },
    subject: { type: "string" },
    recipientChanges: {
      type: "object",
      additionalProperties: false,
      required: ["to", "cc", "bcc"],
      properties: {
        to: recipientChangeSchema(),
        cc: recipientChangeSchema(),
        bcc: recipientChangeSchema(),
      },
    },
    suggestedSendAt: { type: "string" },
    questions: {
      type: "array",
      items: { type: "string" },
      maxItems: 3,
    },
    missingFields: {
      type: "array",
      items: { type: "string" },
      maxItems: 5,
    },
  },
}) as Record<string, unknown>;

function recipientChangeSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["operation", "recipients"],
    properties: {
      operation: { type: "string", enum: ["add", "replace", "remove"] },
      recipients: {
        type: "array",
        items: { type: "string" },
        maxItems: 20,
      },
    },
  };
}

const BODY_CHAR_BUDGET = 6000;
const CURRENT_BODY_CHAR_BUDGET = 4000;

function formatFrom(from: WemailAddress | string | undefined | null): string {
  if (!from) return "(unknown sender)";
  if (typeof from === "string") return from;
  return from.name ? `${from.name} <${from.email}>` : from.email;
}

function truncate(text: string, budget: number): string {
  if (text.length <= budget) return text;
  return `${text.slice(0, budget)}\n[... truncated ...]`;
}

/**
 * Minimal email shape required by the compose-draft prompt. Both the
 * server-side `MailMessage` (IMAP-shaped) and the renderer-facing
 * `WemailMessage` satisfy this; we don't pin to either so callers don't
 * have to reconstruct fields the prompt never reads (mailboxId, folderId,
 * etc.).
 */
export interface ComposeDraftOriginalEmail {
  subject: string;
  from: WemailAddress;
  bodyText?: string;
  bodyHtml?: string;
}

function originalBodyText(original: ComposeDraftOriginalEmail): string {
  const body = resolveAiBodyText(original).text.trim();
  return body ? truncate(body, BODY_CHAR_BUDGET) : "(empty body)";
}

export interface ComposeDraftPromptInput {
  operationType: "NEW" | "REPLY";
  intent: string;
  original?: ComposeDraftOriginalEmail | null;
  to?: string[];
  targetLanguage?: string;
  style?: WritingStyle | null;
  /** When provided, the prompt switches to "rewrite this draft" mode. */
  currentBody?: string;
  currentSubject?: string;
  currentTo?: string[];
  currentCc?: string[];
  currentBcc?: string[];
  clientNow?: string;
  clientTimeZone?: string;
}

export function buildComposeDraftUserMessage(
  input: ComposeDraftPromptInput,
  workspace?: ProcessorWorkspaceContext,
): string {
  const lines: string[] = [];

  lines.push(`### MODE: ${input.operationType}`);
  if (input.targetLanguage) {
    lines.push(`### TARGET LANGUAGE: ${input.targetLanguage}`);
  }
  if (input.style) {
    lines.push(
      `### STYLE: ${input.style.name}${
        input.style.description ? ` — ${input.style.description}` : ""
      }`,
    );
    if (input.style.instructions) {
      lines.push(`### STYLE INSTRUCTIONS:\n${input.style.instructions}`);
    }
  }
  if (input.to && input.to.length > 0) {
    lines.push(`### RECIPIENTS: ${input.to.join(", ")}`);
  }
  if (input.currentTo?.length || input.currentCc?.length || input.currentBcc?.length) {
    lines.push("### CURRENT ENVELOPE:");
    lines.push(`To: ${input.currentTo?.join(", ") || "(empty)"}`);
    lines.push(`Cc: ${input.currentCc?.join(", ") || "(empty)"}`);
    lines.push(`Bcc: ${input.currentBcc?.join(", ") || "(empty)"}`);
  }
  if (input.clientNow) lines.push(`### CLIENT NOW: ${input.clientNow}`);
  if (input.clientTimeZone) lines.push(`### CLIENT TIMEZONE: ${input.clientTimeZone}`);

  const intent = (input.intent ?? "").trim();
  lines.push("");
  lines.push("### USER INTENT:");
  lines.push(intent || "(no specific intent — produce a reasonable draft)");

  const currentBody = (input.currentBody ?? "").trim();
  if (currentBody) {
    lines.push("");
    lines.push("### CURRENT DRAFT (to revise per the user intent):");
    if (input.currentSubject) {
      lines.push(`Subject: ${input.currentSubject}`);
    }
    lines.push(truncate(currentBody, CURRENT_BODY_CHAR_BUDGET));
  }

  if (input.operationType === "REPLY" && input.original) {
    lines.push("");
    lines.push("### ORIGINAL EMAIL (to reply to):");
    lines.push(`Subject: ${input.original.subject || "(no subject)"}`);
    lines.push(`From: ${formatFrom(input.original.from)}`);
    lines.push("");
    lines.push("Body:");
    lines.push(originalBodyText(input.original));
  }

  lines.push("");
  lines.push(
    "Return status=draft with a complete body and structured changes. Leave subject, recipient lists, and suggestedSendAt empty when the user did not request changes. Return status=needsClarification with one concise question when the request is too ambiguous to execute safely.",
  );

  // No-op when workspace is undefined or all sections empty (Route C / WP J.3).
  return lines.join("\n") + formatWorkspaceContext(workspace);
}
