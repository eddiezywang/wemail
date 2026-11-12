import type { AgentCitation, AgentPendingAction } from "./intelligence.js";

export type AgentActionRisk = "safe" | "needs-confirmation" | "blocked";

export interface AgentActionPreview {
  id: string;
  title: string;
  description: string;
  risk: AgentActionRisk;
  toolName: string;
  inputJson: string;
}

/** Display-only metadata for the email attached to a user turn. */
export interface AgentAttachedMail {
  emailId?: string;
  subject: string;
  sender?: string;
  receivedAt?: string;
}

/** Presentation-only labels rendered beneath a user turn in the Agent thread. */
export interface AgentMessageContext {
  actionTags?: string[];
  attachedMail?: AgentAttachedMail;
  attachedMails?: AgentAttachedMail[];
}

/** Max mails a single user turn may attach. */
export const MAX_ATTACHED_MAILS = 10;

function normalizeAttachedMail(value: unknown): AgentAttachedMail | undefined {
  if (!value || typeof value !== "object") return undefined;
  const mail = value as Record<string, unknown>;
  const subject = typeof mail.subject === "string" ? mail.subject.trim() : "";
  if (!subject) return undefined;
  return {
    ...(typeof mail.emailId === "string" && mail.emailId.trim()
      ? { emailId: mail.emailId.trim() }
      : {}),
    subject: subject.slice(0, 240),
    ...(typeof mail.sender === "string" && mail.sender.trim()
      ? { sender: mail.sender.trim().slice(0, 160) }
      : {}),
    ...(typeof mail.receivedAt === "string" && mail.receivedAt.trim()
      ? { receivedAt: mail.receivedAt.trim().slice(0, 80) }
      : {}),
  };
}

export function normalizeAgentMessageContext(value: unknown): AgentMessageContext | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  const actionTags = Array.isArray(candidate.actionTags)
    ? candidate.actionTags
        .filter((tag): tag is string => typeof tag === "string")
        .map((tag) => tag.trim().slice(0, 80))
        .filter(Boolean)
        .slice(0, 4)
    : [];
  const attachedMail = normalizeAttachedMail(candidate.attachedMail);
  const attachedMails = Array.isArray(candidate.attachedMails)
    ? candidate.attachedMails
        .map(normalizeAttachedMail)
        .filter((mail): mail is AgentAttachedMail => !!mail)
        // Dedupe by emailId (or subject when id-less) and cap the list.
        .filter((mail, index, all) =>
          all.findIndex((other) =>
            (other.emailId ?? other.subject) === (mail.emailId ?? mail.subject)) === index)
        .slice(0, MAX_ATTACHED_MAILS)
    : [];
  if (actionTags.length === 0 && !attachedMail && attachedMails.length === 0) return undefined;
  return {
    ...(actionTags.length > 0 ? { actionTags } : {}),
    ...(attachedMail ? { attachedMail } : {}),
    ...(attachedMails.length > 0 ? { attachedMails } : {}),
  };
}

export interface AgentChatInput {
  userText: string;
  sessionId?: string;
  accountId?: string;
  emailId?: string;
  threadId?: string;
  attachedMail?: AgentAttachedMail;
  /** Multiple mails attached to one user turn (@ mentions). */
  attachedMails?: AgentAttachedMail[];
  messageContext?: AgentMessageContext;
  context?: Record<string, unknown>;
  persist?: boolean;
}

export type AgentConclusionStatus =
  | "succeeded"
  | "failed"
  | "blocked"
  | "needs_input"
  | "cancelled";

export interface AgentFailureContext {
  /** Exact registered tool name that failed. */
  tool: string;
  /** Provider-issued tool call id, when available. */
  toolCallId?: string;
  /** Redacted command reconstructed from the tool input, when applicable. */
  command?: string;
}

export type AgentEvent =
  | {
      /**
       * Concise, user-visible narration of the next meaningful step.
       * This is safe display copy, not the model provider's private reasoning.
       */
      type: "progress_update";
      text: string;
      runId?: string;
    }
  | { type: "thinking"; text: string; runId?: string }
  | { type: "reasoning_start"; contentIndex: number; runId?: string }
  | {
      type: "reasoning_delta";
      contentIndex: number;
      text: string;
      runId?: string;
    }
  | {
      type: "reasoning_end";
      contentIndex: number;
      text: string;
      runId?: string;
    }
  | { type: "text_start"; contentIndex: number; runId?: string }
  | {
      type: "text_delta";
      contentIndex: number;
      text: string;
      citations?: AgentCitation[];
      runId?: string;
    }
  | {
      type: "text_end";
      contentIndex: number;
      text: string;
      citations?: AgentCitation[];
      runId?: string;
    }
  | {
      type: "tool_call";
      tool: string;
      input: Record<string, unknown>;
      callReason?: string;
      toolCallId?: string;
      runId?: string;
      startedAt?: string;
    }
  | {
      type: "tool_result";
      tool: string;
      output: unknown;
      observation?: string;
      toolCallId?: string;
      runId?: string;
      isError?: boolean;
      startedAt?: string;
      endedAt?: string;
    }
  | {
      type: "tool_update";
      tool: string;
      output: unknown;
      observation?: string;
      toolCallId?: string;
      runId?: string;
    }
  | {
      type: "assistant_text";
      text: string;
      citations?: AgentCitation[];
      runId?: string;
    }
  | {
      /**
       * Structured, user-facing outcome emitted when an agent execution
       * reaches a terminal state. This is distinct from `terminate`, which is
       * a control-flow signal and must not be the only explanation the user
       * receives.
       */
      type: "conclusion";
      status: AgentConclusionStatus;
      summary: string;
      reason?: string;
      impact?: string;
      nextAction?: string;
      failureContext?: AgentFailureContext;
      runId?: string;
    }
  | { type: "pending_action"; action: AgentPendingAction; runId?: string }
  | { type: "terminate"; reason: string; runId?: string }
  | { type: "error"; message: string; runId?: string }
  | {
      type: "retry_scheduled";
      attempt: number;
      delayMs: number;
      reason: string;
      runId?: string;
    }
  | {
      type: "retry_started";
      attempt: number;
      maxAttempts: number;
      runId?: string;
    }
  | { type: "retry_completed"; attempt: number; runId?: string }
  | {
      type: "retry_failed";
      attempt: number;
      message: string;
      runId?: string;
    }
  | { type: "done"; runId?: string };

/**
 * High-risk action types that the agent must never execute directly.
 * Re-exported from intelligence.ts for convenience.
 */
export type {
  HighRiskActionType,
  AgentPendingAction,
  AgentCitation,
  AgentSuggestionItem,
} from "./intelligence.js";
export type {
  AccountSuggestionContext,
  AgentSuggestion,
  AgentSuggestionAction,
} from "./usage.js";
