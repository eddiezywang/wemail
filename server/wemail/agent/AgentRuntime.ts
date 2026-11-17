/**
 * Provider-agnostic agent runtime interface (Handoff §5.J).
 *
 * The built-in agent is PI. This interface is the seam that lets us
 * later swap in a different runtime without touching the tool surface
 * or the HTTP routes.
 *
 * Events are streamed as an async generator so the renderer can show
 * incremental tool calls and assistant text. All events are strictly
 * JSON-safe — the runtime never emits mail body content into traces
 * (see `MailAgentTools` for redaction).
 *
 * Every tool-driven run must finish with a structured `conclusion` event
 * before `done`. `terminate` is only a control-flow signal; it is not a
 * substitute for a user-facing success, failure, or cancellation result.
 */

import type { JsonSchema, ToolInput } from "./AgentTypes.js";
import type {
  AgentChatInput,
  AgentEvent as SharedAgentEvent,
} from "../../../shared/wemail/agent.js";
import type { AgentPendingAction } from "../../../shared/wemail/intelligence.js";

export interface AgentRunInput extends AgentChatInput {
  /**
   * Cancels the active model request and any abort-aware tool work. This is
   * supplied by the HTTP request lifecycle and is never serialized.
   */
  signal?: AbortSignal;
  /**
   * Arbitrary opaque payload the caller can use to seed context for
   * the agent (e.g. the currently-focused messageId). The runtime
   * does not inspect this — it's forwarded to tool handlers via
   * the tool-call context.
   */
  context?: Record<string, unknown>;
  /**
   * Shortcut for the currently-focused email. If provided, this is
   * merged into context.emailId. Tools that need an email id will
   * fall back to this when their input.id is missing.
   */
  emailId?: string;
  /**
   * Emails @-attached to this user turn (multi-mail scope). Merged into
   * context.emailIds; the model reads each by id instead of searching.
   */
  emailIds?: string[];
  /**
   * Account context for the agent run. Merged into context.accountId.
   */
  accountId?: string;
  /**
   * Thread context for the agent run. Merged into context.threadId.
   */
  threadId?: string;
}

export type AgentEvent = SharedAgentEvent;

export interface AgentToolContext {
  sessionId?: string;
  runContext?: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface AgentTool {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  handler: (input: ToolInput, ctx: AgentToolContext) => Promise<unknown>;
  observe?: (output: unknown) => string;
}

/**
 * A structured, provider-neutral tool failure that must stop the current run.
 *
 * Tool handlers should throw {@link AgentTerminalToolError} when they can
 * provide a stable error code and a safe, actionable user message, such as for
 * a required local executable not being installed. The PI runtime also stops
 * on ordinary tool errors; this richer type preserves domain-specific UX.
 */
export interface AgentTerminalToolFailure {
  ok: false;
  terminal: true;
  code: string;
  error: string;
  /** Optional recovery action that still requires explicit user confirmation. */
  pendingAction?: AgentPendingAction;
}

export class AgentTerminalToolError extends Error {
  readonly code: string;
  readonly userMessage: string;
  readonly pendingAction?: AgentPendingAction;

  constructor(input: {
    code: string;
    userMessage: string;
    pendingAction?: AgentPendingAction;
    cause?: unknown;
  }) {
    super(input.userMessage);
    this.name = "AgentTerminalToolError";
    this.code = input.code;
    this.userMessage = input.userMessage;
    this.pendingAction = input.pendingAction;
    if (input.cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = input.cause;
    }
  }

  toFailure(): AgentTerminalToolFailure {
    return {
      ok: false,
      terminal: true,
      code: this.code,
      error: this.userMessage,
      ...(this.pendingAction ? { pendingAction: this.pendingAction } : {}),
    };
  }
}

export function isAgentTerminalToolFailure(
  value: unknown,
): value is AgentTerminalToolFailure {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<AgentTerminalToolFailure>;
  return (
    candidate.ok === false &&
    candidate.terminal === true &&
    typeof candidate.code === "string" &&
    candidate.code.length > 0 &&
    typeof candidate.error === "string" &&
    candidate.error.length > 0
  );
}

export interface AgentRuntime {
  run(input: AgentRunInput): AsyncGenerator<AgentEvent, void, unknown>;
  registerTool(tool: AgentTool): void;
  listTools(): Array<Pick<AgentTool, "name" | "description" | "inputSchema">>;
}
