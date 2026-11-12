/**
 * HTTP surface for the PI agent runtime (Handoff §5.J).
 *
 * Endpoints (wired):
 *   - GET  /tools          → enumerate registered tool names + schemas.
 *                            For debugging / UI introspection.
 *   - POST /chat           → run a single user turn. Body
 *                            `{ userText, sessionId?, context?, emailId?, accountId?, threadId?, persist? }`.
 *                            Streams versioned `WemailAgentEvent`s as
 *                            `text/event-stream` when the client asks
 *                            for it (`Accept: text/event-stream`);
 *                            otherwise collects events and returns
 *                            `{ events }` as JSON.
 *   - GET  /suggestions    → state-aware suggestions based on intelligence
 *                            state. Supports email-scoped and account-scoped
 *                            queries. When emailId is provided, inspects
 *                            intelligence state to derive missing capabilities.
 *
 * Safety: this route never mounts a send-mail path. The registered
 * tool inventory is whatever the caller supplied via
 * {@link buildAgentRoutes} — by construction that's
 * `createMailAgentTools()`, which excludes any SMTP surface.
 *
 * Phase-one simplification: sessions are ephemeral. Each POST /chat
 * is an independent run; there is no server-side memory between turns.
 * Session resume / persistence is explicitly out of scope (see
 * design.md §Open Questions).
 */

import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { streamSSE } from "hono/streaming";
import type { AgentRuntime } from "../../wemail/agent/AgentRuntime.js";
import type {
  AgentConversationRepository,
  AgentMessageRecord,
} from "../../wemail/agent/AgentConversationRepository.js";
import {
  rowToAction,
  type AgentPendingActionRepository,
  type AgentPendingActionRow,
} from "../../wemail/agent/AgentPendingActionRepository.js";
import type {
  AgentActionExecutionItem,
  AgentActionExecutionResult,
  AgentActionExecutor,
} from "../../wemail/agent/AgentActionExecutor.js";
import type { AgentTitleGenerator } from "../../wemail/agent/AgentTitleGenerator.js";
import type { AgentHomeSuggestionService } from "../../wemail/agent/AgentHomeSuggestionService.js";
import type { AgentSuggestion } from "../../../shared/wemail/usage.js";
import { buildSuggestions } from "../../wemail/agent/SuggestionBuilder.js";
import type { MailDatabaseClient } from "../../wemail/database/MailDatabaseClient.js";
import { MailDatabasePendingActionsParamsSchema } from "../../../shared/wemail/mailDatabaseProtocol.js";
import type { CuratorScheduler } from "../../wemail/agent/CuratorScheduler.js";
import type { McpPreparedOperationRepository } from "../../wemail/mcp/McpPreparedOperationRepository.js";
import {
  MAX_ATTACHED_MAILS,
  normalizeAgentMessageContext,
  type AgentAttachedMail,
  type AgentEvent,
} from "../../../shared/wemail/agent.js";
import { sanitizeAgentDisplayText } from "../../../shared/wemail/agentPresentation.js";
import type { AgentJsonValue, WemailAgentEvent } from "../../../shared/wemail/agentProtocol.js";
import {
  createPiV0806ToWemailEventAdapter,
  type PiEventAdapterContext,
} from "../../wemail/agent/PiEventAdapter.js";
import type { AgentRunRepository } from "../../wemail/agent/AgentRunRepository.js";
import type { AgentEventPersistence } from "../../wemail/agent/AgentEventPersistence.js";
import type { AgentRunCoordinator } from "../../wemail/agent/AgentRunCoordinator.js";
import type { AgentLearningLedger } from "../../wemail/agent/AgentLearningLedger.js";
import type { ActionExecutionPort } from "../../wemail/agent/allowancePort.js";
import { ActionExecutionCommandSchema } from "../../../shared/wemail/actionExecution.js";

export interface AgentRoutesDeps {
  /**
   * P2.6: edition-supplied durable upload executor. Absent in the open
   * edition — the upload_allowance_invoices confirm branch then answers
   * `durable-action-execution-unavailable` (503) instead of accepting, and
   * the progress/SSE endpoints answer `action-execution-unavailable`.
   */
  actionExecutions?: ActionExecutionPort;
  runtime?: AgentRuntime;
  conversations?: AgentConversationRepository;
  runs?: AgentRunRepository;
  eventPersistence?: AgentEventPersistence;
  runCoordinator?: AgentRunCoordinator;
  pendingActions?: AgentPendingActionRepository;
  learning?: AgentLearningLedger;
  mcpOperations?: McpPreparedOperationRepository;
  mailDatabase?: Pick<MailDatabaseClient, "getMailSnapshot" | "getIntelligenceState" | "listPendingActions">;
  /** Account-isolated semantic actions for the empty Agent home state. */
  getHomeActionSuggestions?: (
    accountId: string,
  ) => Promise<{
    suggestions: AgentSuggestion[];
    contextLine?: string;
    source: "rules" | "cached-ai";
    candidateFingerprint: string;
    refreshPending: boolean;
  }> | {
    suggestions: AgentSuggestion[];
    contextLine?: string;
    source: "rules" | "cached-ai";
    candidateFingerprint: string;
    refreshPending: boolean;
  };
  /**
   * Optional title generator. When wired, the chat handler invokes
   * `maybeGenerate(conversationId)` after persisting the assistant
   * reply for fresh (untitled) conversations. Failures are swallowed.
   */
  titleGenerator?: AgentTitleGenerator;
  homeSuggestions?: AgentHomeSuggestionService;
  /**
   * Optional executor that performs the side effect of a confirmed
   * pending action (delete / send / move / etc.). When unwired the
   * confirm path returns 501 instead of marking the row resolved, so a
   * "confirm" click never silently no-ops.
   */
  actionExecutor?: AgentActionExecutor;
  /**
   * Mail Curator scheduler (Route C / WP J.8). When wired, exposes
   * `POST /curator/run` for manual triggers and lets the chat agent
   * register the `run_curator` tool. Returns 503 when unwired.
   */
  curator?: CuratorScheduler;
  /**
   * Active-account resolver, used by the manual curator trigger when
   * the request body omits an explicit accountId.
   */
  getActiveAccountId?: () => string | undefined;
}

/** Maximum title length accepted by PATCH /conversations/:id. */
const MAX_TITLE_LEN = 80;

function parseAttachedMail(value: unknown): AgentAttachedMail | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.subject !== "string") return undefined;
  const subject = candidate.subject.trim();
  if (!subject) return undefined;
  return {
    ...(typeof candidate.emailId === "string" && candidate.emailId.trim()
      ? { emailId: candidate.emailId.trim() }
      : {}),
    subject,
    ...(typeof candidate.sender === "string" && candidate.sender.trim()
      ? { sender: candidate.sender.trim() }
      : {}),
    ...(typeof candidate.receivedAt === "string" && candidate.receivedAt.trim()
      ? { receivedAt: candidate.receivedAt.trim() }
      : {}),
  };
}

/** Parses the @-mention multi-attach list: valid entries only, deduped, capped. */
function parseAttachedMails(value: unknown): AgentAttachedMail[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const mails = value
    .map(parseAttachedMail)
    .filter((mail): mail is AgentAttachedMail => !!mail)
    .filter((mail, index, all) =>
      all.findIndex((other) =>
        (other.emailId ?? other.subject) === (mail.emailId ?? mail.subject)) === index)
    .slice(0, MAX_ATTACHED_MAILS);
  return mails.length > 0 ? mails : undefined;
}

function sanitizeAgentEvent(event: AgentEvent): AgentEvent {
  if (event.type === "assistant_text") {
    return {
      ...event,
      text: sanitizeAgentDisplayText(event.text, {
        preserveWhitespace: true,
      }),
    };
  }
  if (event.type === "thinking" || event.type === "progress_update") {
    return {
      ...event,
      text: sanitizeAgentDisplayText(event.text, {
        preserveWhitespace: true,
      }),
    };
  }
  if (event.type === "text_end" || event.type === "reasoning_end") {
    return {
      ...event,
      text: sanitizeAgentDisplayText(event.text, {
        trim: false,
        preserveWhitespace: true,
      }),
    };
  }
  if (event.type === "terminate") {
    return { ...event, reason: sanitizeAgentDisplayText(event.reason) };
  }
  if (event.type === "conclusion") {
    return {
      ...event,
      summary: sanitizeAgentDisplayText(event.summary, {
        preserveWhitespace: true,
      }),
      ...(event.reason
        ? { reason: sanitizeAgentDisplayText(event.reason) }
        : {}),
      ...(event.impact
        ? { impact: sanitizeAgentDisplayText(event.impact) }
        : {}),
      ...(event.nextAction
        ? { nextAction: sanitizeAgentDisplayText(event.nextAction) }
        : {}),
      ...(event.failureContext
        ? {
            failureContext: {
              tool: sanitizeAgentDisplayText(event.failureContext.tool).slice(
                0,
                120,
              ),
              ...(event.failureContext.toolCallId
                ? {
                    toolCallId: sanitizeAgentDisplayText(
                      event.failureContext.toolCallId,
                    ).slice(0, 200),
                  }
                : {}),
              ...(event.failureContext.command
                ? {
                    command: sanitizeAgentDisplayText(
                      event.failureContext.command,
                      { preserveWhitespace: true },
                    ).slice(0, 1_000),
                  }
                : {}),
            },
          }
        : {}),
    };
  }
  if (event.type === "error") {
    return { ...event, message: sanitizeAgentDisplayText(event.message) };
  }
  return event;
}

function createDeliveryContext(input: {
  conversationId: string;
  runId?: string;
  messageId?: string;
}): PiEventAdapterContext {
  let sequence = 0;
  return {
    conversationId: input.conversationId,
    runId: input.runId ?? `agent-run-${randomUUID()}`,
    messageId: input.messageId ?? `agent-message-${randomUUID()}`,
    nextSequence: () => sequence++,
    now: () => new Date().toISOString(),
  };
}

function finalWemailText(events: readonly WemailAgentEvent[]): string {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type === "text_completed" && event.text.trim()) return event.text;
  }
  return "";
}

function hasTerminalRunEvent(events: readonly WemailAgentEvent[]): boolean {
  return events.some((event) =>
    event.type === "run_settled"
    || event.type === "run_stopped"
    || event.type === "run_failed");
}

function hostRunFailure(
  delivery: PiEventAdapterContext,
  error: unknown,
): WemailAgentEvent {
  return {
    schemaVersion: 1,
    conversationId: delivery.conversationId,
    runId: delivery.runId,
    ...(delivery.messageId ? { messageId: delivery.messageId } : {}),
    sequence: delivery.nextSequence(),
    timestamp: delivery.now(),
    type: "run_failed",
    code: "agent_runtime_failed",
    message: sanitizeAgentDisplayText(
      error instanceof Error ? error.message : "Agent runtime failed",
    ),
    retryable: false,
  };
}

function hostRunStopped(delivery: PiEventAdapterContext): WemailAgentEvent {
  return {
    schemaVersion: 1,
    conversationId: delivery.conversationId,
    runId: delivery.runId,
    ...(delivery.messageId ? { messageId: delivery.messageId } : {}),
    sequence: delivery.nextSequence(),
    timestamp: delivery.now(),
    type: "run_stopped",
    reason: "用户已停止",
  };
}

async function collectVersionedRuntimeEvents(input: {
  runtime: AgentRuntime;
  runInput: Parameters<AgentRuntime["run"]>[0];
  delivery: PiEventAdapterContext;
  eventPersistence?: AgentEventPersistence;
}): Promise<WemailAgentEvent[]> {
  const adapter = createPiV0806ToWemailEventAdapter();
  const events: WemailAgentEvent[] = [];
  try {
    for await (const rawEvent of input.runtime.run(input.runInput)) {
      const sanitized = sanitizeAgentEvent(rawEvent);
      const mapped = adapter.map(sanitized, input.delivery);
      for (const event of mapped) input.eventPersistence?.record(event);
      events.push(...mapped);
      if (rawEvent.type === "done") break;
    }
  } catch (error) {
    const terminal = input.runInput.signal?.aborted
      ? hostRunStopped(input.delivery)
      : hostRunFailure(input.delivery, error);
    input.eventPersistence?.record(terminal);
    events.push(terminal);
  }
  if (input.runInput.signal?.aborted && !hasTerminalRunEvent(events)) {
    const stopped = hostRunStopped(input.delivery);
    input.eventPersistence?.record(stopped);
    events.push(stopped);
  }
  return events;
}

function triggerTitleGeneration(
  titleGenerator: AgentTitleGenerator | undefined,
  conversationId: string,
): void {
  if (!titleGenerator) return;
  void titleGenerator.maybeGenerate(conversationId).catch(() => undefined);
}

function textFromConversationMessage(message: AgentMessageRecord): string {
  const body = message.body ?? {};
  if (typeof body.text === "string" && body.text.trim()) return body.text.trim();
  return "";
}

function buildRecentConversation(
  conversations: AgentConversationRepository | undefined,
  conversationId: string | undefined,
): Array<{ role: "user" | "assistant"; text: string; at: string }> {
  if (!conversations || !conversationId) return [];
  return conversations
    .listMessages(conversationId)
    .slice(-8)
    .map((message) => ({
      role: message.role,
      text: textFromConversationMessage(message).slice(0, 1200),
      at: message.createdAt,
    }))
    .filter((message) => message.text.length > 0);
}

function appendActionResolutionTrace(
  deps: AgentRoutesDeps,
  action: AgentPendingActionRow | undefined,
  status: "confirmed" | "rejected" | "expired" | "failed",
  execution?: AgentActionExecutionResult,
): void {
  if (!action?.conversation_id || !deps.conversations) return;
  const text =
    status === "confirmed" && execution
      ? formatExecutionTrace(execution)
      : status === "confirmed"
        ? `已完成：${action.description}`
        : status === "failed" && execution
          ? formatExecutionTrace(execution)
          : status === "failed"
            ? `执行失败：${action.description}`
      : status === "rejected"
        ? `已取消：${action.description}`
        : `已过期：${action.description}`;
  try {
    deps.conversations.addMessage({
      conversationId: action.conversation_id,
      role: "assistant",
      body: { text, actionResolution: { status, execution } },
    });
  } catch (error) {
    console.warn("[agent-action] failed to persist resolution trace", error);
  }
}

function appendActionConfirmationTrace(
  deps: AgentRoutesDeps,
  action: AgentPendingActionRow | undefined,
): void {
  if (!action?.conversation_id || !deps.conversations) return;
  try {
    deps.conversations.addMessage({
      conversationId: action.conversation_id,
      role: "assistant",
      body: {
        text: `已确认，开始执行：${action.description}`,
        actionResolution: { status: "confirmed" },
      },
    });
  } catch (error) {
    console.warn("[agent-action] failed to persist confirmation trace", error);
  }
}

function parsePendingActionInput(inputJson: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(inputJson);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function continuationFrom(action: AgentPendingActionRow): Record<string, unknown> | undefined {
  const input = parsePendingActionInput(action.input_json);
  const continuation = input.continuation;
  return continuation && typeof continuation === "object" && !Array.isArray(continuation)
    ? (continuation as Record<string, unknown>)
    : undefined;
}

function shouldRunContinuation(
  action: AgentPendingActionRow,
  execution: AgentActionExecutionResult,
): boolean {
  return !!continuationFrom(action) && execution.ok;
}

function compactExecutionForContinuation(execution: AgentActionExecutionResult) {
  const items = (execution.items ?? []).slice(0, 20).map((item) => ({
    ...(item.filename ? { filename: item.filename } : {}),
    ok: item.ok,
    ...(typeof item.exitCode === "number" ? { exitCode: item.exitCode } : {}),
    ...(item.error ? { error: traceValue(item.error, 400) } : {}),
    ...(item.command ? { command: traceValue(item.command, 800) } : {}),
    ...(item.stderr ? { stderr: traceValue(item.stderr, 800) } : {}),
  }));
  return {
    ok: execution.ok,
    summary: execution.summary,
    successCount: execution.successCount ?? 0,
    failureCount: execution.failureCount ?? 0,
    items,
  };
}

function traceValue(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}…`;
}

async function runActionContinuation(
  deps: AgentRoutesDeps,
  action: AgentPendingActionRow,
  execution: AgentActionExecutionResult,
  accountId?: string | null,
): Promise<void> {
  if (!deps.runtime || !deps.conversations || !action.conversation_id) return;
  const continuation = continuationFrom(action);
  if (!continuation) return;
  const input = parsePendingActionInput(action.input_json);
  const delivery = createDeliveryContext({ conversationId: action.conversation_id });
  if (deps.runs && delivery.messageId) {
    deps.runs.createRun({
      id: delivery.runId,
      conversationId: action.conversation_id,
      messageId: delivery.messageId,
      state: "running",
    });
  }
  const events = await collectVersionedRuntimeEvents({
    runtime: deps.runtime,
    delivery,
    eventPersistence: deps.eventPersistence,
    runInput: {
      userText: "继续完成已确认操作后的后续流程",
      sessionId: action.conversation_id,
      accountId: accountId ?? undefined,
      emailId: typeof action.email_id === "string" ? action.email_id : undefined,
      context: {
        continuationScenario: continuation.scenario,
        continuationGoal: continuation.nextGoal,
        confirmedAction: {
          actionType: action.action_type,
          description: action.description,
        },
        originalActionInput: {
          itemCount: Array.isArray(input.items) ? input.items.length : undefined,
          commandFamily:
            typeof input.commandFamily === "string" ? input.commandFamily : undefined,
        },
        executionSummary: compactExecutionForContinuation(execution),
        allowedNextSteps: [
          "read-only wecli_run",
          "wecli_help",
          "mail read tools",
          "create a new pending action when another mutation is needed",
        ],
        forbiddenNextSteps: [
          "directly execute a new mutation without an existing conversation command authorization",
        ],
      },
    },
  });
  if (delivery.messageId) {
    deps.eventPersistence?.flushMessage(action.conversation_id, delivery.messageId);
  }
  if (!deps.eventPersistence) {
    deps.conversations.addMessage({
      conversationId: action.conversation_id,
      role: "assistant",
      body: {
        text: finalWemailText(events),
        actionResolution: { status: "confirmed", execution, continuation },
      },
    });
  }
}

function hasCliFailureSignal(item: AgentActionExecutionItem): boolean {
  if (item.ok) return false;
  return Boolean(
    item.command?.trim() ||
      item.binary?.trim() ||
      item.resolvedBinary?.trim() ||
      item.args?.length ||
      item.errorCode?.trim() ||
      typeof item.exitCode === "number" ||
      item.stdout?.trim() ||
      item.stderr?.trim(),
  );
}

function cliFailureGuidance(items: AgentActionExecutionItem[]): string {
  const failed = items.filter(hasCliFailureSignal);
  const detail = failed
    .map((item) =>
      [
        item.error,
        item.errorCode,
        item.command,
        item.stdout,
        item.stderr,
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n")
    .toLowerCase();

  if (/not logged in|not login|log in|login|authenticate|auth|未登录|登录态|登录|认证/.test(detail)) {
    return "命令执行未完成：失败输出显示需要登录或认证。请先在浏览器完成对应站点登录，再重试失败项。";
  }
  if (/permission|forbidden|access denied|unauthorized|权限|无权|拒绝访问/.test(detail)) {
    return "命令执行未完成：失败输出显示权限或访问被拒绝。请确认账号权限后重试失败项。";
  }
  if (/network|timeout|timed out|econn|vpn|proxy|连接超时|网络|代理/.test(detail)) {
    return "命令执行未完成：失败输出显示网络连接异常。请确认网络或代理状态后重试失败项。";
  }
  if (/no such file|file not found|enoent|找不到文件|文件不存在|不存在/.test(detail)) {
    return "命令执行未完成：失败输出显示文件不可用。请确认附件已下载且文件路径有效后重试失败项。";
  }
  if (/unsupported|invalid file|file type|format|格式|不支持/.test(detail)) {
    return "命令执行未完成：失败输出显示文件类型或格式不被支持。请改用支持的附件后重试失败项。";
  }
  return "命令执行未完成：请检查失败项的具体原因，修正后重试；已完成项无需重复处理。";
}

function humanExecutionReason(value: string | undefined): string {
  if (!value) return "";
  const reason = sanitizeAgentDisplayText(value).replace(/[\r\n]+/g, " ").trim();
  if (!reason || /wecli|nonzero|exit[_ -]?code|^err[_-]/i.test(reason)) {
    return "";
  }
  return reason;
}

function formatExecutionTrace(execution: AgentActionExecutionResult): string {
  const lines = [sanitizeAgentDisplayText(execution.summary) || "操作已完成"];
  const items = execution.items ?? [];
  if (items.some(hasCliFailureSignal)) {
    lines.push(cliFailureGuidance(items));
  }
  for (const item of items) {
    const name = item.filename?.trim() || "附件";
    if (item.ok) {
      lines.push(`- ${name}：已完成`);
    } else {
      const reason = humanExecutionReason(item.error);
      lines.push(`- ${name}：失败${reason ? `（${reason}）` : ""}`);
    }
  }
  return lines.join("\n");
}

export function buildAgentRoutes(deps: AgentRoutesDeps = {}) {
  const app = new Hono();
  const drainingFollowups = new Set<string>();
  app.get("/action-executions/:actionId", async (c) => {
    const accountId = deps.getActiveAccountId?.();
    if (!accountId || !deps.actionExecutions?.available) return c.json({ ok: false, error: "action-execution-unavailable" }, 503);
    try {
      const task = await deps.actionExecutions.get(accountId, c.req.param("actionId"));
      return task ? c.json({ ok: true, task }) : c.json({ ok: false, error: "not-found" }, 404);
    } catch { return c.json({ ok: false, error: "action-status-unavailable" }, 503); }
  });
  app.get("/action-execution-events", (c) => {
    const accountId = deps.getActiveAccountId?.();
    if (!accountId || !deps.actionExecutions?.available) return c.json({ ok: false, error: "action-execution-unavailable" }, 503);
    return streamSSE(c, async (stream) => {
      let end: (() => void) | undefined;
      const closed = new Promise<void>((resolve) => { end = resolve; });
      const unsubscribe = deps.actionExecutions!.subscribe((task) => {
        if (task.accountId !== accountId || deps.getActiveAccountId?.() !== accountId) return;
        void stream.writeSSE({ event: "action-changed", data: JSON.stringify({ actionId: task.actionId, revision: task.revision, state: task.state }) }).catch(() => end?.());
      });
      stream.onAbort(() => end?.());
      const heartbeat = setInterval(() => {
        void stream.writeSSE({ event: "ping", data: "{}" }).catch(() => end?.());
      }, 15_000);
      try {
        await stream.writeSSE({ event: "ready", data: "{}" });
        await closed;
      } finally { clearInterval(heartbeat); unsubscribe(); }
    });
  });

  const drainFollowups = async (
    conversationId: string,
    accountId?: string,
  ): Promise<void> => {
    if (
      drainingFollowups.has(conversationId)
      || !deps.runs
      || !deps.runtime
      || !deps.conversations
    ) return;
    drainingFollowups.add(conversationId);
    try {
      while (true) {
        const followup = deps.runs.nextQueuedFollowup(conversationId);
        if (!followup) break;
        deps.runs.setFollowupState(followup.id, "running");
        deps.conversations.addMessage({
          conversationId,
          role: "user",
          body: {
            text: followup.text,
            followupId: followup.id,
            attachmentIds: followup.attachmentIds,
          },
        });
        const delivery = createDeliveryContext({ conversationId });
        if (delivery.messageId) {
          deps.runs.createRun({
            id: delivery.runId,
            conversationId,
            messageId: delivery.messageId,
            state: "queued",
          });
        }
        const lease = await deps.runCoordinator?.acquire({
          conversationId,
          runId: delivery.runId,
        });
        let events: WemailAgentEvent[] = [];
        try {
          events = await collectVersionedRuntimeEvents({
            runtime: deps.runtime,
            delivery,
            eventPersistence: deps.eventPersistence,
            runInput: {
              userText: followup.text,
              sessionId: conversationId,
              accountId,
              context: {
                followupId: followup.id,
                attachmentIds: followup.attachmentIds,
                recentConversation: buildRecentConversation(
                  deps.conversations,
                  conversationId,
                ),
              },
              signal: lease?.signal,
            },
          });
        } finally {
          lease?.release();
          if (delivery.messageId) {
            deps.eventPersistence?.flushMessage(conversationId, delivery.messageId);
          }
        }
        const settled = events.some((event) => event.type === "run_settled");
        if (!settled) {
          deps.runs.setFollowupState(followup.id, "paused", "manual");
          break;
        }
        deps.runs.setFollowupState(followup.id, "completed");
      }
    } catch {
      deps.runs.pauseFollowups(conversationId, "manual");
    } finally {
      drainingFollowups.delete(conversationId);
    }
  };

  deps.actionExecutions?.subscribe((task) => {
    if (task.state !== "succeeded" || task.accountId !== deps.getActiveAccountId?.()) return;
    try {
      const followup = deps.runs?.getFollowup(`action-followup:${task.id}`);
      if (followup?.state === "queued") void drainFollowups(followup.conversationId, task.accountId);
    } catch {
      // The durable followup remains available through the existing resume flow.
    }
  });

  app.get("/suggestions", async (c) => {
    const accountId = c.req.query("accountId");
    if (!accountId) {
      return c.json({ ok: false, error: "accountId is required" }, 400);
    }
    if (deps.getActiveAccountId && deps.getActiveAccountId() !== accountId) {
      return c.json({ ok: false, error: "cross-account-suggestions" }, 403);
    }
    const emailId = c.req.query("emailId");
    if (!emailId && deps.homeSuggestions) {
      return c.json({
        ok: true,
        ...await deps.homeSuggestions.getSuggestions({
          accountId,
          timezone: c.req.query("timezone") ?? "UTC",
        }),
      });
    }

    if (!emailId) {
      if (!deps.getHomeActionSuggestions) {
        return c.json({
          ok: true,
          suggestions: [],
          source: "rules",
          candidateFingerprint: "",
          refreshPending: false,
        });
      }
      try {
        const result = await deps.getHomeActionSuggestions(accountId);
        return c.json({ ok: true, ...result });
      } catch {
        return c.json({
          ok: true,
          suggestions: [],
          source: "rules",
          candidateFingerprint: "",
          refreshPending: false,
        });
      }
    }

    if (deps.mailDatabase) {
      const [intelligenceState, snapshot] = await Promise.all([
        deps.mailDatabase.getIntelligenceState(emailId),
        deps.mailDatabase.getMailSnapshot(emailId),
      ]);
      const mail = snapshot.message;
      const envelope = mail ? {
        id: mail.id,
        subject: mail.subject,
        from: mail.from.name
          ? `${mail.from.name} <${mail.from.email}>`
          : mail.from.email,
        snippet: mail.snippet,
        folder: mail.folder,
        attachments: mail.attachments.map((attachment) => ({
          id: attachment.id,
          filename: attachment.filename,
          mimetype: attachment.mimetype,
        })),
      } : null;
      const stateAwareSuggestions = buildSuggestions({
        intelligenceState,
        envelope,
        hasEmailContext: true,
        emailId,
        accountId,
      });
      // Convert AgentSuggestionItem[] to AgentSuggestion[] for backward compat
      const suggestions: AgentSuggestion[] = stateAwareSuggestions.map((s) => ({
        id: s.id,
        label: s.label,
        prompt: s.prompt,
        ...(s.action ? { action: s.action } : {}),
      }));
      // Focused-email fallback is owned by SuggestionBuilder so it stays
      // contextual instead of returning a fixed three-chip list.
      if (suggestions.length === 0) {
        return c.json({
          ok: true,
          suggestions: [],
        });
      }
      return c.json({
        ok: true,
        suggestions,
      });
    }

    // The minimal harness has no database client, so expose context-free actions.
    const suggestions: AgentSuggestion[] = [
          {
            id: "summarize-email",
            label: "总结",
            prompt: "总结这封邮件，列出重点和风险。",
          },
          {
            id: "draft-reply",
            label: "起草回复",
            prompt: "基于这封邮件帮我起草一封简洁回复，等待我确认后再发送。",
          },
          {
            id: "extract-todos",
            label: "提取待办",
            prompt: "从这封邮件中提取需要跟进的待办事项。",
          },
        ];
    return c.json({ ok: true, suggestions });
  });

  app.get("/tools", (c) => {
    if (!deps.runtime) {
      return c.json({ ok: false, error: "agent runtime not wired" }, 503);
    }
    return c.json({ ok: true, tools: deps.runtime.listTools() });
  });

  app.post("/chat", async (c) => {
    if (!deps.runtime) {
      return c.json({ ok: false, error: "agent runtime not wired" }, 503);
    }
    let body: {
      userText?: unknown;
      sessionId?: unknown;
      context?: unknown;
      emailId?: unknown;
      accountId?: unknown;
      threadId?: unknown;
      attachedMail?: unknown;
      attachedMails?: unknown;
      messageContext?: unknown;
      persist?: unknown;
    };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ ok: false, error: "invalid JSON body" }, 400);
    }
    if (typeof body.userText !== "string" || body.userText.trim().length === 0) {
      return c.json({ ok: false, error: "missing `userText` string" }, 400);
    }
    const sessionId =
      typeof body.sessionId === "string" ? body.sessionId : undefined;
    const context =
      body.context && typeof body.context === "object"
        ? (body.context as Record<string, unknown>)
        : undefined;
    const emailId =
      typeof body.emailId === "string" ? body.emailId : undefined;
    const accountId =
      typeof body.accountId === "string" ? body.accountId : undefined;
    const threadId =
      typeof body.threadId === "string" ? body.threadId : undefined;
    const attachedMail = parseAttachedMail(body.attachedMail);
    const attachedMails = parseAttachedMails(body.attachedMails);
    const attachedEmailIds = (attachedMails ?? [])
      .map((mail) => mail.emailId)
      .filter((id): id is string => !!id);
    const messageContext = normalizeAgentMessageContext(body.messageContext);
    const shouldPersist = body.persist !== false;
    const conversation = shouldPersist
      ? deps.conversations?.ensureConversation({
          id: sessionId,
          accountId: accountId ?? (typeof context?.accountId === "string" ? context.accountId : undefined),
          // Leave title NULL on the first turn so the title generator can
          // overwrite it later. We deliberately do NOT seed an 80-char
          // user-message slice here.
        })
      : undefined;
    const effectiveSessionId = sessionId ?? conversation?.id;
    const isNewConversation =
      !!conversation && (conversation.title ?? null) === null;
    const recentConversation = buildRecentConversation(
      deps.conversations,
      conversation?.id ?? sessionId,
    );
    const runContext: Record<string, unknown> = {
      ...(context ?? {}),
      ...(recentConversation.length > 0 ? { recentConversation } : {}),
    };
    if (conversation) {
      deps.conversations?.addMessage({
        conversationId: conversation.id,
        role: "user",
        body: {
          text: body.userText,
          context: runContext,
          emailId,
          accountId,
          threadId,
          ...(attachedMail ? { attachedMail } : {}),
          ...(attachedMails ? { attachedMails } : {}),
          ...(messageContext ? { messageContext } : {}),
        },
      });
    }

    const runtime = deps.runtime;
    const delivery = createDeliveryContext({
      conversationId: effectiveSessionId ?? `ephemeral-conversation-${randomUUID()}`,
    });
    const willWait = !!(
      deps.runCoordinator
      && (deps.runCoordinator.activeCount() >= 2
        || deps.runCoordinator.isConversationActive(delivery.conversationId))
    );
    if (conversation && deps.runs && delivery.messageId) {
      deps.runs.createRun({
        id: delivery.runId,
        conversationId: conversation.id,
        messageId: delivery.messageId,
        state: willWait ? "queued" : "running",
      });
    }
    const acquireLease = () => deps.runCoordinator?.acquire({
      conversationId: delivery.conversationId,
      runId: delivery.runId,
      signal: c.req.raw.signal,
    });
    const accept = c.req.header("accept") ?? "";
    if (accept.includes("text/event-stream")) {
      return streamSSE(c, async (stream) => {
        const streamAbort = new AbortController();
        stream.onAbort(() => {
          streamAbort.abort();
          deps.runCoordinator?.stop(delivery.conversationId);
        });
        const adapter = createPiV0806ToWemailEventAdapter();
        const sseEvents: WemailAgentEvent[] = [];
        if (willWait) {
          const queued: WemailAgentEvent = {
            schemaVersion: 1,
            conversationId: delivery.conversationId,
            runId: delivery.runId,
            ...(delivery.messageId ? { messageId: delivery.messageId } : {}),
            sequence: delivery.nextSequence(),
            timestamp: delivery.now(),
            type: "run_state_changed",
            state: "queued",
          };
          deps.eventPersistence?.record(queued);
          sseEvents.push(queued);
          await stream.writeSSE({ event: queued.type, data: JSON.stringify(queued) });
        }
        const lease = await acquireLease();
        const signal = AbortSignal.any([
          c.req.raw.signal,
          streamAbort.signal,
          ...(lease ? [lease.signal] : []),
        ]);
        try {
          for await (const rawEvent of runtime.run({
            userText: body.userText as string,
            sessionId: effectiveSessionId,
            context: runContext,
            emailId,
            accountId,
            threadId,
            ...(attachedEmailIds.length > 0 ? { emailIds: attachedEmailIds } : {}),
            signal,
          })) {
            const sanitized = sanitizeAgentEvent(rawEvent);
            const mappedEvents = adapter.map(sanitized, delivery);
            for (const event of mappedEvents) {
              deps.eventPersistence?.record(event);
              sseEvents.push(event);
              await stream.writeSSE({
                event: event.type,
                data: JSON.stringify(event),
              });
            }
            if (rawEvent.type === "done") break;
          }
        } catch (error) {
          const terminal = signal.aborted
            ? hostRunStopped(delivery)
            : hostRunFailure(delivery, error);
          deps.eventPersistence?.record(terminal);
          sseEvents.push(terminal);
          if (!streamAbort.signal.aborted) {
            await stream.writeSSE({
              event: terminal.type,
              data: JSON.stringify(terminal),
            });
          }
        } finally {
          if (signal.aborted && !hasTerminalRunEvent(sseEvents)) {
            const stopped = hostRunStopped(delivery);
            deps.eventPersistence?.record(stopped);
            sseEvents.push(stopped);
          }
          lease?.release();
          if (delivery.messageId) {
            deps.eventPersistence?.flushMessage(
              delivery.conversationId,
              delivery.messageId,
            );
          }
        }
        if (conversation) {
          if (!deps.eventPersistence) {
            deps.conversations?.addMessage({
              conversationId: conversation.id,
              role: "assistant",
              body: { text: finalWemailText(sseEvents) },
            });
          }
          if (isNewConversation && deps.titleGenerator) {
            triggerTitleGeneration(deps.titleGenerator, conversation.id);
          }
          if (sseEvents.some((event) => event.type === "run_settled")) {
            void drainFollowups(conversation.id, accountId);
          }
        }
      });
    }

    // Non-streaming fallback: collect and return.
    const queuedEvents: WemailAgentEvent[] = [];
    if (willWait) {
      const queued: WemailAgentEvent = {
        schemaVersion: 1,
        conversationId: delivery.conversationId,
        runId: delivery.runId,
        ...(delivery.messageId ? { messageId: delivery.messageId } : {}),
        sequence: delivery.nextSequence(),
        timestamp: delivery.now(),
        type: "run_state_changed",
        state: "queued",
      };
      deps.eventPersistence?.record(queued);
      queuedEvents.push(queued);
    }
    const lease = await acquireLease();
    let events: WemailAgentEvent[];
    try {
      events = [
        ...queuedEvents,
        ...await collectVersionedRuntimeEvents({
          runtime,
          delivery,
          eventPersistence: deps.eventPersistence,
          runInput: {
            userText: body.userText,
            sessionId: effectiveSessionId,
            context: runContext,
            emailId,
            accountId,
            threadId,
            ...(attachedEmailIds.length > 0 ? { emailIds: attachedEmailIds } : {}),
            signal: lease?.signal ?? c.req.raw.signal,
          },
        }),
      ];
    } finally {
      lease?.release();
      if (delivery.messageId) {
        deps.eventPersistence?.flushMessage(delivery.conversationId, delivery.messageId);
      }
    }
    if (conversation) {
      if (!deps.eventPersistence) {
        deps.conversations?.addMessage({
          conversationId: conversation.id,
          role: "assistant",
          body: { text: finalWemailText(events) },
      });
    }
    const learningAccountId = accountId ??
      (typeof context?.accountId === "string" ? context.accountId : undefined);
    if (learningAccountId) {
      deps.learning?.record({
        accountId: learningAccountId,
        type: "user_input",
        payload: {
          text: body.userText,
          ...(emailId ? { emailId } : {}),
          hasAttachments: Array.isArray((body as { attachmentIds?: unknown }).attachmentIds),
        },
        conversationId: effectiveSessionId,
      });
    }
      if (isNewConversation && deps.titleGenerator) {
        triggerTitleGeneration(deps.titleGenerator, conversation.id);
      }
      if (events.some((event) => event.type === "run_settled")) {
        void drainFollowups(conversation.id, accountId);
      }
    }
    return c.json({ ok: true, conversationId: conversation?.id, events });
  });

  app.get("/conversations", (c) => {
    if (!deps.conversations) return c.json({ ok: true, conversations: [] });
    const includeArchivedRaw = c.req.query("includeArchived");
    const includeArchived =
      includeArchivedRaw === "1" || includeArchivedRaw === "true";
    const search = c.req.query("search");
    const accountId = c.req.query("accountId");
    return c.json({
      ok: true,
      conversations: deps.conversations.list({
        includeArchived,
        search: typeof search === "string" && search.length > 0 ? search : undefined,
        accountId:
          typeof accountId === "string" && accountId.length > 0 ? accountId : undefined,
      }),
    });
  });

  app.get("/conversations/:id/state", (c) => {
    const conversationId = c.req.param("id");
    if (!deps.runs) return c.json({ ok: true, state: null });
    const state = deps.runs.loadConversationState(conversationId);
    for (const row of deps.pendingActions?.getConversationHistory(conversationId) ?? []) {
      const action = rowToAction(row);
      state.confirmations[action.id] = {
        id: action.id,
        actionType: action.actionType,
        description: action.description,
        riskLevel: action.riskLevel,
        parameters: JSON.parse(JSON.stringify(action.parameters ?? {})) as Record<string, AgentJsonValue>,
        expiresAt: action.expiresAt ?? row.created_at,
        idempotencyKey: action.idempotencyKey ?? `agent-action:${action.id}`,
        status:
          action.executionState === "failed" || action.executionState === "outcome_unknown"
            ? "failed"
            : action.status ?? "pending",
      };
    }
    return c.json({ ok: true, state });
  });

  app.get("/attention", (c) => {
    const accountId = deps.getActiveAccountId?.();
    if (!deps.runs) return c.json({ ok: true, active: [], failed: [], pausedConversationIds: [] });
    if (!accountId) return c.json({ ok: false, error: "no-active-account" }, 401);
    const failureSince = new Date(Date.now() - 60 * 60_000).toISOString();
    return c.json({ ok: true, ...deps.runs.listAttention(accountId, failureSince) });
  });

  app.get("/conversations/:id/followups", (c) => {
    if (!deps.runs) return c.json({ ok: true, followups: [] });
    return c.json({
      ok: true,
      followups: deps.runs.listFollowups(c.req.param("id")),
    });
  });

  app.post("/conversations/:id/followups", async (c) => {
    if (!deps.runs || !deps.conversations) {
      return c.json({ ok: false, error: "run persistence not wired" }, 503);
    }
    const conversationId = c.req.param("id");
    if (!deps.conversations.get(conversationId)) {
      return c.json({ ok: false, error: "not_found" }, 404);
    }
    let body: { text?: unknown; attachmentIds?: unknown; accountId?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ ok: false, error: "invalid JSON body" }, 400);
    }
    if (typeof body.text !== "string" || !body.text.trim()) {
      return c.json({ ok: false, error: "missing `text` string" }, 400);
    }
    const attachmentIds = Array.isArray(body.attachmentIds)
      ? body.attachmentIds.filter((value): value is string => typeof value === "string")
      : [];
    const followup = deps.runs.enqueueFollowup({
      conversationId,
      text: body.text.trim(),
      attachmentIds,
    });
    if (!deps.runCoordinator?.isConversationActive(conversationId)) {
      void drainFollowups(
        conversationId,
        typeof body.accountId === "string" ? body.accountId : undefined,
      );
    }
    return c.json({ ok: true, followup }, 202);
  });

  app.post("/conversations/:id/followups/resume", async (c) => {
    if (!deps.runs || !deps.conversations) {
      return c.json({ ok: false, error: "run persistence not wired" }, 503);
    }
    const conversationId = c.req.param("id");
    if (!deps.conversations.get(conversationId)) {
      return c.json({ ok: false, error: "not_found" }, 404);
    }
    const resumed = deps.runs.resumeFollowups(conversationId);
    void drainFollowups(conversationId, deps.getActiveAccountId?.());
    return c.json({ ok: true, resumed });
  });

  app.delete("/conversations/:conversationId/followups/:id", (c) => {
    if (!deps.runs) {
      return c.json({ ok: false, error: "run persistence not wired" }, 503);
    }
    const followup = deps.runs.getFollowup(c.req.param("id"));
    if (!followup || followup.conversationId !== c.req.param("conversationId")) {
      return c.json({ ok: false, error: "not_found" }, 404);
    }
    deps.runs.setFollowupState(followup.id, "removed");
    return c.json({ ok: true });
  });

  app.patch("/conversations/:conversationId/followups/:id", async (c) => {
    if (!deps.runs) {
      return c.json({ ok: false, error: "run persistence not wired" }, 503);
    }
    const conversationId = c.req.param("conversationId");
    const id = c.req.param("id");
    const existing = deps.runs.getFollowup(id);
    if (!existing || existing.conversationId !== conversationId) {
      return c.json({ ok: false, error: "not_found" }, 404);
    }
    let body: { text?: unknown; position?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ ok: false, error: "invalid JSON body" }, 400);
    }
    if (body.text !== undefined) {
      if (typeof body.text !== "string" || !body.text.trim()) {
        return c.json({ ok: false, error: "`text` must not be empty" }, 400);
      }
      const followup = deps.runs.updateFollowupText(id, body.text);
      if (!followup) return c.json({ ok: false, error: "not_editable" }, 409);
      return c.json({ ok: true, followup });
    }
    if (body.position !== undefined) {
      if (typeof body.position !== "number" || !Number.isFinite(body.position)) {
        return c.json({ ok: false, error: "`position` must be a number" }, 400);
      }
      const followups = deps.runs.moveFollowup(id, body.position);
      if (!followups) return c.json({ ok: false, error: "not_reorderable" }, 409);
      return c.json({ ok: true, followups });
    }
    return c.json({ ok: false, error: "missing `text` or `position`" }, 400);
  });

  app.patch("/conversations/:id", async (c) => {
    if (!deps.conversations) {
      return c.json({ ok: false, error: "conversations not wired" }, 503);
    }
    let body: { title?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ ok: false, error: "invalid JSON body" }, 400);
    }
    if (typeof body.title !== "string") {
      return c.json({ ok: false, error: "`title` must be a string" }, 400);
    }
    const trimmed = body.title.trim();
    if (trimmed.length === 0) {
      return c.json({ ok: false, error: "`title` must not be empty" }, 400);
    }
    if (trimmed.length > MAX_TITLE_LEN) {
      return c.json(
        { ok: false, error: `\`title\` exceeds ${MAX_TITLE_LEN} chars` },
        400,
      );
    }
    const id = c.req.param("id");
    const updated = deps.conversations.setTitle(id, trimmed);
    if (!updated) {
      return c.json({ ok: false, error: "not_found" }, 404);
    }
    const conversation = deps.conversations.get(id);
    return c.json({ ok: true, conversation });
  });

  app.post("/conversations/:id/archive", (c) => {
    if (!deps.conversations) {
      return c.json({ ok: false, error: "conversations not wired" }, 503);
    }
    const id = c.req.param("id");
    if (!deps.conversations.get(id)) {
      return c.json({ ok: false, error: "not_found" }, 404);
    }
    deps.conversations.archive(id);
    return c.json({ ok: true });
  });

  app.post("/conversations/:id/unarchive", (c) => {
    if (!deps.conversations) {
      return c.json({ ok: false, error: "conversations not wired" }, 503);
    }
    const id = c.req.param("id");
    if (!deps.conversations.get(id)) {
      return c.json({ ok: false, error: "not_found" }, 404);
    }
    deps.conversations.unarchive(id);
    return c.json({ ok: true });
  });

  app.post("/conversations/:id/pin", (c) => {
    if (!deps.conversations) {
      return c.json({ ok: false, error: "conversations not wired" }, 503);
    }
    const id = c.req.param("id");
    if (!deps.conversations.get(id)) {
      return c.json({ ok: false, error: "not_found" }, 404);
    }
    deps.conversations.pin(id);
    return c.json({ ok: true });
  });

  app.post("/conversations/:id/unpin", (c) => {
    if (!deps.conversations) {
      return c.json({ ok: false, error: "conversations not wired" }, 503);
    }
    const id = c.req.param("id");
    if (!deps.conversations.get(id)) {
      return c.json({ ok: false, error: "not_found" }, 404);
    }
    deps.conversations.unpin(id);
    return c.json({ ok: true });
  });

  app.delete("/conversations", (c) => {
    deps.conversations?.clear();
    return c.json({ ok: true });
  });

  // ── Pending action endpoints ────────────────────────────────────

  app.get("/pending-actions", async (c) => {
    if (deps.mailDatabase?.listPendingActions && deps.getActiveAccountId) {
      const accountId = deps.getActiveAccountId();
      if (!accountId) return c.json({ ok: true, actions: [] });
      const params = MailDatabasePendingActionsParamsSchema.safeParse({
        accountId,
        conversationId: c.req.query("conversationId") || undefined,
      });
      if (!params.success) return c.json({ ok: false, error: "待确认操作查询参数无效" }, 400);
      try {
        const actions = await deps.mailDatabase.listPendingActions(params.data);
        return c.json({ ok: true, actions });
      } catch {
        return c.json({ ok: false, error: "待确认操作暂时无法加载，请稍后重试" }, 503);
      }
    }
    if (!deps.pendingActions) {
      return c.json({ ok: true, actions: [] });
    }
    const conversationId = c.req.query("conversationId");
    let rows;
    if (conversationId) {
      const activeAccountId = deps.getActiveAccountId?.();
      if (deps.getActiveAccountId) {
        const ownerAccountId =
          deps.pendingActions.getAccountIdForConversation(conversationId);
        if (!activeAccountId || ownerAccountId !== activeAccountId) {
          return c.json({ ok: true, actions: [] });
        }
      }
      rows = deps.pendingActions.getConversationHistory(conversationId);
    } else {
      const activeAccountId = deps.getActiveAccountId?.();
      if (activeAccountId) {
        rows = deps.pendingActions.getPendingByAccount(activeAccountId);
      } else if (deps.getActiveAccountId) {
        // Resolver is wired but no active account — defensive empty
        // payload rather than leaking other accounts' rows.
        return c.json({ ok: true, actions: [] });
      } else {
        // No active-account resolver wired (legacy/test paths). Fall
        // back to the un-scoped list so existing callers keep working.
        rows = deps.pendingActions.getPending();
      }
    }
    // Map raw rows to the public `AgentPendingAction` shape so the
    // renderer gets camelCase fields and an always-populated
    // `riskLevel` (legacy rows fall back to a derivation from
    // `actionType`).
    const actions = rows.map(rowToAction);
    return c.json({ ok: true, actions });
  });

  app.post("/pending-actions/:id/resolve", async (c) => {
    if (!deps.pendingActions) {
      return c.json({ ok: false, error: "pending actions not wired" }, 503);
    }
    const id = c.req.param("id");
    let body: { status?: unknown; idempotencyKey?: unknown; parameters?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ ok: false, error: "invalid JSON body" }, 400);
    }
    const status = body.status;
    if (status !== "confirmed" && status !== "rejected" && status !== "expired") {
      return c.json({ ok: false, error: "status must be 'confirmed', 'rejected', or 'expired'" }, 400);
    }
    const existing = deps.pendingActions.getById(id);
    if (!existing) {
      return c.json({ ok: false, error: "not_found" }, 404);
    }
    if (existing.action_type !== "upload_allowance_invoices" || existing.mcp_operation_id) deps.pendingActions.expireStale();
    if (status !== "confirmed" && existing.execution_state === "executing") {
      return c.json({ ok: false, error: "action-already-accepted" }, 409);
    }
    // Cross-account guard: when an active-account resolver is wired and
    // the action's owning conversation belongs to a different account,
    // refuse the resolve so account A can't confirm/reject account B's
    // pending action by guessing its id.
    const activeAccountId = deps.getActiveAccountId?.();
    const ownerAccountId = deps.pendingActions.getAccountIdFor(id);
    if (deps.getActiveAccountId) {
      if (!activeAccountId || !ownerAccountId || ownerAccountId !== activeAccountId) {
        return c.json(
          { ok: false, error: "cross-account-action" },
          403,
        );
      }
    }
    if (existing.status !== "pending" && status !== "confirmed") {
      return c.json({ ok: false, error: "action-not-pending" }, 409);
    }
    if (status === "confirmed") {
      if (existing.mcp_operation_id && (!deps.mcpOperations || !ownerAccountId)) {
        return c.json({ ok: false, error: "mcp-operation-approval-not-wired" }, 503);
      }
      if (!existing.mcp_operation_id && existing.action_type !== "upload_allowance_invoices" && !deps.actionExecutor) {
        return c.json({ ok: false, error: "action-execution-not-wired" }, 501);
      }
      if (typeof body.idempotencyKey !== "string") {
        return c.json({ ok: false, error: "idempotencyKey is required" }, 400);
      }
      if (!body.parameters || typeof body.parameters !== "object" || Array.isArray(body.parameters)) {
        return c.json({ ok: false, error: "parameters are required" }, 400);
      }
      if (!existing.mcp_operation_id && existing.action_type === "upload_allowance_invoices") {
        if (!deps.actionExecutions?.available || !activeAccountId) {
          return c.json({ ok: false, error: "durable-action-execution-unavailable" }, 503);
        }
        const parsed = ActionExecutionCommandSchema.safeParse({ op: "accept", accountId: activeAccountId,
          actionId: id, idempotencyKey: body.idempotencyKey, parameters: body.parameters });
        if (!parsed.success || parsed.data.op !== "accept") return c.json({ ok: false, error: "invalid-confirmation" }, 400);
        try {
          const { op: _op, ...input } = parsed.data;
          const task = await deps.actionExecutions.accept(input);
          return c.json({ ok: true, accepted: true, task }, 202);
        } catch (error) {
          const message = error instanceof Error ? error.message : "confirmation-failed";
          const rejected = /^action-(?:expired|parameter_mismatch|parameter-mismatch|idempotency_mismatch|not_pending|duplicate|not-owned|upload-list-stale)$/.test(message);
          return c.json({ ok: false, error: rejected ? message : "confirmation-status-unknown",
            detail: message === "action-upload-list-stale" ? "这些附件已有任务正在处理，请查看原任务进度，无需重复提交。"
              : rejected ? "确认未被接受，请刷新确认清单。" : "暂时无法确认提交结果，请查询原任务状态，不要重新上传。" }, rejected ? 409 : 503);
        }
      }
      const reservation = deps.pendingActions.reserveExecution({
        id,
        idempotencyKey: body.idempotencyKey,
        parameters: body.parameters as Record<string, unknown>,
      });
      if (reservation.kind === "duplicate") {
        if (reservation.row.execution_state === "executing") {
          return c.json({ ok: false, error: "action-execution-in-progress" }, 409);
        }
        let execution: Record<string, unknown> | undefined;
        try {
          execution = reservation.row.execution_result_json
            ? JSON.parse(reservation.row.execution_result_json) as Record<string, unknown>
            : undefined;
        } catch {
          execution = undefined;
        }
        return c.json({ ok: reservation.row.execution_state === "succeeded", duplicate: true, execution });
      }
      if (reservation.kind !== "reserved") {
        const code = reservation.kind === "expired" ? 409 : reservation.kind === "not_found" ? 404 : 400;
        return c.json({ ok: false, error: reservation.kind }, code);
      }
      if (ownerAccountId ?? activeAccountId) {
        deps.learning?.record({
          accountId: (ownerAccountId ?? activeAccountId)!,
          type: "user_confirmed",
          payload: { actionId: id, actionType: existing.action_type },
          conversationId: existing.conversation_id ?? undefined,
        });
      }
      if (existing.mcp_operation_id) {
        if (!deps.mcpOperations || !ownerAccountId) throw new Error("unreachable-mcp-guard");
        const operation = deps.mcpOperations.getOwned(
          existing.mcp_operation_id,
          ownerAccountId,
        );
        if (!operation) {
          return c.json({ ok: false, error: "operation-not-found" }, 404);
        }
        try {
          const approved = deps.mcpOperations.approve({
            id: operation.id,
            accountId: ownerAccountId,
            payloadHash: operation.payloadHash,
            approvalEventId: randomUUID(),
          });
          deps.pendingActions.completeExecution(id, "succeeded", {
            operationId: approved.id,
            state: approved.state,
            executed: false,
          });
          appendActionConfirmationTrace(deps, existing);
          appendActionResolutionTrace(deps, existing, "confirmed");
          return c.json({
            ok: true,
            approval: {
              operationId: approved.id,
              state: approved.state,
              executed: false,
            },
          });
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          deps.pendingActions.completeExecution(id, "failed", { ok: false, error: detail });
          return c.json({ ok: false, error: detail }, detail === "operation-expired" ? 409 : 400);
        }
      }
      if (!deps.actionExecutor) throw new Error("unreachable-action-executor-guard");
      appendActionConfirmationTrace(deps, existing);
      let execution: AgentActionExecutionResult;
      try {
        execution = await deps.actionExecutor.execute(existing, {
          accountId: ownerAccountId ?? activeAccountId,
        });
      } catch (err) {
        const execution: AgentActionExecutionResult = {
          ok: false,
          summary: `执行失败：${existing.description}`,
          failureCount: 1,
          items: [
            {
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            },
          ],
        };
        deps.pendingActions.completeExecution(id, "failed", { ...execution });
        appendActionResolutionTrace(deps, existing, "failed", execution);
        if (ownerAccountId ?? activeAccountId) {
          deps.learning?.record({
            accountId: (ownerAccountId ?? activeAccountId)!,
            type: "mail_action",
            payload: { actionType: existing.action_type, ok: false },
            conversationId: existing.conversation_id ?? undefined,
          });
        }
        return c.json(
          {
            ok: false,
            error: "action-execution-failed",
            detail: err instanceof Error ? err.message : String(err),
            execution,
          },
          500,
        );
      }
      if (!execution.ok) {
        deps.pendingActions.completeExecution(id, "failed", { ...execution });
        appendActionResolutionTrace(deps, existing, "failed", execution);
        if (ownerAccountId ?? activeAccountId) {
          deps.learning?.record({
            accountId: (ownerAccountId ?? activeAccountId)!,
            type: "mail_action",
            payload: { actionType: existing.action_type, ok: false },
            conversationId: existing.conversation_id ?? undefined,
          });
        }
        if (shouldRunContinuation(existing, execution)) {
          await runActionContinuation(
            deps,
            existing,
            execution,
            ownerAccountId ?? activeAccountId,
          );
        }
        return c.json(
          {
            ok: false,
            error: "action-execution-failed",
            execution,
          },
          500,
        );
      }
      deps.pendingActions.completeExecution(id, "succeeded", { ...execution });
      if (ownerAccountId ?? activeAccountId) {
        deps.learning?.record({
          accountId: (ownerAccountId ?? activeAccountId)!,
          type: "mail_action",
          payload: { actionType: existing.action_type, ok: true },
          conversationId: existing.conversation_id ?? undefined,
        });
      }
      appendActionResolutionTrace(deps, existing, status, execution);
      if (shouldRunContinuation(existing, execution)) {
        await runActionContinuation(
          deps,
          existing,
          execution,
          ownerAccountId ?? activeAccountId,
        );
      }
      return c.json({ ok: true, execution });
    }
    if (existing.mcp_operation_id && deps.mcpOperations && ownerAccountId) {
      const operation = deps.mcpOperations.getOwned(existing.mcp_operation_id, ownerAccountId);
      if (operation && status !== "expired") {
        try {
          deps.mcpOperations.cancel(operation.id, ownerAccountId);
        } catch {
          // The pending action still resolves even if the operation was already terminal.
        }
      } else if (operation && status === "expired") {
        deps.mcpOperations.transition(operation.id, "expired");
      }
    }
    deps.pendingActions.resolve(id, status);
    if ((ownerAccountId ?? activeAccountId) && status === "rejected") {
      deps.learning?.record({
        accountId: (ownerAccountId ?? activeAccountId)!,
        type: "user_rejected",
        payload: { actionId: id, actionType: existing.action_type },
        conversationId: existing.conversation_id ?? undefined,
      });
    }
    appendActionResolutionTrace(deps, existing, status);
    return c.json({ ok: true });
  });

  app.get("/learning/preferences", (c) => {
    const accountId = deps.getActiveAccountId?.();
    if (!deps.learning) return c.json({ ok: false, error: "learning-not-wired" }, 503);
    if (!accountId) return c.json({ ok: false, error: "no-active-account" }, 401);
    return c.json({ ok: true, preferences: deps.learning.listPreferences(accountId) });
  });

  app.patch("/learning/preferences/:key", async (c) => {
    const accountId = deps.getActiveAccountId?.();
    if (!deps.learning) return c.json({ ok: false, error: "learning-not-wired" }, 503);
    if (!accountId) return c.json({ ok: false, error: "no-active-account" }, 401);
    let body: { value?: unknown };
    try { body = await c.req.json(); } catch { return c.json({ ok: false, error: "invalid-json" }, 400); }
    if (body.value === undefined) return c.json({ ok: false, error: "value-required" }, 400);
    const preference = deps.learning.correctPreference(
      accountId,
      decodeURIComponent(c.req.param("key")),
      body.value as import("../../../shared/wemail/agentProtocol.js").AgentJsonValue,
    );
    return c.json({ ok: true, preference });
  });

  app.delete("/learning/preferences/:key", (c) => {
    const accountId = deps.getActiveAccountId?.();
    if (!deps.learning) return c.json({ ok: false, error: "learning-not-wired" }, 503);
    if (!accountId) return c.json({ ok: false, error: "no-active-account" }, 401);
    return c.json({
      ok: true,
      deleted: deps.learning.deletePreference(accountId, decodeURIComponent(c.req.param("key"))),
    });
  });

  app.delete("/learning", (c) => {
    const accountId = deps.getActiveAccountId?.();
    if (!deps.learning) return c.json({ ok: false, error: "learning-not-wired" }, 503);
    if (!accountId) return c.json({ ok: false, error: "no-active-account" }, 401);
    return c.json({ ok: true, cleared: deps.learning.clearLearning(accountId) });
  });

  // ── Mail Curator manual trigger (Route C / WP J.8) ───────────────

  app.post("/curator/run", async (c) => {
    if (!deps.curator) {
      return c.json({ ok: false, error: "curator not wired" }, 503);
    }
    let body: { accountId?: unknown } = {};
    try {
      const text = await c.req.text();
      body = text.length > 0 ? (JSON.parse(text) as { accountId?: unknown }) : {};
    } catch {
      return c.json({ ok: false, error: "invalid JSON body" }, 400);
    }
    const explicitAccountId =
      typeof body.accountId === "string" && body.accountId.length > 0
        ? body.accountId
        : undefined;
    const activeAccountId = deps.getActiveAccountId?.();
    if (deps.getActiveAccountId && explicitAccountId) {
      if (!activeAccountId) {
        return c.json(
          { ok: false, error: "accountId is required (no active account)" },
          400,
        );
      }
      if (explicitAccountId !== activeAccountId) {
        return c.json(
          { ok: false, error: "cross-account-curator-run" },
          403,
        );
      }
    }
    const accountId = explicitAccountId ?? activeAccountId;
    if (!accountId) {
      return c.json(
        { ok: false, error: "accountId is required (no active account)" },
        400,
      );
    }
    try {
      const result = await deps.curator.triggerManual(accountId);
      if (!result) {
        return c.json({
          ok: true,
          accountId,
          summary: null,
          note: "no runtime available for account",
        });
      }
      return c.json({
        ok: true,
        accountId: result.accountId,
        reason: result.reason,
        summary: result.summary,
      });
    } catch (err) {
      return c.json(
        {
          ok: false,
          error: "curator-run-failed",
          detail: err instanceof Error ? err.message : String(err),
        },
        500,
      );
    }
  });

  return app;
}

/**
 * Default export kept for `server/api/app.ts` — unwired skeleton that
 * reports 503 so the renderer can detect a not-yet-configured agent
 * lane instead of seeing silent no-ops.
 */
export const agentRoutes = buildAgentRoutes();
