/**
 * WeMail-owned agent delivery protocol.
 *
 * Runtime implementations (including PI) terminate at a server adapter. SSE,
 * persistence, and renderer code consume only the contracts in this module.
 */

export const WEMAIL_AGENT_EVENT_SCHEMA_VERSION = 1 as const;

export type AgentJsonPrimitive = string | number | boolean | null;
export type AgentJsonValue =
  | AgentJsonPrimitive
  | AgentJsonValue[]
  | { [key: string]: AgentJsonValue };

export type WemailAgentRunState =
  | "queued"
  | "running"
  | "retrying"
  | "stopping"
  | "stopped"
  | "failed"
  | "interrupted"
  | "settled";

export type WemailAgentMessageRole = "user" | "assistant" | "system";

export interface WemailAgentEventBase {
  schemaVersion: typeof WEMAIL_AGENT_EVENT_SCHEMA_VERSION;
  conversationId: string;
  runId: string;
  messageId?: string;
  sequence: number;
  timestamp: string;
}

export type WemailAgentCitationSource =
  | {
      kind: "mail";
      emailId: string;
      label?: string;
      excerpt?: string;
    }
  | {
      kind: "attachment";
      attachmentId: string;
      label?: string;
      page?: number;
      excerpt?: string;
    }
  | {
      kind: "record";
      recordType: string;
      recordId: string;
      label?: string;
    };

export interface WemailAgentCitation {
  id: string;
  source: WemailAgentCitationSource;
}

export interface WemailAgentArtifact {
  artifactId: string;
  version: number;
  kind: "brief" | "report" | "dashboard" | "deck";
  contentHash: string;
  title: string;
  preview: string;
  applicationMessageId: string;
  /** Compact provenance/data shape shown beside the in-chat artifact card. */
  dataSummary?: {
    sourceEmailCount: number;
    rowCount: number;
    timePointCount: number;
    timeGrain?: "hour" | "day";
  };
}

export type WemailAgentConfirmationStatus =
  | "pending"
  | "confirmed"
  | "rejected"
  | "expired"
  | "failed";

export interface WemailAgentConfirmation {
  id: string;
  actionType: string;
  description: string;
  riskLevel: "low" | "medium" | "high";
  parameters: Record<string, AgentJsonValue>;
  expiresAt: string;
  idempotencyKey: string;
  status: WemailAgentConfirmationStatus;
}

export type WemailAgentEvent =
  | (WemailAgentEventBase & { type: "run_started" })
  | (WemailAgentEventBase & {
      type: "run_state_changed";
      state: WemailAgentRunState;
    })
  | (WemailAgentEventBase & { type: "run_settled" })
  | (WemailAgentEventBase & {
      type: "run_stopped";
      reason?: string;
    })
  | (WemailAgentEventBase & {
      type: "run_failed";
      code: string;
      message: string;
      retryable: boolean;
    })
  | (WemailAgentEventBase & {
      type: "message_started";
      role: WemailAgentMessageRole;
    })
  | (WemailAgentEventBase & { type: "message_completed" })
  | (WemailAgentEventBase & {
      type: "progress_added";
      partId: string;
      text: string;
    })
  | (WemailAgentEventBase & {
      type: "reasoning_started";
      partId: string;
    })
  | (WemailAgentEventBase & {
      type: "reasoning_delta";
      partId: string;
      delta: string;
    })
  | (WemailAgentEventBase & {
      type: "reasoning_completed";
      partId: string;
      text: string;
    })
  | (WemailAgentEventBase & {
      type: "text_started";
      partId: string;
    })
  | (WemailAgentEventBase & {
      type: "text_delta";
      partId: string;
      delta: string;
    })
  | (WemailAgentEventBase & {
      type: "text_completed";
      partId: string;
      text: string;
    })
  | (WemailAgentEventBase & {
      type: "tool_call_started";
      toolCallId: string;
      toolName: string;
    })
  | (WemailAgentEventBase & {
      type: "tool_args_delta";
      toolCallId: string;
      delta: string;
    })
  | (WemailAgentEventBase & {
      type: "tool_args_completed";
      toolCallId: string;
      input: Record<string, AgentJsonValue>;
    })
  | (WemailAgentEventBase & {
      type: "tool_execution_started";
      toolCallId: string;
    })
  | (WemailAgentEventBase & {
      type: "tool_execution_updated";
      toolCallId: string;
      output?: AgentJsonValue;
      summary?: string;
    })
  | (WemailAgentEventBase & {
      type: "tool_execution_completed";
      toolCallId: string;
      output?: AgentJsonValue;
      summary?: string;
    })
  | (WemailAgentEventBase & {
      type: "tool_execution_failed";
      toolCallId: string;
      code: string;
      message: string;
    })
  | (WemailAgentEventBase & {
      type: "confirmation_requested";
      confirmation: WemailAgentConfirmation;
    })
  | (WemailAgentEventBase & {
      type: "confirmation_resolved";
      confirmationId: string;
      status: Exclude<WemailAgentConfirmationStatus, "pending">;
      result?: AgentJsonValue;
    })
  | (WemailAgentEventBase & {
      type: "followup_queued";
      followupId: string;
      position: number;
    })
  | (WemailAgentEventBase & {
      type: "followup_updated";
      followupId: string;
      position: number;
      text: string;
    })
  | (WemailAgentEventBase & {
      type: "followup_removed";
      followupId: string;
    })
  | (WemailAgentEventBase & {
      type: "followup_paused";
      followupId: string;
      reason: "user_stopped" | "application_restarted" | "manual";
    })
  | (WemailAgentEventBase & {
      type: "retry_started";
      attempt: number;
      maxAttempts: number;
    })
  | (WemailAgentEventBase & {
      type: "retry_scheduled";
      attempt: number;
      delayMs: number;
      reason: string;
    })
  | (WemailAgentEventBase & {
      type: "retry_completed";
      attempt: number;
    })
  | (WemailAgentEventBase & {
      type: "retry_failed";
      attempt: number;
      message: string;
    })
  | (WemailAgentEventBase & {
      type: "attachment_ready";
      attachmentId: string;
      relativePath: string;
    })
  | (WemailAgentEventBase & {
      type: "attachment_failed";
      attachmentId?: string;
      name: string;
      code: string;
      message: string;
    })
  | (WemailAgentEventBase & {
      type: "artifact_ready";
      partId: string;
      artifact: WemailAgentArtifact;
    })
  | (WemailAgentEventBase & {
      type: "citation_added";
      citation: WemailAgentCitation;
      partId?: string;
    });

export type WemailAgentMessagePart =
  | {
      id: string;
      type: "progress";
      text: string;
      state: "completed";
    }
  | {
      id: string;
      type: "reasoning";
      text: string;
      state: "streaming" | "completed" | "stopped" | "failed";
    }
  | {
      id: string;
      type: "text";
      markdown: string;
      state: "streaming" | "completed" | "stopped" | "failed";
      citationIds: string[];
    }
  | {
      id: string;
      type: "tool";
      toolCallId: string;
    }
  | {
      id: string;
      type: "confirmation";
      confirmationId: string;
    }
  | {
      id: string;
      type: "artifact";
      artifact: WemailAgentArtifact;
    }
  | {
      id: string;
      type: "error";
      code: string;
      message: string;
    };

export interface PersistedAgentMessage {
  id: string;
  conversationId: string;
  runId?: string;
  role: WemailAgentMessageRole;
  parts: WemailAgentMessagePart[];
  attachmentIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface PersistedAgentRun {
  id: string;
  conversationId: string;
  state: WemailAgentRunState;
  lastSequence: number;
  startedAt?: string;
  settledAt?: string;
  interruptedAt?: string;
  errorCode?: string;
}

export interface PersistedAgentToolExecution {
  toolCallId: string;
  runId: string;
  toolName: string;
  input?: Record<string, AgentJsonValue>;
  output?: AgentJsonValue;
  state:
    | "receiving_args"
    | "ready"
    | "running"
    | "completed"
    | "failed";
  summary?: string;
  errorCode?: string;
  startedAt?: string;
  endedAt?: string;
}

export interface PersistedAgentFollowup {
  id: string;
  conversationId: string;
  text: string;
  attachmentIds: string[];
  position: number;
  state: "queued" | "paused" | "running" | "completed" | "removed";
  createdAt: string;
  updatedAt: string;
}

export interface PersistedAgentAttachmentReference {
  attachmentId: string;
  messageId: string;
  position: number;
}

export interface PersistedAgentBehaviorEvent {
  id: string;
  accountId: string;
  type:
    | "user_input"
    | "user_edit"
    | "user_confirmed"
    | "user_rejected"
    | "mail_action";
  conversationId?: string;
  runId?: string;
  payload: Record<string, AgentJsonValue>;
  createdAt: string;
}

export interface PersistedAgentPreference {
  id: string;
  accountId: string;
  key: string;
  value: AgentJsonValue;
  provenanceEventIds: string[];
  confidence: number;
  lastConfirmedAt: string;
  updatedAt: string;
}

const EVENT_TYPES = new Set<WemailAgentEvent["type"]>([
  "run_started",
  "run_state_changed",
  "run_settled",
  "run_stopped",
  "run_failed",
  "message_started",
  "message_completed",
  "progress_added",
  "reasoning_started",
  "reasoning_delta",
  "reasoning_completed",
  "text_started",
  "text_delta",
  "text_completed",
  "tool_call_started",
  "tool_args_delta",
  "tool_args_completed",
  "tool_execution_started",
  "tool_execution_updated",
  "tool_execution_completed",
  "tool_execution_failed",
  "confirmation_requested",
  "confirmation_resolved",
  "followup_queued",
  "followup_updated",
  "followup_removed",
  "followup_paused",
  "retry_started",
  "retry_scheduled",
  "retry_completed",
  "retry_failed",
  "attachment_ready",
  "attachment_failed",
  "artifact_ready",
  "citation_added",
]);

export function isWemailAgentEvent(value: unknown): value is WemailAgentEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Record<string, unknown>;
  const validBase =
    event.schemaVersion === WEMAIL_AGENT_EVENT_SCHEMA_VERSION &&
    typeof event.conversationId === "string" &&
    event.conversationId.length > 0 &&
    typeof event.runId === "string" &&
    event.runId.length > 0 &&
    typeof event.sequence === "number" &&
    Number.isSafeInteger(event.sequence) &&
    event.sequence >= 0 &&
    typeof event.timestamp === "string" &&
    event.timestamp.length > 0 &&
    typeof event.type === "string" &&
    EVENT_TYPES.has(event.type as WemailAgentEvent["type"]);
  if (!validBase) return false;

  const isString = (candidate: unknown): candidate is string =>
    typeof candidate === "string";
  const isNumber = (candidate: unknown): candidate is number =>
    typeof candidate === "number" && Number.isFinite(candidate);
  const isRecord = (candidate: unknown): candidate is Record<string, unknown> =>
    !!candidate && typeof candidate === "object" && !Array.isArray(candidate);
  const hasPart = () => isString(event.partId);
  const hasToolCall = () => isString(event.toolCallId);

  switch (event.type as WemailAgentEvent["type"]) {
    case "run_started":
    case "run_settled":
    case "message_completed":
      return true;
    case "run_state_changed":
      return isString(event.state);
    case "run_stopped":
      return event.reason === undefined || isString(event.reason);
    case "run_failed":
      return isString(event.code) && isString(event.message) && typeof event.retryable === "boolean";
    case "message_started":
      return event.role === "user" || event.role === "assistant" || event.role === "system";
    case "progress_added":
      return hasPart() && isString(event.text);
    case "reasoning_started":
    case "text_started":
      return hasPart();
    case "reasoning_delta":
    case "text_delta":
      return hasPart() && isString(event.delta);
    case "reasoning_completed":
    case "text_completed":
      return hasPart() && isString(event.text);
    case "tool_call_started":
      return hasToolCall() && isString(event.toolName);
    case "tool_args_delta":
      return hasToolCall() && isString(event.delta);
    case "tool_args_completed":
      return hasToolCall() && isRecord(event.input);
    case "tool_execution_started":
      return hasToolCall();
    case "tool_execution_updated":
    case "tool_execution_completed":
      return hasToolCall() && (event.summary === undefined || isString(event.summary));
    case "tool_execution_failed":
      return hasToolCall() && isString(event.code) && isString(event.message);
    case "confirmation_requested": {
      if (!isRecord(event.confirmation)) return false;
      const confirmation = event.confirmation;
      return (
        isString(confirmation.id) &&
        isString(confirmation.actionType) &&
        isString(confirmation.description) &&
        (confirmation.riskLevel === "low" ||
          confirmation.riskLevel === "medium" ||
          confirmation.riskLevel === "high") &&
        isRecord(confirmation.parameters) &&
        isString(confirmation.expiresAt) &&
        isString(confirmation.idempotencyKey) &&
        confirmation.status === "pending"
      );
    }
    case "confirmation_resolved":
      return (
        isString(event.confirmationId) &&
        (event.status === "confirmed" ||
          event.status === "rejected" ||
          event.status === "expired" ||
          event.status === "failed")
      );
    case "followup_queued":
      return isString(event.followupId) && isNumber(event.position);
    case "followup_updated":
      return isString(event.followupId) && isNumber(event.position) && isString(event.text);
    case "followup_removed":
      return isString(event.followupId);
    case "followup_paused":
      return (
        isString(event.followupId) &&
        (event.reason === "user_stopped" ||
          event.reason === "application_restarted" ||
          event.reason === "manual")
      );
    case "retry_started":
      return isNumber(event.attempt) && isNumber(event.maxAttempts);
    case "retry_scheduled":
      return isNumber(event.attempt) && isNumber(event.delayMs) && isString(event.reason);
    case "retry_completed":
      return isNumber(event.attempt);
    case "retry_failed":
      return isNumber(event.attempt) && isString(event.message);
    case "attachment_ready":
      return isString(event.attachmentId) && isString(event.relativePath);
    case "attachment_failed":
      return isString(event.name) && isString(event.code) && isString(event.message);
    case "artifact_ready": {
      if (!hasPart() || !isRecord(event.artifact)) return false;
      const artifact = event.artifact;
      return (
        isString(artifact.artifactId) &&
        isNumber(artifact.version) &&
        (artifact.kind === "brief" ||
          artifact.kind === "report" ||
          artifact.kind === "dashboard" ||
          artifact.kind === "deck") &&
        isString(artifact.contentHash) &&
        isString(artifact.title) &&
        isString(artifact.preview) &&
        isString(artifact.applicationMessageId)
      );
    }
    case "citation_added": {
      if (!isRecord(event.citation) || !isString(event.citation.id)) return false;
      const source = event.citation.source;
      if (!isRecord(source) || !isString(source.kind)) return false;
      if (source.kind === "mail") return isString(source.emailId);
      if (source.kind === "attachment") return isString(source.attachmentId);
      return source.kind === "record" && isString(source.recordType) && isString(source.recordId);
    }
  }
  return false;
}
