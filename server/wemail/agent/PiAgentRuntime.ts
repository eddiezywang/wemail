/**
 * PI-backed agent runtime (Handoff §5.J).
 *
 * Phase one is deliberately minimal:
 *   - Tool inventory is fixed (see {@link MailAgentTools}). Unknown
 *     tool names are rejected.
 *   - Production chat is routed through the official
 *     `@earendil-works/pi-agent-core` Agent. Tests may still pass a canned
 *     {@link AgentPlanner} to exercise the legacy loop deterministically.
 *   - Hard caps: ≤ 6 tool iterations per run, 30s per tool, 120s per run.
 *   - Safety rails:
 *       * agent traces never log mail body content (enforced at tool
 *         authoring time — see MailAgentTools redactions)
 *       * mail sending is exposed only as `propose_send_mail`; the
 *         confirmed pending-action executor owns the actual send
 *       * generic wecli mutations never execute from the agent path
 *         (wecli_query auto-only; wecli_action_preview never spawns);
 *         allowance invoice upload is available only through the
 *         dedicated pending-action flow.
 */

import {
  Agent as CorePiAgent,
  type AgentEvent as CorePiAgentEvent,
  type AgentOptions as CorePiAgentOptions,
  type AgentTool as CorePiAgentTool,
  type StreamFn,
} from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type Context,
  type Message,
  type Model,
  type TSchema,
  type ToolCall,
  type Usage,
} from "@earendil-works/pi-ai";
import type {
  AgentEvent,
  AgentRunInput,
  AgentRuntime,
  AgentTool,
  AgentToolContext,
} from "./AgentRuntime.js";
import {
  AgentTerminalToolError,
  isAgentTerminalToolFailure,
} from "./AgentRuntime.js";
import type { JsonSchema, ToolInput } from "./AgentTypes.js";
import type { LlmClient } from "../ai/LlmClient.js";
import type { AiUsageRepository } from "../settings/AiUsageRepository.js";
import type { AgentPendingAction } from "../../../shared/wemail/intelligence.js";
import type { AgentFailureContext } from "../../../shared/wemail/agent.js";
import { buildChannelAgentSystemPrompt } from "./ChannelAgentPolicy.js";
import { retryAgentOperation, type RetryNotice } from "./AgentRunCoordinator.js";
import { isApprovedIdempotentReadTool, isTransientAgentError } from "./AgentRetryPolicy.js";
import { directToolPolicy } from "./AgentOperationPolicy.js";
import { resolveAllowanceModules } from "./allowancePort.js";
import {
  AgentExecutionProgressTracker,
  DEFAULT_AGENT_EXECUTION_LIMITS,
  normalizeAgentExecutionLimits,
  type AgentExecutionLimits,
} from "./AgentExecutionProgress.js";

/** @deprecated Use independently named AgentExecutionLimits fields. */
export const PI_MAX_ITERATIONS =
  DEFAULT_AGENT_EXECUTION_LIMITS.maxEmergencyToolCalls;
export const PI_MAX_REPEAT_TOOL_CALLS =
  DEFAULT_AGENT_EXECUTION_LIMITS.maxExactRepeatCalls;
export const PI_MAX_TOOL_REPAIRS = 1;
export const PI_TOOL_TIMEOUT_MS =
  DEFAULT_AGENT_EXECUTION_LIMITS.toolTimeoutMs;
export const PI_RUN_TIMEOUT_MS =
  DEFAULT_AGENT_EXECUTION_LIMITS.runTimeoutMs;

/**
 * Default system prompt for the PI planner. Exported so the prompt-eval
 * framework can hash + reference the same text the runtime sends to the
 * LLM. Mirror this whenever `buildSystemPrompt` changes.
 *
 * This is the open-edition prompt: generic mail-assistant behavior only.
 * Edition-specific guidance (enterprise directory resolution, site-CLI
 * usage rules, internal allowance workflows, edition-only optional
 * dependencies) is NOT embedded here — editions supply it through
 * `PiAgentRuntimeOptions.extraPromptSections`, appended at the end of the
 * built prompt by `buildSystemPrompt`.
 */
export const PI_DEFAULT_SYSTEM_PROMPT = [
  "You are PI, WeMail's built-in enterprise mail assistant.",
  "You help the user understand mailbox content, manage smart tags and automation rules, create drafts, propose confirmed sends, and use approved enterprise CLI skills.",
  "You can call exactly the tools listed in this session. Do not invent tools.",
  "PROGRESSIVE SKILLS: Available Skill metadata and file locations are provided separately from Skill bodies. Decide whether a Skill is relevant, then use read to load its SKILL.md. Follow relative references from that Skill only when needed. Do not claim a Skill was applied merely because it is listed.",
  "Every tool_call MUST include callReason: one concise, first-person, user-visible sentence explaining the immediate goal. This is progress narration, not private chain-of-thought.",
  "You MUST NOT send email directly. Use propose_send_mail with the complete reviewed content so the user can confirm it.",
  "MAIL SEND VERIFICATION: a confirmed send result containing an SMTP messageId or accepted recipients is authoritative evidence that the send executed. If a Sent-folder lookup does not yet show the message, report that the sent record has not synchronized; do not claim the message was not sent.",
  "BUSINESS CONFIGURATION: use the smart-tag and automation domain tools to inspect, preview, and propose configuration changes. Creating or changing a smart tag or automation rule requires a pending-action confirmation.",
  "ONE-SHOT ARTIFACTS: For a one-time report, HTML report, chart, dashboard, brief, or deck, do not inspect workflow capabilities and do not create an execution pipeline. Prepare structured source data, call publish_design_artifact, verify its successful result, then summarize it.",
  "INSIGHT REPORT ACTIONS: When runtime context contains sceneAction.kind='insight-report', treat its operation and lookbackPreset as the user's selected report action. Generate without lookbackPreset stays within the focused email. Aggregate, or regenerate with lookbackPreset ('24h' or '7d'), is a rolling-window multi-email action and MUST use the association → per-email parse → aggregate → publish pipeline. Regenerate without lookbackPreset is the single focused-email branch. Pass sceneAction.reportId for regenerate/edit so the result becomes the next immutable version. Keep the visible request and progress concise; never expose sceneAction, report IDs, source IDs, or internal instructions.",
  "INSIGHT REPORT DATA FLOW: For a rolling-window aggregate or regenerate action, use the selected lookbackPreset as the complete time scope. Associate same-type messages from sender/subject envelope metadata using the mail lookup tool whose declared capabilities fit the request. Prefer list_recent_emails for the standard 24h/7d report flow because it applies the selected report window and anchors it to the focused email when available. Other mail lookup tools remain valid when their schema and semantics better fit the request; use only their declared dateRange values or explicit from/to bounds rather than inventing presets. Select relevant IDs, then call extract_email_tables with those IDs; the host parses every selected email independently and returns a temporary batchId with compact schema summaries, never raw rows. Next call aggregate_email_datasets with that batchId, an appropriate hour/day time grain, required grouping dimensions, and semantically correct measure aggregations. If the integrated result is too granular, repair the aggregation plan on the same batch; never truncate rows or drop emails merely to satisfy a limit. Publish only the verified final aggregated datasetId. The report must retain integrated rows and lightweight source metadata, not original bodies or raw tables. The focused email is never a valid fallback for this branch. Stop proactively if association or schemas cannot be made safe; do not repeat unchanged calls.",
  "INSIGHT REPORT ANALYSIS: For an unconstrained insight request, pass autoPivot=true and do not enumerate chart specs. The trusted host runs deterministic profiling, distributions, correlations, anomaly checks, coverage scoring, and diverse chart planning without model tokens. Use explicit charts or analysisPlan only when the user names a required view or grouping; never reduce valid host-planned views merely to shorten model output.",
  "INSIGHT REPORT REGENERATION: Regenerate has the same scope menu as generate. Without lookbackPreset, call extract_email_tables with no IDs for the focused current email. With lookbackPreset 24h/7d, associate the selected emails first (prefer list_recent_emails for its report-window semantics), extract their IDs, aggregate them, then publish to sceneAction.reportId. A missing sourceEmailIds field does not mean 'use the focused email' for a rolling-window action; association is still required.",
  "AUTOMATION OWNERSHIP: after a rule is confirmed, the automation engine matches, schedules, and executes it without PI participating in individual runs. Mail-received rules may run immediately, after a relative delay, on the next calendar day at a local time, or at a temporal field expression.",
  "AUTOMATION TEMPORAL FIELDS: mail.receivedAt is the received timestamp. invoice.issueDate is an optional attachment collection field. Preserve the user's selected field, aggregation, duration, and fallback. Never add invoice.issueDate or mail.receivedAt fallback unless requested. Ask for clarification when a collection lacks aggregation.",
  "FOCUSED MAIL SCOPE: If runtime context includes a current focused email (emailId/threadId) and the user does not explicitly ask for a broader mailbox, date range, sender, thread, folder, or enterprise-system data scope, treat the current focused email as the entire data scope. Do not search the broader mailbox or infer month/account-wide scope from generic words like invoice, attachment, upload, or platform. If runtime context includes emailIds (multiple mails the user @-attached to this turn), those emails form the data scope together: read each by its id and do not search for replacements.",
  "MAILBOX SCOPE: If runtime context includes mailScope='mailbox', the user explicitly selected the whole active mailbox. Do not infer a focused email from recent conversation. Use mail search/list tools when the request needs mail facts, then read the selected results before answering.",
  "SEMANTIC ACTION SCOPE: If runtime context includes semanticAction, treat semanticAction.executionScope as the authoritative mailbox scope. Use mail tools to resolve that scope, include read mail when mailState is all, and do not treat discovery emailIds as the full scope for a query action. You must not silently broaden the declared executionScope. Cite the source mail used for every factual conclusion.",
  "For generic wecli mutations, use preview/confirmation tools only; never claim that a mutation was executed unless a tool result says so.",
  "HIGH-RISK ACTIONS: You MUST NOT directly execute send, delete, move, archive, mark spam, unsubscribe, or run automation. Instead, describe the action as a pendingAction for user confirmation.",
  "DELETE SEMANTICS: 删除/删掉一封邮件 means permanent_delete (彻底删除，不可恢复). Only use trash (移到回收站) when the user explicitly mentions 回收站/垃圾箱. Never label a permanent delete as 移到垃圾箱.",
  "INSIGHT REPORT AVAILABILITY: WeMail saves generated data insight reports (report/dashboard/brief/deck) to WeMail「应用消息」. The report card can open them inside WeMail or in this computer's default browser while WeMail is running. This local URL is not a shareable cross-device chat link: WeCom/Feishu cannot reach it from another device. When you publish one, tell the user it has been saved to 应用消息; do not promise a remotely accessible link.",
  "CITATIONS: When you state a fact from an email, record the supporting emailId, tool name, and result path in the structured citations field. Never print those internal citation fields in normal user-facing prose.",
  "TOOL CALL REASONS: Every tool_call MUST include callReason as a short user-visible explanation of the next step. It is execution status, not private chain-of-thought, hidden policy, or developer commentary.",
    "USER-FACING OUTPUT: Use natural business wording. Do not expose internal ids, action ids, email ids, JSON paths, or unrelated implementation details. When a tool call fails, the final outcome must retain the failed tool name, the redacted command when available, and the tool call id when available so the user can trace the failure.",
    "CLI ERROR UX: When command-line tool output indicates failure, summarize the likely cause and give the user a concrete next action. Consider common causes such as login/authentication, expired browser session, missing permission, invalid arguments, missing files, network/VPN issues, unsupported formats, and command timeouts. Do not only paste raw stdout, stderr, exit codes, or stack traces; include raw output only as supporting detail when it helps the user act.",
  "TOOL ERROR RECOVERY: When a tool reports invalid arguments, schema validation, an invalid command, or a transient service failure, use the error feedback to correct the call once. Do not repeat the same invalid call or continue retrying without new information.",
  "FINAL OUTCOME: End every run with a clear user-facing outcome: succeeded, failed, blocked, cancelled, or waiting for required information. For an incomplete run, explain the reason, what was not completed, and the concrete next action.",
  "MISSING CONTEXT: If required context (like emailId) is missing and cannot be inferred, call terminate_execution with a concise reason. Do NOT hallucinate actions or mail content.",
  "If required context is missing or a request cannot be completed safely, call terminate_execution with a concise reason.",
  "Keep responses concise, practical, and grounded in tool results.",
  "When a user asks to summarize a mail message, inspect or list the relevant message first, then call the available summary tool instead of summarizing from memory.",
  "If the summary tool returns ready=false, say the AI summary is not ready. Do not infer or fabricate a summary from subject/snippet alone.",
  "When the user asks for unread mail, call list_mail with unreadOnly:true. Treat folder names case-insensitively; INBOX is the canonical inbox folder.",
  "If a tool result gives a mail id, reuse that exact id for follow-up mail tools.",
  "For relative date questions, use get_current_time or mail tools with dateRange presets. Do not invent the current date.",
].join("\n");

/**
 * Planner step output. Either call a single tool with JSON input, or
 * produce a final assistant-text reply. `error` is a terminal state.
 */
export type PlannerDecision =
  | { kind: "tool_call"; tool: string; input: ToolInput; callReason?: string }
  | { kind: "final"; text: string; citations?: Array<import("../../../shared/wemail/intelligence.js").AgentCitation> }
  | { kind: "error"; message: string };

export interface PlannerStepInput {
  userText: string;
  context?: Record<string, unknown>;
  tools: Array<Pick<AgentTool, "name" | "description" | "inputSchema">>;
  /** Canonical trace of tool calls + results in this run. No body text. */
  history: Array<
    | { type: "tool_call"; tool: string; input: ToolInput }
    | { type: "tool_result"; tool: string; output: unknown }
  >;
}

function requestsViewableArtifact(userText: string): boolean {
  return /(?:报表|报告|图表|看板|仪表盘|简报|演示文稿|幻灯片|dashboard|report|chart|deck|html)/i.test(
    userText,
  );
}

function containsCompleteHtmlDocument(text: string): boolean {
  return /<!doctype\s+html|<html(?:\s|>)/i.test(text);
}

function historyHasDeliveredArtifact(
  history: PlannerStepInput["history"],
): boolean {
  return history.some((entry) => {
    if (entry.type !== "tool_result" || !entry.output || typeof entry.output !== "object") {
      return false;
    }
    return toolResultHasDeliveredArtifact(entry.output);
  });
}

function toolResultHasDeliveredArtifact(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const output = value as {
      artifact?: { applicationMessageId?: unknown };
      artifacts?: Array<{ applicationMessageId?: unknown }>;
    };
  return (
    typeof output.artifact?.applicationMessageId === "string" ||
    output.artifacts?.some(
      (artifact) => typeof artifact.applicationMessageId === "string",
    ) === true
  );
}

export interface AgentPlanner {
  step(input: PlannerStepInput): Promise<PlannerDecision>;
}

function userVisibleProgressForTool(
  toolName: string,
  callReason?: string,
): string {
  const explicit = callReason?.trim();
  if (explicit) return explicit;
  if (toolName === "get_current_time") {
    return "我先确认当前时间和统计范围。";
  }
  if (/^(list|search)_?(mail|email)/.test(toolName)) {
    return "我先查找与请求相关的邮件。";
  }
  if (/^(batch_)?(read|get).*?(mail|email)|summarize_mail/.test(toolName)) {
    return "我正在读取相关邮件内容，以便继续分析。";
  }
  if (toolName === "inspect_workflow_capabilities") {
    return "数据已经准备好，我正在确认生成结果所需的能力。";
  }
  if (/create_.*pipeline|create_.*artifact/.test(toolName)) {
    return "我开始组织报表结构和展示内容。";
  }
  if (/execute_.*pipeline|render|generate/.test(toolName)) {
    return "我现在生成并检查最终结果。";
  }
  if (/draft|compose/.test(toolName)) {
    return "我根据已有信息准备邮件草稿。";
  }
  return "我继续处理下一步。";
}

function retryNoticeEvent(notice: RetryNotice): AgentEvent {
  if (notice.type === "scheduled") {
    return {
      type: "retry_scheduled",
      attempt: notice.attempt,
      delayMs: notice.delayMs ?? 0,
      reason: notice.message ?? "临时服务异常",
    };
  }
  if (notice.type === "started") {
    return {
      type: "retry_started",
      attempt: notice.attempt,
      maxAttempts: notice.maxAttempts,
    };
  }
  if (notice.type === "completed") {
    return { type: "retry_completed", attempt: notice.attempt };
  }
  return {
    type: "retry_failed",
    attempt: notice.attempt,
    message: notice.message ?? "重试失败",
  };
}

export type PiProvider = "openai" | "anthropic";

export interface PiModelConfig {
  provider: PiProvider;
  apiKey: string;
  model: string;
  baseUrl?: string;
}

export interface PiAgentLike {
  subscribe(
    listener: (event: CorePiAgentEvent, signal?: AbortSignal) => Promise<void> | void,
  ): () => void;
  prompt(input: string): Promise<void>;
  abort?(): void;
  waitForIdle?(): Promise<void>;
}

export type PiAgentFactory = (options: CorePiAgentOptions) => PiAgentLike;

/**
 * Edition-contributed prompt sections. Either a fixed list, or a function of
 * the run context (so sections can adapt to a focused email, channel, etc.).
 * Appended to the END of the built system prompt — after the base prompt,
 * skill sections, and channel sections — by `buildSystemPrompt`.
 */
export type PromptSections =
  | readonly string[]
  | ((context?: Record<string, unknown>) => readonly string[]);

export interface PiAgentRuntimeOptions {
  llm?: LlmClient;
  pi?: PiModelConfig;
  piAgentFactory?: PiAgentFactory;
  planner?: AgentPlanner;
  usePlannerStream?: boolean;
  usage?: AiUsageRepository;
  model?: string;
  toolTimeoutMs?: number;
  runTimeoutMs?: number;
  maxExactRepeatCalls?: number;
  maxConsecutiveNoProgress?: number;
  maxEmergencyToolCalls?: number;
  executionLimits?: Partial<AgentExecutionLimits>;
  /** @deprecated Maps only to maxEmergencyToolCalls for deterministic tests. */
  maxIterations?: number;
  now?: () => number;
  /**
   * Override the default PI system prompt. Used by specialized runtimes
   * (e.g. CuratorAgentRuntime) that share PI's loop but need a different
   * role + safety contract.
   */
  systemPrompt?: string;
  skillPrompt?: (context: Record<string, unknown> | undefined) => string;
  /**
   * Edition-only guidance appended after the built-in prompt sections
   * (P2 module seam; see `EditionModules.extraPromptSections`). The open
   * edition supplies none and the default prompt stands alone.
   */
  extraPromptSections?: PromptSections;
  /**
   * P2.6 test/edition override for the allowance proposal-conclusion hook
   * (the module registration supplies it in the internal edition; see
   * `EditionModules.allowance.concludeProposal`). Takes precedence over the
   * build-time registration so suites can inject the module's projector.
   */
  proposalConclusion?: (
    toolName: string,
    output: unknown,
  ) =>
    | { status: "succeeded" | "failed"; summary: string; nextAction?: string }
    | undefined;
}

const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 8_192;
const TOOL_RESULT_TEXT_LIMIT = 8_000;
const PLANNER_TRANSCRIPT_LIMIT = 18_000;
const ZERO_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  },
};

const TERMINATE_TOOL_NAME = "terminate_execution";
const ARTIFACT_REPAIR_PROMPT =
  "The requested viewable report has not been delivered. Continue this same run once. If the verified data is sufficient, call publish_design_artifact and verify artifact.applicationMessageId. If publishing is unsafe or required data is missing, call terminate_execution with the concrete reason. Do not repeat unchanged reads or claim success without an application artifact.";

/**
 * Default planner: asks the LLM to emit a single JSON object with
 * either `{ tool, input }` or `{ final: "..." }`. Provider-neutral —
 * works with any `LlmClient` adapter. Keeps the prompt short and
 * free of mail body content.
 */
export function createDefaultPlanner(deps: {
  llm: LlmClient;
  model: string;
  /** LLM provider / model source (e.g. "openai", "anthropic"). */
  provider?: string;
  usage?: AiUsageRepository;
  /**
   * Optional override for the planner-step system prompt prefix. When
   * supplied, replaces the default "You are PI..." preamble. The
   * mandatory JSON-output rules + dynamic tool listing are still
   * appended automatically so the parser stays honest.
   *
   * Used by CuratorAgentRuntime so curator runs see CURATOR_SYSTEM_PROMPT
   * (which constrains workspace writes) instead of the generic PI
   * mail-assistant safety contract.
   */
  systemPrompt?:
    | string
    | ((context: Record<string, unknown> | undefined) => string);
}): AgentPlanner {
      const schema: JsonSchema = {
        type: "object",
        properties: {
          tool: { type: "string" },
          input: { type: "object" },
          callReason: { type: "string" },
          final: { type: "string" },
          citations: {
            type: "array",
            items: {
              type: "object",
              properties: {
                emailId: { type: "string" },
                tool: { type: "string" },
                path: { type: "string" },
              },
              required: ["emailId", "tool"],
            },
          },
        },
        additionalProperties: false,
      };
  type PlannerJson = {
    tool?: string;
    input?: ToolInput;
    callReason?: string;
    final?: string;
    citations?: Array<{ emailId?: unknown; tool?: unknown; path?: unknown }>;
  };

  function decisionFrom(parsed: PlannerJson): PlannerDecision | null {
    if (typeof parsed.final === "string") {
      const citations = Array.isArray(parsed.citations)
        ? parsed.citations.filter(
            (c): c is import("../../../shared/wemail/intelligence.js").AgentCitation =>
              typeof c.emailId === "string" && typeof c.tool === "string",
          )
        : undefined;
      return { kind: "final", text: parsed.final, citations };
    }
    if (typeof parsed.tool === "string") {
      return {
        kind: "tool_call",
        tool: parsed.tool,
        input: (parsed.input ?? {}) as ToolInput,
        callReason:
          typeof parsed.callReason === "string" ? parsed.callReason : undefined,
      };
    }
    return null;
  }

  const DEFAULT_PROMPT_PREAMBLE = [
    "You are PI, WeMail's built-in mail assistant.",
    "You can call exactly the tools listed below — nothing else.",
    "You may create and edit drafts. To send mail, schedule mail, change business configuration, or perform destructive mailbox operations, use the matching propose_* tool so the user can confirm it.",
    "You may manage smart tags, automation rules, writing styles, notifications, and other non-sensitive business preferences. Never change account credentials, provider secrets, or security settings.",
    "FOCUSED MAIL SCOPE: If runtime context includes a current focused email (emailId/threadId) and the user does not explicitly ask for a broader mailbox, date range, sender, thread, folder, or enterprise-system data scope, treat the current focused email as the entire data scope. Do not search the broader mailbox or infer month/account-wide scope from generic words like invoice, attachment, upload, or platform. If runtime context includes emailIds (multiple mails the user @-attached to this turn), those emails form the data scope together: read each by its id and do not search for replacements.",
    "MAILBOX SCOPE: If runtime context includes mailScope='mailbox', the user explicitly selected the whole active mailbox. Do not infer a focused email from recent conversation. Use mail search/list tools when the request needs mail facts, then read the selected results before answering.",
    // P2.6: the monthly-allowance workflow clauses live in the edition
    // module's prompt sections (`EditionModules.allowance` combined into
    // `extraPromptSections`); the open default stays generic.
    "For generic wecli mutations, call `propose_wecli_command` so the user can confirm. Use wecli_run only for conservative read-only commands.",
    "CLI ERROR UX: When command-line tool output indicates failure, summarize the likely cause and give the user a concrete next action. Do not only paste raw stdout, stderr, exit codes, or stack traces.",
    "TOOL ERROR RECOVERY: Correct invalid tool arguments or transient failures once using the returned error. Do not repeat the same invalid call or retry indefinitely.",
    "FINAL OUTCOME: Always finish with a clear outcome. If incomplete, explain the reason, impact, and next action.",
  ];
  return {
    async step(stepInput) {
      const resolvedSystemPrompt = typeof deps.systemPrompt === "function"
        ? deps.systemPrompt(stepInput.context)
        : deps.systemPrompt;
      const preamble = resolvedSystemPrompt
        ? [resolvedSystemPrompt]
        : DEFAULT_PROMPT_PREAMBLE;
      const channelPrompt = buildChannelAgentSystemPrompt(stepInput.context);
      const system = [
        ...preamble,
        ...(channelPrompt ? [channelPrompt] : []),
        "OUTPUT FORMAT: respond with a single JSON object and NOTHING ELSE.",
        "No prose, no greetings, no markdown, no code fence. Start with `{`.",
        "Either:",
        '  {"tool":"<name>","input":{...}}  — to call a tool',
        '  {"final":"..."}                  — to finish the turn',
        "Tools:",
        ...stepInput.tools.map((t) => `- ${t.name}: ${t.description}`),
      ].join("\n");
      const historyBlob = stepInput.history
        .map((h) =>
          h.type === "tool_call"
            ? `CALL ${h.tool} ${JSON.stringify(h.input)}`
            : `RESULT ${h.tool} ${JSON.stringify(h.output)}`,
        )
        .join("\n");
      const userContent = [
        `User: ${stepInput.userText}`,
        stepInput.context ? `Runtime context JSON:\n${safeJson(stepInput.context)}` : "",
        historyBlob ? `History:\n${historyBlob}` : "",
      ]
        .filter(Boolean)
        .join("\n\n");
      const res = await deps.llm.generate({
        model: deps.model,
        system,
        jsonSchema: schema,
        messages: [{ role: "user", content: userContent }],
      });
      deps.usage?.record({
        accountId:
          typeof stepInput.context?.accountId === "string"
            ? stepInput.context.accountId
            : "local",
        category: "agent_chat",
        processor: "agent",
        inputTokens: res.usage?.inputTokens ?? 0,
        outputTokens: res.usage?.outputTokens ?? 0,
        model: deps.model,
        provider: deps.provider,
      });

      const parsed = tryParsePlannerJson(res.text);
      if (parsed) {
        const decision = decisionFrom(parsed as PlannerJson);
        if (decision) return decision;
      }

      // Repair attempt: ask the LLM to convert its previous prose into
      // strict JSON. Some OpenAI-compat providers (e.g. GLM, local
      // gateways) ignore `response_format: json_schema` and return free
      // text. One extra round-trip is cheap insurance.
      const repaired = await deps.llm.generate({
        model: deps.model,
        system: [
          "You are a strict JSON repair adapter for PI.",
          "Convert the previous invalid planner output into exactly one valid JSON decision.",
          "Do not answer the user. Do not explain. Output JSON only. Start with `{`.",
          system,
        ].join("\n"),
        jsonSchema: schema,
        messages: [
          {
            role: "user",
            content: [
              "Invalid planner output:",
              res.text,
              "",
              "Original turn:",
              userContent,
            ].join("\n"),
          },
        ],
      });
      deps.usage?.record({
        accountId:
          typeof stepInput.context?.accountId === "string"
            ? stepInput.context.accountId
            : "local",
        category: "agent_chat",
        processor: "agent",
        inputTokens: repaired.usage?.inputTokens ?? 0,
        outputTokens: repaired.usage?.outputTokens ?? 0,
        model: deps.model,
        provider: deps.provider,
      });
      const repairedParsed = tryParsePlannerJson(repaired.text);
      if (repairedParsed) {
        const decision = decisionFrom(repairedParsed as PlannerJson);
        if (decision) return decision;
      }
      return {
        kind: "error",
        message: "planner produced no decision after repair",
      };
    },
  };
}

/**
 * Try to recover a planner JSON object from arbitrary text.
 *  1. Plain `JSON.parse`
 *  2. ```json ... ``` markdown fence
 *  3. ``` ... ``` generic fence
 *  4. First `{` to matching last `}` substring scan
 *
 * Returns the parsed object or null.
 */
function tryParsePlannerJson(raw: string): unknown | null {
  if (!raw) return null;
  const text = raw.trim();
  try {
    return JSON.parse(text);
  } catch {
    /* fall through */
  }
  const fenced = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/i);
  if (fenced && fenced[1]) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
      /* fall through */
    }
  }
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    try {
      return JSON.parse(text.slice(firstBrace, lastBrace + 1));
    } catch {
      /* fall through */
    }
  }
  return null;
}

function ensureOpenAiBaseUrl(baseUrl: string | undefined): string {
  const normalized = (baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  return /\/v1$/i.test(normalized) ? normalized : `${normalized}/v1`;
}

function createPiModel(config: PiModelConfig): Model<Api> {
  if (config.provider === "anthropic") {
    return {
      id: config.model,
      name: config.model,
      api: "anthropic-messages",
      provider: "anthropic",
      baseUrl: config.baseUrl ?? "https://api.anthropic.com/v1",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: DEFAULT_CONTEXT_WINDOW,
      maxTokens: DEFAULT_MAX_TOKENS,
    };
  }

  return {
    id: config.model,
    name: config.model,
    api: "openai-completions",
    provider: "openai",
    baseUrl: ensureOpenAiBaseUrl(config.baseUrl),
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      supportsStrictMode: false,
      // Omit supportsUsageInStreaming: the SDK's detectCompat defaults it to
      // true for every OpenAI-compatible provider (deepseek/openai/openrouter/
      // moonshot/zai/...) and falls back to true for unknown endpoints, which
      // makes stream_options.include_usage populate AssistantMessage.usage.
      // Forcing false here was the reason agent_chat usage was always 0.
      maxTokensField: "max_tokens",
    },
  };
}

function safeJson(value: unknown, fallback = "{}"): string {
  try {
    return JSON.stringify(value);
  } catch {
    return fallback;
  }
}

/**
 * Validate and filter citations. Only entries with string emailId and
 * string tool survive; entries with missing or non-string required
 * fields are dropped.
 */
function validateCitations(
  raw: Array<import("../../../shared/wemail/intelligence.js").AgentCitation> | undefined,
): Array<import("../../../shared/wemail/intelligence.js").AgentCitation> | undefined {
  if (!Array.isArray(raw)) return undefined;
  const filtered = raw.filter(
    (c): c is import("../../../shared/wemail/intelligence.js").AgentCitation =>
      typeof c.emailId === "string" && typeof c.tool === "string",
  );
  return filtered.length > 0 ? filtered : undefined;
}

/**
 * P2.6: the allowance upload proposal conclusion is an edition module hook
 * (`EditionModules.allowance.concludeProposal`); its implementation moved to
 * `wemail-int/internal/src/allowance`. The open edition has no module, so no
 * business conclusion is projected and the run continues generically.
 */
function allowanceProposalConclusion(
  runtime: { proposalConclusion?: PiAgentRuntimeOptions["proposalConclusion"] },
  toolName: string,
  output: unknown,
): Extract<AgentEvent, { type: "conclusion" }> | undefined {
  const proposed = runtime.proposalConclusion?.(toolName, output)
    ?? resolveAllowanceModules()?.concludeProposal?.(toolName, output);
  return proposed
    ? {
        type: "conclusion",
        status: proposed.status,
        summary: proposed.summary,
        ...(proposed.nextAction ? { nextAction: proposed.nextAction } : {}),
      }
    : undefined;
}

function pendingActionFromToolOutput(output: unknown): AgentPendingAction | undefined {
  if (!output || typeof output !== "object") return undefined;
  const pendingAction = (output as { pendingAction?: unknown }).pendingAction;
  if (!pendingAction || typeof pendingAction !== "object") return undefined;
  const candidate = pendingAction as Partial<AgentPendingAction>;
  if (
    typeof candidate.id !== "string" ||
    typeof candidate.actionType !== "string" ||
    typeof candidate.description !== "string" ||
    typeof candidate.toolName !== "string" ||
    typeof candidate.inputJson !== "string" ||
    typeof candidate.riskReason !== "string" ||
    (candidate.riskLevel !== "low" &&
      candidate.riskLevel !== "medium" &&
      candidate.riskLevel !== "high")
  ) {
    return undefined;
  }
  return candidate as AgentPendingAction;
}

function toolResultText(output: unknown): string {
  const text = typeof output === "string" ? output : safeJson(output, String(output));
  return text.length > TOOL_RESULT_TEXT_LIMIT
    ? `${text.slice(0, TOOL_RESULT_TEXT_LIMIT)}\n...[truncated]`
    : text;
}

class OperationTimeoutError extends Error {
  readonly label: string;
  readonly timeoutMs: number;

  constructor(label: string, timeoutMs: number) {
    super(`${label} timed out after ${timeoutMs}ms`);
    this.name = "OperationTimeoutError";
    this.label = label;
    this.timeoutMs = timeoutMs;
  }
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
  onTimeout?: () => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout?.();
      reject(new OperationTimeoutError(label, ms));
    }, ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

function runToolWithTimeout(
  tool: AgentTool,
  input: ToolInput,
  ctx: AgentToolContext,
  timeoutMs: number,
): Promise<unknown> {
  const controller = new AbortController();
  const signal = ctx.signal
    ? AbortSignal.any([ctx.signal, controller.signal])
    : controller.signal;
  signal.throwIfAborted();
  return withTimeout(
    tool.handler(input, { ...ctx, signal }),
    timeoutMs,
    `tool ${tool.name}`,
    () => controller.abort(),
  );
}

function isFailedToolOutput(output: unknown): boolean {
  return (
    !!output &&
    typeof output === "object" &&
    (output as { ok?: unknown }).ok === false
  );
}

function coreToolResultText(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .filter(
      (item): item is { type: "text"; text: string } =>
        !!item &&
        typeof item === "object" &&
        (item as { type?: unknown }).type === "text" &&
        typeof (item as { text?: unknown }).text === "string",
    )
    .map((item) => item.text.trim())
    .filter(Boolean)
    .join("\n");
  if (!text) return undefined;
  return text.length > 800 ? `${text.slice(0, 800)}…` : text;
}

function genericToolFailure(
  toolName: string,
  result: unknown,
): { output: { ok: false; code: string; error: string }; reason: string } {
  const structured = coreToolFailureDetails(result);
  const detail = coreToolResultText(result);
  const error = structured.detail || detail || `工具 ${toolName} 执行失败`;
  return {
    output: {
      ok: false,
      code: structured.code ?? "tool_execution_failed",
      error,
    },
    reason: error,
  };
}

type AgentFailureDisposition =
  | "repairable"
  | "transient"
  | "terminal"
  | "blocked"
  | "needs_input"
  | "cancelled";

interface AgentFailureAssessment {
  disposition: AgentFailureDisposition;
  status: Extract<
    AgentEvent,
    { type: "conclusion" }
  >["status"];
  code: string;
  technicalDetail: string;
  reason: string;
  impact: string;
  nextAction?: string;
  failureContext?: AgentFailureContext;
}

function redactFailureCommand(value: string): string {
  return value
    .replace(
      /(--(?:password|passwd|token|api[_-]?key|secret|authorization)(?:=|\s+))(?:"[^"]*"|'[^']*'|\S+)/gi,
      "$1[REDACTED]",
    )
    .replace(/[\r\n]+/g, " ")
    .trim()
    .slice(0, 1_000);
}

function failureContextForTool(
  tool: string,
  input?: ToolInput,
  toolCallId?: string,
): AgentFailureContext {
  let command: string | undefined;
  const rawCommand =
    input && typeof input.command === "string" ? input.command.trim() : "";
  if (rawCommand) {
    command = /^wecli(?:\.exe)?\s/i.test(rawCommand)
      ? rawCommand
      : tool.startsWith("wecli_") || tool === "propose_wecli_command"
        ? `wecli ${rawCommand}`
        : rawCommand;
  } else if (tool === "wecli_help" && input) {
    const parts = [input.site, input.command, input.mode]
      .filter((part): part is string => typeof part === "string" && !!part.trim())
      .map((part) => part.trim());
    if (parts.length > 0) command = `wecli ${parts.join(" ")} --help`;
  }
  return {
    tool,
    ...(toolCallId ? { toolCallId } : {}),
    ...(command ? { command: redactFailureCommand(command) } : {}),
  };
}

function withFailureContext(
  assessment: AgentFailureAssessment,
  tool: string,
  input?: ToolInput,
  toolCallId?: string,
): AgentFailureAssessment {
  return {
    ...assessment,
    failureContext: failureContextForTool(tool, input, toolCallId),
  };
}

function coreToolFailureDetails(result: unknown): {
  detail: string;
  code?: string;
  terminal: boolean;
} {
  const coreResult =
    result && typeof result === "object"
      ? (result as { details?: unknown })
      : undefined;
  const details = coreResult?.details;
  if (isAgentTerminalToolFailure(details)) {
    return {
      detail: details.error,
      code: details.code,
      terminal: true,
    };
  }
  if (details && typeof details === "object") {
    const failure = details as { ok?: unknown; code?: unknown; error?: unknown };
    if (failure.ok === false && typeof failure.error === "string") {
      return {
        detail: failure.error,
        ...(typeof failure.code === "string" ? { code: failure.code } : {}),
        terminal: false,
      };
    }
  }
  return {
    detail: coreToolResultText(result) ?? "工具执行失败",
    terminal: false,
  };
}

function classifyToolFailure(toolName: string, result: unknown): AgentFailureAssessment {
  const failure = coreToolFailureDetails(result);
  const detail = failure.detail.trim() || "工具执行失败";
  const normalized = `${failure.code ?? ""} ${detail}`.toLowerCase();
  const baseImpact = "失败步骤及其后续操作未执行。";

  if (failure.terminal) {
    if (/tool_timeout|timed? out|timeout|工具.*超时/.test(normalized)) {
      return {
        disposition: "terminal",
        status: "failed",
        code: failure.code ?? "tool_timeout",
        technicalDetail: detail,
        reason: detail,
        impact: baseImpact,
        nextAction: "请稍后重试该步骤；如果持续超时，请检查对应服务状态或缩小单次处理批量。",
      };
    }
    if (
      /not installed|binary.*missing|executable.*missing|command not found|enoent|未检测到|未安装|找不到.*(?:程序|命令|可执行)/.test(
        normalized,
      )
    ) {
      return {
        disposition: "blocked",
        status: "blocked",
        code: failure.code ?? "dependency_missing",
        technicalDetail: detail,
        reason: detail,
        impact: baseImpact,
        nextAction: "请先安装或配置所需的本地工具，然后重试。",
      };
    }
    return {
      disposition: "terminal",
      status: "failed",
      code: failure.code ?? "terminal_tool_failure",
      technicalDetail: detail,
      reason: detail,
      impact: baseImpact,
    };
  }

  if (/aggregation-source-incomplete|insight-data-contract|artifact-delivery-pointer-mismatch|artifact-publish-failed/.test(normalized)) {
    return {
      disposition: "repairable",
      status: "failed",
      code: failure.code ?? "insight_report_data_invalid",
      technicalDetail: detail,
      reason: detail,
      impact: baseImpact,
      nextAction: "请先修复关联、解析或聚合数据，再重新生成报告；本次不会复用旧报告冒充新结果。",
    };
  }

  if (
      /invalid (?:argument|arguments|command)|required propert|missing required|schema|validation|expected .* (?:string|number|object|array)|unknown tool|unknown command|empty command|dataset-required|dataset-not-found|account-required|associated-email-ids-required|aggregation-plan|email-aggregation-required|design-dataset-|参数.*(?:缺失|无效|错误)|命令.*(?:无效|为空)|缺少.*参数/.test(
      normalized,
    )
  ) {
    return {
      disposition: "repairable",
      status: "failed",
      code: "agent_invalid_tool_input",
      technicalDetail: detail,
      reason: "我生成的工具命令或参数不完整。",
      impact: baseImpact,
      nextAction: "我会自动修正一次；若仍失败，再请你介入。",
    };
  }

  if (
    /timed? out|timeout|network|econn|socket|temporar|429|502|503|504|网络|连接超时|服务暂时/.test(
      normalized,
    )
  ) {
    return {
      disposition: "transient",
      status: "failed",
      code: "transient_tool_failure",
      technicalDetail: detail,
      reason: "外部服务或网络暂时不可用。",
      impact: baseImpact,
      nextAction: "系统会自动重试一次；若仍失败，请检查网络或服务状态。",
    };
  }

  if (
    /missing context|required context|missing .*?(?:email|account|file|date|information)|need(?:ed|s)? .*context|provide .*?(?:email|account|file|date)|缺少.*(?:上下文|邮件|账户|文件|日期|信息)|需要补充/.test(
      normalized,
    )
  ) {
    return {
      disposition: "needs_input",
      status: "needs_input",
      code: "missing_required_context",
      technicalDetail: detail,
      reason: detail,
      impact: "尚未执行需要这些信息的操作。",
      nextAction: "请补充缺少的信息后继续。",
    };
  }

  if (
    /not installed|binary.*missing|executable.*missing|command not found|enoent|未检测到|未安装|找不到.*(?:程序|命令|可执行)/.test(
      normalized,
    )
  ) {
    return {
      disposition: "blocked",
      status: "blocked",
      code: failure.code ?? "dependency_missing",
      technicalDetail: detail,
      reason: detail,
      impact: baseImpact,
      nextAction: "请先安装或配置所需的本地工具，然后重试。",
    };
  }

  if (
    /unauthori|forbidden|permission|access denied|not logged|login|authenticate|权限|无权|拒绝访问|未登录|认证/.test(
      normalized,
    )
  ) {
    return {
      disposition: "blocked",
      status: "blocked",
      code: "authorization_required",
      technicalDetail: detail,
      reason: "当前登录状态或权限不足，无法执行该操作。",
      impact: baseImpact,
      nextAction: "请完成登录或确认账户权限后重试。",
    };
  }

  if (
    /policy|safety|disabled|not available to pi|confirmation required|not allowed|安全|策略|禁止|需要确认/.test(
      normalized,
    )
  ) {
    return {
      disposition: "blocked",
      status: "blocked",
      code: "policy_blocked",
      technicalDetail: detail,
      reason: "该操作受到安全策略或确认流程限制，因此没有执行。",
      impact: "被限制的操作没有执行。",
      nextAction: "请按提示完成确认，或调整为允许的操作。",
    };
  }

  return {
    disposition: "terminal",
    status: "failed",
    code: "tool_execution_failed",
    technicalDetail: detail,
    reason: "工具执行时发生错误，本次任务无法继续。",
    impact: baseImpact,
    nextAction: "请查看工具详情，修正问题后重试。",
  };
}

function exhaustedRepairAssessment(
  assessment: AgentFailureAssessment,
): AgentFailureAssessment {
  if (assessment.disposition === "transient") {
    return {
      ...assessment,
      disposition: "terminal",
      reason: "外部服务或网络在自动重试后仍未恢复。",
      nextAction: "请检查网络或服务状态后重试。",
    };
  }
  return {
    ...assessment,
    disposition: "terminal",
    reason: "我生成的工具命令或参数在自动修正后仍未通过校验。",
    nextAction: "请重新发起任务；如果问题持续出现，可展开工具详情协助排查。",
  };
}

function safeToolObservation(
  tool: AgentTool | undefined,
  output: unknown,
): string | undefined {
  try {
    return tool?.observe?.(output);
  } catch {
    return undefined;
  }
}

class AsyncEventQueue<T> implements AsyncIterable<T> {
  private readonly items: T[] = [];
  private readonly waiters: Array<(value: IteratorResult<T>) => void> = [];
  private closed = false;

  push(item: T): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value: item, done: false });
      return;
    }
    this.items.push(item);
  }

  close(): void {
    this.closed = true;
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      waiter?.({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item) return Promise.resolve({ value: item, done: false });
        if (this.closed) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise<IteratorResult<T>>((resolve) => {
          this.waiters.push(resolve);
        });
      },
    };
  }
}

export class PiAgentRuntime implements AgentRuntime {
  private readonly tools = new Map<string, AgentTool>();
  private readonly planner?: AgentPlanner;
  private readonly pi?: PiModelConfig;
  private readonly plannerLlm?: LlmClient;
  private readonly plannerModel?: string;
  private readonly usePlannerStream: boolean;
  private readonly usage?: AiUsageRepository;
  private readonly piAgentFactory: PiAgentFactory;
  private readonly executionLimits: AgentExecutionLimits;
  private readonly toolTimeoutMs: number;
  private readonly runTimeoutMs: number;
  private readonly now: () => number;
  private readonly systemPromptOverride: string | undefined;
  private readonly skillPrompt?: (
    context: Record<string, unknown> | undefined,
  ) => string;
  private readonly extraPromptSections?: PromptSections;
  readonly proposalConclusion?: PiAgentRuntimeOptions["proposalConclusion"];
  /**
   * Citations from the most recent planner final decision in the PI
   * agent path. Cleared after being attached to the first
   * assistant_text event. The planner stream sets this; mapPiEvent
   * consumes it.
   */
  private pendingCitations: Array<import("../../../shared/wemail/intelligence.js").AgentCitation> | undefined;
  private readonly provider?: string;

  constructor(options: PiAgentRuntimeOptions = {}) {
    this.systemPromptOverride = options.systemPrompt;
    this.skillPrompt = options.skillPrompt;
    this.extraPromptSections = options.extraPromptSections;
    this.proposalConclusion = options.proposalConclusion;
    this.plannerLlm = options.llm;
    this.provider = options.pi?.provider;
    this.plannerModel =
      options.model ?? options.pi?.model ?? "claude-3-5-sonnet";
    if (options.planner) {
      this.planner = options.planner;
    } else if (options.pi) {
      this.pi = options.pi;
    } else if (options.llm) {
      this.planner = createDefaultPlanner({
        llm: options.llm,
        model: this.plannerModel,
        provider: this.provider,
        usage: options.usage,
        systemPrompt: (context) => this.buildSystemPrompt(context),
      });
    } else {
      throw new Error(
        "PiAgentRuntime requires either `planner`, `llm`, or `pi` in options",
      );
    }
    this.piAgentFactory =
      options.piAgentFactory ?? ((agentOptions) => new CorePiAgent(agentOptions));
    this.usage = options.usage;
    this.usePlannerStream = options.usePlannerStream ?? false;
    this.executionLimits = normalizeAgentExecutionLimits({
      ...options.executionLimits,
      maxExactRepeatCalls:
        options.maxExactRepeatCalls ??
        options.executionLimits?.maxExactRepeatCalls,
      maxConsecutiveNoProgress:
        options.maxConsecutiveNoProgress ??
        options.executionLimits?.maxConsecutiveNoProgress,
      maxEmergencyToolCalls:
        options.maxEmergencyToolCalls ??
        options.maxIterations ??
        options.executionLimits?.maxEmergencyToolCalls,
      toolTimeoutMs:
        options.toolTimeoutMs ?? options.executionLimits?.toolTimeoutMs,
      runTimeoutMs:
        options.runTimeoutMs ?? options.executionLimits?.runTimeoutMs,
    });
    this.toolTimeoutMs = this.executionLimits.toolTimeoutMs;
    this.runTimeoutMs = this.executionLimits.runTimeoutMs;
    this.now = options.now ?? (() => Date.now());
  }

  registerTool(tool: AgentTool): void {
    this.tools.set(tool.name, tool);
  }

  listTools() {
    return [
      ...Array.from(this.tools.values()),
      this.terminateTool(),
    ].map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
  }

  private terminateTool(): AgentTool {
    return {
      name: TERMINATE_TOOL_NAME,
      description:
        "Stop the current agent run when required context is unavailable or the request cannot be completed safely.",
      inputSchema: {
        type: "object",
        properties: { reason: { type: "string" } },
        required: ["reason"],
        additionalProperties: false,
      },
      async handler(input) {
        return {
          ok: true,
          reason:
            typeof input.reason === "string" && input.reason.trim()
              ? input.reason
              : "Agent stopped",
        };
      },
      observe(output) {
        const reason = (output as { reason?: unknown }).reason;
        return typeof reason === "string" ? reason : "Agent stopped";
      },
    };
  }

  private resolveTool(name: string): AgentTool | undefined {
    if (name === TERMINATE_TOOL_NAME) return this.terminateTool();
    return this.tools.get(name);
  }

  async *run(input: AgentRunInput): AsyncGenerator<AgentEvent, void, unknown> {
    if (this.pi) {
      yield* this.runWithPi(input, this.pi);
      return;
    }

    if (!this.planner) {
      const reason = "Agent 运行时尚未配置。";
      yield {
        type: "conclusion",
        status: "failed",
        summary: "本次请求未能执行。",
        reason,
      };
      yield { type: "terminate", reason };
      yield { type: "done" };
      return;
    }

    const runStart = this.now();
    let toolExecutionCount = 0;
    let successfulToolCount = 0;
    let artifactDeliveryRepairAttempts = 0;
    const progress = new AgentExecutionProgressTracker(this.executionLimits);
    const repairAttempts = new Map<string, number>();
    const history: PlannerStepInput["history"] = [];
    const mergedContext: Record<string, unknown> = { ...input.context };
    if (input.emailId) mergedContext.emailId = input.emailId;
    if (input.emailIds?.length) mergedContext.emailIds = input.emailIds;
    if (input.accountId) mergedContext.accountId = input.accountId;
    if (input.threadId) mergedContext.threadId = input.threadId;
    const ctx: AgentToolContext = {
      sessionId: input.sessionId,
      runContext: mergedContext,
      signal: input.signal,
    };

    while (true) {
      if (input.signal?.aborted) {
        const reason = "用户取消了本次执行。";
        yield {
          type: "conclusion",
          status: "cancelled",
          summary: "本次执行已取消。",
          reason,
        };
        yield { type: "terminate", reason };
        yield { type: "done" };
        return;
      }
      if (this.now() - runStart > this.runTimeoutMs) {
        const reason = `Agent 整体执行超过 ${Math.ceil(this.runTimeoutMs / 1000)} 秒截止时间，系统已自动中断。`;
        yield {
          type: "conclusion",
          status: "failed",
          summary: "本次执行未完成。",
          reason,
          nextAction: "请保留当前筛选条件后重试，或将任务拆分为较小批次。",
        };
        yield { type: "terminate", reason };
        yield { type: "done" };
        return;
      }

      let decision: PlannerDecision;
      try {
        const remainingRunMs = Math.max(
          1,
          this.runTimeoutMs - (this.now() - runStart),
        );
        decision = await withTimeout(
          this.planner.step({
            userText: input.userText,
            context: mergedContext,
            tools: this.listTools(),
            history,
          }),
          remainingRunMs,
          "agent run",
        );
      } catch (err) {
        if (err instanceof OperationTimeoutError) {
          const reason = `Agent 整体执行超过 ${Math.ceil(this.runTimeoutMs / 1000)} 秒截止时间，系统已自动中断。`;
          yield {
            type: "conclusion",
            status: "failed",
            summary: "本次执行未完成。",
            reason,
            nextAction: "请保留当前筛选条件后重试，或将任务拆分为较小批次。",
          };
          yield { type: "terminate", reason };
          yield { type: "done" };
          return;
        }
        const reason = `规划阶段失败：${(err as Error).message}`;
        yield {
          type: "conclusion",
          status: "failed",
          summary: "本次请求未能执行。",
          reason,
        };
        yield { type: "terminate", reason };
        yield { type: "done" };
        return;
      }

      if (decision.kind === "error") {
        const reason = `规划阶段未能生成有效决策：${decision.message}`;
        yield {
          type: "conclusion",
          status: "failed",
          summary: "本次请求未能执行。",
          reason,
        };
        yield { type: "terminate", reason };
        yield { type: "done" };
        return;
      }
      if (decision.kind === "final") {
        if (
          requestsViewableArtifact(input.userText) &&
          containsCompleteHtmlDocument(decision.text) &&
          !historyHasDeliveredArtifact(history)
        ) {
          if (artifactDeliveryRepairAttempts < 1) {
            artifactDeliveryRepairAttempts += 1;
            history.push({
              type: "tool_result",
              tool: "publish_design_artifact",
              output: {
                ok: false,
                error: "formal-artifact-delivery-required",
                instruction:
                  "Do not return HTML. Call publish_design_artifact with the bounded structured dataset, then summarize the successful artifact result.",
              },
            });
            continue;
          }
          const reason =
            "模型生成了 HTML 源码，但未通过正式产物工具完成持久化与应用消息投递。";
          yield {
            type: "conclusion",
            status: "failed",
            summary: "报表未生成。",
            reason,
            nextAction: "请重试；系统将要求使用正式产物投递链路。",
          };
          yield { type: "terminate", reason };
          yield { type: "done" };
          return;
        }
        if (
          requestsViewableArtifact(input.userText) &&
          toolExecutionCount > 0 &&
          !historyHasDeliveredArtifact(history)
        ) {
          if (artifactDeliveryRepairAttempts < 1) {
            artifactDeliveryRepairAttempts += 1;
            history.push({
              type: "tool_result",
              tool: "publish_design_artifact",
              output: {
                ok: false,
                error: "formal-artifact-delivery-required",
                instruction:
                  "The report was not delivered as an application artifact. Call publish_design_artifact and verify its artifact.applicationMessageId before claiming success.",
              },
            });
            continue;
          }
          const reason =
            "报告未生成：本次运行没有收到可打开的应用消息 artifact。";
          yield {
            type: "conclusion",
            status: "failed",
            summary: "报表未生成。",
            reason,
            nextAction: "请检查报告生成步骤的具体错误后重试。",
          };
          yield { type: "terminate", reason };
          yield { type: "done" };
          return;
        }
        yield { type: "assistant_text", text: decision.text, citations: validateCitations(decision.citations) };
        if (toolExecutionCount > 0) {
          yield {
            type: "conclusion",
            status: "succeeded",
            summary: "本次 Agent 执行已完成。",
          };
        }
        yield { type: "done" };
        return;
      }

      // Tool call
      if (decision.callReason) {
        yield { type: "progress_update", text: decision.callReason };
      }
      const tool = this.resolveTool(decision.tool);
      if (!tool) {
        const errOut = { ok: false, error: `unknown tool: ${decision.tool}` };
        yield {
          type: "tool_call",
          tool: decision.tool,
          input: decision.input,
          callReason: decision.callReason,
        };
        yield {
          type: "tool_result",
          tool: decision.tool,
          output: errOut,
          isError: true,
        };
        history.push({
          type: "tool_call",
          tool: decision.tool,
          input: decision.input,
        });
        history.push({
          type: "tool_result",
          tool: decision.tool,
          output: errOut,
        });
        let assessment = withFailureContext(
          classifyToolFailure(decision.tool, {
            content: [{ type: "text", text: errOut.error }],
          }),
          decision.tool,
          decision.input,
        );
        const repairKey = `${decision.tool}:${assessment.disposition}`;
        const attempts = repairAttempts.get(repairKey) ?? 0;
        if (
          (assessment.disposition === "repairable" ||
            assessment.disposition === "transient") &&
          attempts < PI_MAX_TOOL_REPAIRS
        ) {
          repairAttempts.set(repairKey, attempts + 1);
          yield {
            type: "thinking",
            text: `工具参数未通过校验，正在自动修正（${attempts + 1}/${PI_MAX_TOOL_REPAIRS}）。`,
          };
          continue;
        }
        if (
          assessment.disposition === "repairable" ||
          assessment.disposition === "transient"
        ) {
          assessment = exhaustedRepairAssessment(assessment);
        }
        yield await this.buildFailureConclusion({
          input,
          assessment,
          successfulToolCount,
        });
        yield { type: "terminate", reason: assessment.reason };
        yield { type: "done" };
        return;
      }

      const executionGuard = progress.beforeToolCall(
        tool.name,
        decision.input,
      );
      if (executionGuard) {
        yield {
          type: "conclusion",
          status: "failed",
          summary: "本次执行已被安全保护机制停止。",
          reason: executionGuard.reason,
          nextAction: executionGuard.nextAction,
        };
        yield { type: "terminate", reason: executionGuard.reason };
        yield { type: "done" };
        return;
      }
      toolExecutionCount += 1;
      yield {
        type: "tool_call",
        tool: tool.name,
        input: decision.input,
        callReason: decision.callReason,
      };
      history.push({
        type: "tool_call",
        tool: tool.name,
        input: decision.input,
      });

      let output: unknown;
      let terminalFailure = false;
      try {
        output = await runToolWithTimeout(tool, decision.input, ctx, this.toolTimeoutMs);
      } catch (err) {
        if (err instanceof AgentTerminalToolError) {
          output = err.toFailure();
        } else if (err instanceof OperationTimeoutError) {
          output = new AgentTerminalToolError({
            code: "tool_timeout",
            userMessage: `工具 ${tool.name} 执行超过 ${Math.ceil(err.timeoutMs / 1000)} 秒截止时间。`,
            cause: err,
          }).toFailure();
        } else {
          output = { ok: false, error: (err as Error).message };
        }
        terminalFailure = true;
      }
      terminalFailure = terminalFailure || isFailedToolOutput(output);
      const observation = safeToolObservation(tool, output);
      if (tool.name === TERMINATE_TOOL_NAME) {
        const reason =
          typeof (output as { reason?: unknown }).reason === "string"
            ? ((output as { reason: string }).reason)
            : typeof decision.input.reason === "string"
              ? decision.input.reason
              : "Agent stopped";
        const assessment = classifyToolFailure(tool.name, {
          content: [{ type: "text", text: reason }],
        });
        yield await this.buildFailureConclusion({
          input,
          assessment,
          successfulToolCount,
        });
        yield { type: "terminate", reason: assessment.reason };
        yield { type: "done" };
        return;
      }
      yield {
        type: "tool_result",
        tool: tool.name,
        output,
        ...(observation === undefined ? {} : { observation }),
        ...(terminalFailure ? { isError: true } : {}),
      };
      history.push({ type: "tool_result", tool: tool.name, output });
      const pendingAction = pendingActionFromToolOutput(output);
      if (pendingAction) {
        yield { type: "pending_action", action: pendingAction };
      }
      const businessConclusion = allowanceProposalConclusion(this, tool.name, output);
      if (businessConclusion) {
        yield businessConclusion;
        yield { type: "done" };
        return;
      }

      const progressAssessment = progress.afterToolCall(
        tool.name,
        decision.input,
        output,
        terminalFailure,
      );
      if (progressAssessment.guard) {
        yield {
          type: "conclusion",
          status: "failed",
          summary: "本次执行因连续步骤没有取得新进展而停止。",
          reason: progressAssessment.guard.reason,
          nextAction: progressAssessment.guard.nextAction,
        };
        yield {
          type: "terminate",
          reason: progressAssessment.guard.reason,
        };
        yield { type: "done" };
        return;
      }

      if (terminalFailure) {
        const error =
          typeof (output as { error?: unknown })?.error === "string"
            ? (output as { error: string }).error
            : `工具 ${tool.name} 执行失败`;
        let assessment = withFailureContext(
          classifyToolFailure(tool.name, {
            details: output,
            content: [{ type: "text", text: error }],
          }),
          tool.name,
          decision.input,
        );
        const repairKey = `${tool.name}:${assessment.disposition}`;
        const attempts = repairAttempts.get(repairKey) ?? 0;
        if (
          (assessment.disposition === "repairable" ||
            assessment.disposition === "transient") &&
          attempts < PI_MAX_TOOL_REPAIRS
        ) {
          repairAttempts.set(repairKey, attempts + 1);
          yield {
            type: "thinking",
            text:
              assessment.disposition === "repairable"
                ? `工具参数未通过校验，正在自动修正（${attempts + 1}/${PI_MAX_TOOL_REPAIRS}）。`
                : `外部服务暂时不可用，正在自动重试（${attempts + 1}/${PI_MAX_TOOL_REPAIRS}）。`,
          };
          continue;
        }
        if (
          assessment.disposition === "repairable" ||
          assessment.disposition === "transient"
        ) {
          assessment = exhaustedRepairAssessment(assessment);
        }
        yield await this.buildFailureConclusion({
          input,
          assessment,
          successfulToolCount,
        });
        yield { type: "terminate", reason: assessment.reason };
        yield { type: "done" };
        return;
      }

      successfulToolCount += 1;
    }
  }

  private buildSystemPrompt(context?: Record<string, unknown>): string {
    const skillSection = this.skillPrompt?.(context) ?? "";
    const base = this.systemPromptOverride
      ? this.systemPromptOverride
      : PI_DEFAULT_SYSTEM_PROMPT;
    const skillNotice =
      context && typeof context.skillResolutionIssue === "string"
        ? `SKILL NOTICE: ${context.skillResolutionIssue} Do not claim that the unavailable Skill was applied.`
        : "";
    const channelPrompt = buildChannelAgentSystemPrompt(context);
    const extraSections = (typeof this.extraPromptSections === "function"
      ? this.extraPromptSections(context)
      : this.extraPromptSections
    )?.filter((section) => section.trim().length > 0) ?? [];
    return [
      base,
      ...(skillSection ? [skillSection] : []),
      ...(skillNotice ? [skillNotice] : []),
      ...(channelPrompt ? [channelPrompt] : []),
      ...extraSections,
    ].join("\n\n");
  }

  private async buildFailureConclusion(args: {
    input: AgentRunInput;
    assessment: AgentFailureAssessment;
    successfulToolCount: number;
  }): Promise<Extract<AgentEvent, { type: "conclusion" }>> {
    const fallback: Extract<AgentEvent, { type: "conclusion" }> = {
      type: "conclusion",
      status: args.assessment.status,
      summary:
        args.assessment.status === "blocked"
          ? "本次操作未执行。"
          : args.assessment.status === "needs_input"
            ? "需要补充信息后才能继续。"
            : args.assessment.status === "cancelled"
              ? "本次执行已取消。"
            : "本次执行未完成。",
      reason: args.assessment.reason,
      impact: args.assessment.impact,
      ...(args.assessment.nextAction
        ? { nextAction: args.assessment.nextAction }
        : {}),
      ...(args.assessment.failureContext
        ? { failureContext: args.assessment.failureContext }
        : {}),
    };
    // Failure conclusions are host-owned. A model must not reinterpret a
    // stable tool error into an unsupported root-cause narrative.
    return fallback;
  }

  private toCoreTool(
    tool: AgentTool,
    ctx: AgentToolContext,
    onRetry?: (notice: RetryNotice) => void,
  ): CorePiAgentTool {
    return {
      name: tool.name,
      label: tool.name,
      description: tool.description,
      parameters: tool.inputSchema as TSchema,
      execute: async (_toolCallId, params, signal) => {
        if (signal?.aborted) {
          throw new Error("Agent run aborted");
        }
        let output: unknown;
        try {
          output = await retryAgentOperation({
            capability: isApprovedIdempotentReadTool(tool.name)
              ? "idempotent_read"
              : "unsafe_mutation",
            signal,
            isTransient: isTransientAgentError,
            onNotice: onRetry,
            operation: () => runToolWithTimeout(
              tool,
              (params ?? {}) as ToolInput,
              { ...ctx, signal: signal ?? ctx.signal },
              this.toolTimeoutMs,
            ),
          });
        } catch (err) {
          if (err instanceof AgentTerminalToolError) {
            const failure = err.toFailure();
            return {
              content: [{ type: "text", text: failure.error }],
              details: failure,
              terminate: true,
            };
          }
          if (err instanceof OperationTimeoutError) {
            const failure = new AgentTerminalToolError({
              code: "tool_timeout",
              userMessage: `工具 ${tool.name} 执行超过 ${Math.ceil(err.timeoutMs / 1000)} 秒截止时间。`,
              cause: err,
            }).toFailure();
            return {
              content: [{ type: "text", text: failure.error }],
              details: failure,
              terminate: true,
            };
          }
          throw err;
        }
        if (
          output &&
          typeof output === "object" &&
          (output as { ok?: unknown; error?: unknown }).ok === false
        ) {
          const message = (output as { error?: unknown }).error;
          return {
            content: [{
              type: "text",
              text: typeof message === "string" ? message : `tool ${tool.name} failed`,
            }],
            details: output,
            isError: true,
          };
        }
        return {
          content: [{ type: "text", text: toolResultText(output) }],
          details: output,
          ...(tool.name === TERMINATE_TOOL_NAME ? { terminate: true } : {}),
        };
      },
      executionMode:
        tool.name === TERMINATE_TOOL_NAME ||
        tool.name.startsWith("propose_") ||
        tool.name === "compose_mail" ||
        tool.name.startsWith("trigger_") ||
        tool.name === "retry_intelligence" ||
        tool.name.startsWith("wecli_")
          ? "sequential"
          : "parallel",
    };
  }

  private mapPiEvent(event: CorePiAgentEvent): AgentEvent[] {
    if (event.type === "message_update") {
      const assistantEvent = event.assistantMessageEvent;
      if (assistantEvent.type === "thinking_start") {
        return [
          {
            type: "reasoning_start",
            contentIndex: assistantEvent.contentIndex ?? 0,
          },
        ];
      }
      if (assistantEvent.type === "thinking_delta" && assistantEvent.delta) {
        return [
          {
            type: "reasoning_delta",
            contentIndex: assistantEvent.contentIndex ?? 0,
            text: assistantEvent.delta,
          },
        ];
      }
      if (assistantEvent.type === "thinking_end") {
        return [
          {
            type: "reasoning_end",
            contentIndex: assistantEvent.contentIndex ?? 0,
            text: assistantEvent.content,
          },
        ];
      }
      if (assistantEvent.type === "text_start") {
        return [
          {
            type: "text_start",
            contentIndex: assistantEvent.contentIndex ?? 0,
          },
        ];
      }
      if (assistantEvent.type === "text_delta" && assistantEvent.delta) {
        // Attach pending citations from the planner's final decision
        // and clear them so they are only attached once
        const citations = validateCitations(this.pendingCitations);
        this.pendingCitations = undefined;
        return [
          {
            type: "text_delta",
            contentIndex: assistantEvent.contentIndex ?? 0,
            text: assistantEvent.delta,
            ...(citations ? { citations } : {}),
          },
        ];
      }
      if (assistantEvent.type === "text_end") {
        const citations = validateCitations(this.pendingCitations);
        this.pendingCitations = undefined;
        return [
          {
            type: "text_end",
            contentIndex: assistantEvent.contentIndex ?? 0,
            text: assistantEvent.content,
            ...(citations ? { citations } : {}),
          },
        ];
      }
    }
    if (event.type === "tool_execution_start") {
      return [
        {
          type: "tool_call",
          tool: event.toolName,
          input: (event.args ?? {}) as ToolInput,
          ...(event.toolCallId ? { toolCallId: event.toolCallId } : {}),
        },
      ];
    }
    if (event.type === "tool_execution_update") {
      const result = event.partialResult as { details?: unknown } | undefined;
      const output = result && "details" in result ? result.details : event.partialResult;
      const tool = this.resolveTool(event.toolName);
      const observation = safeToolObservation(tool, output);
      return [{
        type: "tool_update",
        tool: event.toolName,
        output,
        ...(event.toolCallId ? { toolCallId: event.toolCallId } : {}),
        ...(observation === undefined ? {} : { observation }),
      }];
    }
    if (event.type === "tool_execution_end") {
      const result = event.result as { details?: unknown } | undefined;
      if (event.toolName === TERMINATE_TOOL_NAME) {
        const details = result && "details" in result ? result.details : event.result;
        const reason =
          typeof (details as { reason?: unknown })?.reason === "string"
            ? ((details as { reason: string }).reason)
            : "Agent stopped";
        return [{ type: "terminate", reason }];
      }
      const rawOutput = result && "details" in result ? result.details : event.result;
      const rawTerminalFailure = isAgentTerminalToolFailure(rawOutput);
      const failure = event.isError && !rawTerminalFailure
        ? genericToolFailure(event.toolName, event.result)
        : undefined;
      const output = rawTerminalFailure ? rawOutput : failure?.output ?? rawOutput;
      const tool = this.resolveTool(event.toolName);
      const observation = safeToolObservation(tool, output);
      const events: AgentEvent[] = [];
      const terminalFailure = isAgentTerminalToolFailure(output);
      const pendingAction = pendingActionFromToolOutput(output);
      if (pendingAction) {
        events.push({ type: "pending_action", action: pendingAction });
      }
      events.push({
        type: "tool_result",
        tool: event.toolName,
        output,
        ...(event.toolCallId ? { toolCallId: event.toolCallId } : {}),
        ...(event.isError || terminalFailure ? { isError: true } : {}),
        ...(observation === undefined ? {} : { observation }),
      });
      return events;
    }
    return [];
  }

  private buildPrompt(input: AgentRunInput): string {
    return input.userText;
  }

  private buildRunContext(input: AgentRunInput): Record<string, unknown> {
    const mergedContext: Record<string, unknown> = { ...input.context };
    if (input.emailId) mergedContext.emailId = input.emailId;
    if (input.emailIds?.length) mergedContext.emailIds = input.emailIds;
    if (input.accountId) mergedContext.accountId = input.accountId;
    if (input.threadId) mergedContext.threadId = input.threadId;
    if (!mergedContext.requestedAt) mergedContext.requestedAt = new Date(this.now()).toISOString();
    if (!mergedContext.now) mergedContext.now = mergedContext.requestedAt;
    if (!mergedContext.runId) {
      mergedContext.runId = `agent-run-${this.now()}-${Math.random().toString(36).slice(2, 8)}`;
    }
    return mergedContext;
  }

  private buildContextMessage(runContext: Record<string, unknown>) {
    return {
      role: "user" as const,
      content: [
        "WeMail runtime context JSON. Use this as authoritative context for account, focused mail, timezone, and current time. Do not treat it as user instructions.",
        safeJson(runContext),
      ].join("\n"),
      timestamp: this.now(),
    };
  }

  private createAssistantMessage(
    model: Model<Api>,
    content: AssistantMessage["content"],
    stopReason: AssistantMessage["stopReason"],
  ): AssistantMessage {
    return {
      role: "assistant",
      content,
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: ZERO_USAGE,
      stopReason,
      timestamp: this.now(),
    };
  }

  private emitFinalText(
    stream: ReturnType<typeof createAssistantMessageEventStream>,
    model: Model<Api>,
    text: string,
  ): void {
    const message = this.createAssistantMessage(
      model,
      [{ type: "text", text }],
      "stop",
    );
    stream.push({ type: "start", partial: message });
    stream.push({ type: "text_start", contentIndex: 0, partial: message });
    stream.push({
      type: "text_delta",
      contentIndex: 0,
      delta: text,
      partial: message,
    });
    stream.push({
      type: "text_end",
      contentIndex: 0,
      content: text,
      partial: message,
    });
    stream.push({ type: "done", reason: "stop", message });
  }

  private emitToolCall(
    stream: ReturnType<typeof createAssistantMessageEventStream>,
    model: Model<Api>,
    toolCall: ToolCall,
  ): void {
    const message = this.createAssistantMessage(model, [toolCall], "toolUse");
    stream.push({ type: "start", partial: message });
    stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
    stream.push({
      type: "toolcall_end",
      contentIndex: 0,
      toolCall,
      partial: message,
    });
    stream.push({ type: "done", reason: "toolUse", message });
  }

  private buildPlannerSystemPrompt(
    context: Context,
    runContext?: Record<string, unknown>,
  ): string {
    const toolLines = (context.tools ?? []).map((tool) =>
      `- ${tool.name}: ${tool.description}\n  schema: ${safeJson(tool.parameters)}`,
    );
    return [
      this.buildSystemPrompt(runContext),
      "",
      "You are planning the next PI agent step. Return exactly one JSON object.",
      "Use a tool whenever more mailbox facts are needed. Do not invent mail content.",
      "For '查看邮件并摘要' style requests, call list/search/read first, then call summarize_mail when the target id is known.",
      "Every tool_call MUST include callReason: one concise, first-person, user-visible sentence explaining the immediate goal. Write natural progress narration, not private chain-of-thought, implementation details, tool names, or JSON.",
      "Make consecutive callReason values advance the story: establish scope, gather evidence, analyze, create, then verify. Do not repeat the same sentence.",
      "Decision schema:",
      '{"kind":"tool_call","tool":"<tool name>","input":{...},"callReason":"short user-visible rationale"}',
      '{"kind":"final","text":"<answer grounded in tool results>","citations":[{"emailId":"<id>","tool":"<tool name>","path":"<dot path>"}]}',
      "Citations are REQUIRED when the final text states facts from email content, but they are structured internal metadata and must not be copied into the final text. Each citation must have emailId and tool; path is optional.",
      "Available tools:",
      ...toolLines,
    ].join("\n");
  }

  private messageText(message: Message): string {
    if (typeof message.content === "string") return message.content;
    return message.content
      .map((content) => {
        if (content.type === "text") return content.text;
        if (content.type === "toolCall") {
          return `CALL ${content.name} ${safeJson(content.arguments)}`;
        }
        if (content.type === "image") return "[image]";
        if (content.type === "thinking") return "";
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }

  private buildPlannerTranscript(context: Context): string {
    const lines = context.messages.map((message) => {
      if (message.role === "user") {
        return `USER ${this.messageText(message)}`;
      }
      if (message.role === "assistant") {
        return `ASSISTANT ${this.messageText(message)}`;
      }
      return [
        `RESULT ${message.toolName}`,
        this.messageText(message),
        message.details === undefined ? "" : `DETAILS ${safeJson(message.details)}`,
      ]
        .filter(Boolean)
        .join("\n");
    });
    const transcript = lines.join("\n\n");
    return transcript.length > PLANNER_TRANSCRIPT_LIMIT
      ? `${transcript.slice(-PLANNER_TRANSCRIPT_LIMIT)}`
      : transcript;
  }

  private parsePlannerDecision(text: string): PlannerDecision {
    try {
      const trimmed = text.trim();
      const jsonText = trimmed.startsWith("{")
        ? trimmed
        : trimmed.slice(trimmed.indexOf("{"), trimmed.lastIndexOf("}") + 1);
      const parsed = JSON.parse(jsonText) as {
        kind?: string;
        tool?: string;
        input?: ToolInput;
        text?: string;
        callReason?: string;
        citations?: Array<{ emailId?: unknown; tool?: unknown; path?: unknown }>;
      };
      if (parsed.kind === "final" && typeof parsed.text === "string") {
        const citations = Array.isArray(parsed.citations)
          ? parsed.citations.filter(
              (c): c is import("../../../shared/wemail/intelligence.js").AgentCitation =>
                typeof c.emailId === "string" && typeof c.tool === "string",
            )
          : undefined;
        return { kind: "final", text: parsed.text, citations };
      }
      if (parsed.kind === "tool_call" && typeof parsed.tool === "string") {
        return {
          kind: "tool_call",
          tool: parsed.tool,
          input: (parsed.input ?? {}) as ToolInput,
          callReason: userVisibleProgressForTool(
            parsed.tool,
            typeof parsed.callReason === "string"
              ? parsed.callReason
              : undefined,
          ),
        };
      }
      return { kind: "error", message: "planner produced no decision" };
    } catch (err) {
      return {
        kind: "error",
        message: `planner JSON parse failed: ${(err as Error).message}`,
      };
    }
  }

  private plannerJsonSchema(): JsonSchema {
    return {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: ["tool_call", "final"],
        },
        tool: { type: "string" },
        input: { type: "object" },
        text: { type: "string" },
        callReason: { type: "string" },
        citations: {
          type: "array",
          items: {
            type: "object",
            properties: {
              emailId: { type: "string" },
              tool: { type: "string" },
              path: { type: "string" },
            },
            required: ["emailId", "tool"],
          },
        },
      },
      required: ["kind"],
      additionalProperties: false,
    };
  }

  private async requestPlannerDecision(args: {
    llm: LlmClient;
    modelName: string;
    context: Context;
    runContext?: Record<string, unknown>;
    accountId: string;
    sessionId?: string;
    signal?: AbortSignal;
  }): Promise<PlannerDecision> {
    const transcript = this.buildPlannerTranscript(args.context);
    const system = this.buildPlannerSystemPrompt(args.context, args.runContext);
    const res = await args.llm.generate({
      model: args.modelName,
      system,
      jsonSchema: this.plannerJsonSchema(),
      messages: [
        {
          role: "user",
          content: [
            "Return JSON only. No prose, no markdown, no code fence.",
            "Conversation transcript:",
            transcript,
          ].join("\n\n"),
        },
      ],
      signal: args.signal,
    });
    this.usage?.record({
      accountId: args.accountId,
      category: "agent_chat",
      processor: "agent",
      inputTokens: res.usage?.inputTokens ?? 0,
      outputTokens: res.usage?.outputTokens ?? 0,
      model: args.modelName,
      provider: this.provider,
      sessionId: args.sessionId,
    });
    const decision = this.parsePlannerDecision(res.text);
    if (decision.kind !== "error") return decision;

    const repaired = await args.llm.generate({
      model: args.modelName,
      system: [
        "You are a strict JSON repair adapter for PI.",
        "Convert the previous invalid planner output into exactly one valid JSON decision.",
        "Do not answer the user. Do not explain. Output JSON only.",
        system,
      ].join("\n"),
      jsonSchema: this.plannerJsonSchema(),
      messages: [
        {
          role: "user",
          content: [
            "Invalid planner output:",
            res.text,
            "",
            "Conversation transcript:",
            transcript,
          ].join("\n"),
        },
      ],
      signal: args.signal,
    });
    this.usage?.record({
      accountId: args.accountId,
      category: "agent_chat",
      processor: "agent",
      inputTokens: repaired.usage?.inputTokens ?? 0,
      outputTokens: repaired.usage?.outputTokens ?? 0,
      model: args.modelName,
      provider: this.provider,
      sessionId: args.sessionId,
    });
    return this.parsePlannerDecision(repaired.text);
  }

  private createPlannerStreamFn(
    llm: LlmClient,
    modelName: string,
    accountId: string,
    runContext: Record<string, unknown>,
    sessionId?: string,
    onProgress?: (text: string) => void,
    onRetry?: (notice: RetryNotice) => void,
  ): StreamFn {
    let toolCallSeq = 0;
    return (model, context, options) => {
      const stream = createAssistantMessageEventStream();
      void (async () => {
        try {
          const decision = await retryAgentOperation({
            capability: "model",
            signal: options?.signal,
            isTransient: isTransientAgentError,
            onNotice: onRetry,
            operation: () => this.requestPlannerDecision({
              llm,
              modelName,
              context,
              runContext,
              accountId,
              sessionId,
              signal: options?.signal,
            }),
          });
          if (decision.kind === "final") {
            if (decision.citations) {
              this.pendingCitations = decision.citations;
            }
            this.emitFinalText(stream, model as Model<Api>, decision.text);
            return;
          }
          if (decision.kind === "tool_call") {
            if (decision.callReason) onProgress?.(decision.callReason);
            this.emitToolCall(stream, model as Model<Api>, {
              type: "toolCall",
              id: `wemail_tool_${this.now()}_${++toolCallSeq}`,
              name: decision.tool,
              arguments: decision.input,
            });
            return;
          }
          this.emitFinalText(stream, model as Model<Api>, decision.message);
        } catch (err) {
          const message = this.createAssistantMessage(
            model as Model<Api>,
            [{ type: "text", text: `PI planner error: ${(err as Error).message}` }],
            "error",
          );
          stream.push({ type: "start", partial: message });
          stream.push({
            type: "error",
            reason: "error",
            error: {
              ...message,
              errorMessage: (err as Error).message,
            },
          });
        }
      })();
      return stream;
    };
  }

  private async *runWithPi(
    input: AgentRunInput,
    pi: PiModelConfig,
  ): AsyncGenerator<AgentEvent, void, unknown> {
    this.pendingCitations = undefined;
    const queue = new AsyncEventQueue<AgentEvent>();
    const mergedContext = this.buildRunContext(input);
    const ctx: AgentToolContext = {
      sessionId: input.sessionId,
      runContext: mergedContext,
      signal: input.signal,
    };
    let emittedUserVisibleEvent = false;
    let terminationEmitted = false;
    let conclusionEmitted = false;
    let toolCallCount = 0;
    let successfulToolCount = 0;
    let deliveredArtifact = false;
    let artifactPublishAttempted = false;
    let pendingActionCreated = false;
    let businessResultCompleted = false;
    const progress = new AgentExecutionProgressTracker(this.executionLimits);
    const repairAttempts = new Map<string, number>();
    const activeRepairAttempts = new Map<string, number>();
    const toolInputs = new Map<string, ToolInput>();
    let agent: PiAgentLike | undefined;
    let terminalAssessment: AgentFailureAssessment | undefined;
    let finalizationPromise: Promise<void> | undefined;
    let abortRequested = false;

    const abortAgent = () => {
      if (abortRequested || !agent) return;
      abortRequested = true;
      agent.abort?.();
    };

    const emitConclusion = (
      conclusion: Extract<AgentEvent, { type: "conclusion" }>,
    ) => {
      if (conclusionEmitted) return;
      conclusionEmitted = true;
      emittedUserVisibleEvent = true;
      queue.push(conclusion);
    };

    const requestTermination = (
      assessment: AgentFailureAssessment,
    ): Promise<void> => {
      if (terminalAssessment) {
        return finalizationPromise ?? Promise.resolve();
      }
      terminalAssessment = assessment;
      abortAgent();
      finalizationPromise = (async () => {
        const conclusion = await this.buildFailureConclusion({
          input,
          assessment,
          successfulToolCount,
        });
        emitConclusion(conclusion);
        terminationEmitted = true;
        emittedUserVisibleEvent = true;
        queue.push({ type: "terminate", reason: assessment.reason });
      })();
      return finalizationPromise;
    };

    const emitTermination = (
      reason: string,
      status: Extract<
        AgentEvent,
        { type: "conclusion" }
      >["status"] = "failed",
      nextAction?: string,
    ) => {
      const disposition: AgentFailureDisposition =
        status === "blocked"
          ? "blocked"
          : status === "needs_input"
            ? "needs_input"
            : status === "cancelled"
              ? "cancelled"
              : "terminal";
      void requestTermination({
        disposition,
        status,
        code: `agent_${status}`,
        technicalDetail: reason,
        reason,
        impact:
          status === "cancelled"
            ? "取消后的后续步骤未执行。"
            : "失败步骤及其后续操作未执行。",
        ...(nextAction ? { nextAction } : {}),
      });
    };

    agent = this.piAgentFactory({
      initialState: {
        systemPrompt: this.buildSystemPrompt(mergedContext),
        model: createPiModel(pi),
        thinkingLevel: "off",
        tools: [...Array.from(this.tools.values()), this.terminateTool()].map((tool) =>
          this.toCoreTool(tool, ctx, (notice) => queue.push(retryNoticeEvent(notice))),
        ),
        messages: [],
      },
      getApiKey: () => pi.apiKey,
      streamFn: this.usePlannerStream && this.plannerLlm
          ? this.createPlannerStreamFn(
            this.plannerLlm,
            this.plannerModel ?? pi.model,
            typeof mergedContext.accountId === "string"
              ? mergedContext.accountId
              : input.accountId ?? "local",
            mergedContext,
            input.sessionId,
            (text) => {
              emittedUserVisibleEvent = true;
              queue.push({ type: "progress_update", text });
            },
            (notice) => queue.push(retryNoticeEvent(notice)),
          )
        : undefined,
      transformContext: async (messages) => [
        this.buildContextMessage(mergedContext),
        ...messages,
      ],
      beforeToolCall: async (context, signal) => {
        const toolName = context.toolCall.name;
        if (businessResultCompleted) return { block: true, reason: "附件状态检查已完成，请等待用户决定是否重新尝试。" };
        if (signal?.aborted) {
          return { block: true, reason: "Agent run aborted" };
        }

        const executionGuard = progress.beforeToolCall(
          toolName,
          context.args,
        );
        if (executionGuard) {
          emitTermination(
            executionGuard.reason,
            "failed",
            executionGuard.nextAction,
          );
          return { block: true, reason: executionGuard.reason };
        }
        toolCallCount += 1;
        if (toolName === "publish_design_artifact") artifactPublishAttempted = true;

        const operationPolicy = directToolPolicy(
          toolName,
          context.args && typeof context.args === "object"
            ? context.args as Record<string, unknown>
            : {},
        );
        if (operationPolicy.disposition === "confirmation_required") {
          return {
            block: true,
            reason: `${operationPolicy.reason} Use the matching propose_* domain tool for user confirmation.`,
          };
        }
        return undefined;
      },
      afterToolCall: async (context) => {
        const details = context.result.details;
        const progressAssessment = progress.afterToolCall(
          context.toolCall.name,
          context.args,
          details,
          context.isError || isFailedToolOutput(details),
        );
        if (progressAssessment.guard) {
          return {
            details: {
              ok: false,
              terminal: true,
              code: `agent_${progressAssessment.guard.kind}`,
              error: progressAssessment.guard.reason,
            },
            content: [{ type: "text", text: progressAssessment.guard.reason }],
            isError: true,
            terminate: true,
          };
        }
        if (context.isError) {
          const assessment = classifyToolFailure(
            context.toolCall.name,
            context.result,
          );
          if (
            assessment.disposition !== "repairable" &&
            assessment.disposition !== "transient"
          ) {
            return {
              details,
              content: context.result.content,
              isError: true,
              terminate: true,
            };
          }
          return {
            details,
            content: context.result.content,
            isError: true,
          };
        }
        if (isAgentTerminalToolFailure(details)) {
          return {
            details,
            content: context.result.content,
            isError: true,
            terminate: true,
          };
        }
        const tool = this.resolveTool(context.toolCall.name);
        const observation = safeToolObservation(tool, details);
        if (!observation) return undefined;
        return {
          details,
          content: context.result.content,
          isError: context.isError,
        };
      },
      sessionId: input.sessionId,
      toolExecution: "sequential",
    });
    const unsubscribe = agent.subscribe((event) => {
      if (terminalAssessment || businessResultCompleted) return;

      if (event.type === "tool_execution_start") {
        const key = event.toolCallId || event.toolName;
        toolInputs.set(key, (event.args ?? {}) as ToolInput);
      }

      // Record per-turn LLM usage for the native PI path. The planner-stream
      // path records its own usage inside requestPlannerDecision, and its
      // synthetic assistant messages carry ZERO_USAGE, so this hook is gated
      // off when usePlannerStream is on to avoid double-counting / zero rows.
      // Each assistant message corresponds to exactly one model call, so this
      // attributes every agent_chat token to the bucket the UI groups by.
      if (event.type === "message_end" && !this.usePlannerStream && this.usage) {
        const assistantMessage = event.message;
        if (assistantMessage && assistantMessage.role === "assistant") {
          const accountId =
            typeof mergedContext.accountId === "string"
              ? mergedContext.accountId
              : (input.accountId ?? "local");
          const messageUsage = assistantMessage.usage;
          this.usage.record({
            accountId,
            category: "agent_chat",
            processor: "agent",
            inputTokens: messageUsage.input ?? 0,
            outputTokens: messageUsage.output ?? 0,
            model: assistantMessage.model ?? pi.model,
            provider: assistantMessage.provider ?? this.provider,
            sessionId: input.sessionId,
          });
        }
      }

      const mappedEvents = this.mapPiEvent(event);
      let failedToolResult:
        | Extract<AgentEvent, { type: "tool_result" }>
        | undefined;
      for (const mapped of mappedEvents) {
        if (mapped.type === "terminate") {
          void requestTermination(
            classifyToolFailure(event.type === "tool_execution_end" ? event.toolName : TERMINATE_TOOL_NAME, {
              content: [{ type: "text", text: mapped.reason }],
            }),
          );
          continue;
        }
        if (mapped.type !== "done") {
          emittedUserVisibleEvent = true;
        }
        if (mapped.type === "tool_result" && !mapped.isError) {
          successfulToolCount += 1;
          if (
            mapped.tool === "publish_design_artifact" &&
            toolResultHasDeliveredArtifact(mapped.output)
          ) {
            deliveredArtifact = true;
          }
        }
        if (mapped.type === "tool_result" && mapped.isError) {
          failedToolResult = mapped;
        }
        if (mapped.type === "pending_action") {
          pendingActionCreated = true;
        }
        queue.push(mapped);
        if (mapped.type === "tool_result" && !mapped.isError) {
          const conclusion = allowanceProposalConclusion(this, mapped.tool, mapped.output);
          if (conclusion) {
            businessResultCompleted = true;
            emitConclusion(conclusion);
            abortAgent();
            return;
          }
        }
      }

      if (event.type === "tool_execution_end" && !event.isError && !failedToolResult) {
        const completedAttempt = activeRepairAttempts.get(event.toolName);
        if (completedAttempt !== undefined) {
          activeRepairAttempts.delete(event.toolName);
          queue.push({ type: "retry_completed", attempt: completedAttempt });
        }
      }

      if (event.type === "tool_execution_end" && (event.isError || failedToolResult)) {
        const toolInput =
          toolInputs.get(event.toolCallId || event.toolName) ??
          toolInputs.get(event.toolName);
        let assessment = withFailureContext(
          classifyToolFailure(event.toolName, event.result),
          event.toolName,
          toolInput,
          event.toolCallId,
        );
        if (
          assessment.disposition === "repairable" ||
          assessment.disposition === "transient"
        ) {
          const repairKey = `${event.toolName}:${assessment.disposition}`;
          const attempts = repairAttempts.get(repairKey) ?? 0;
          if (attempts < PI_MAX_TOOL_REPAIRS) {
            const attempt = attempts + 1;
            repairAttempts.set(repairKey, attempt);
            activeRepairAttempts.set(event.toolName, attempt);
            queue.push({
              type: "retry_scheduled",
              attempt,
              delayMs: 0,
              reason: assessment.reason,
            });
            queue.push({
              type: "retry_started",
              attempt,
              maxAttempts: PI_MAX_TOOL_REPAIRS,
            });
            queue.push({
              type: "thinking",
              text:
                assessment.disposition === "repairable"
                  ? `工具参数未通过校验，正在自动修正（${attempt}/${PI_MAX_TOOL_REPAIRS}）。`
                  : `外部服务暂时不可用，正在自动重试（${attempt}/${PI_MAX_TOOL_REPAIRS}）。`,
            });
            return;
          }
          const failedAttempt = activeRepairAttempts.get(event.toolName) ?? attempts;
          activeRepairAttempts.delete(event.toolName);
          queue.push({
            type: "retry_failed",
            attempt: failedAttempt,
            message: assessment.reason,
          });
          assessment = exhaustedRepairAssessment(assessment);
        }
        void requestTermination(assessment);
      }
    });

    const onInputAbort = () => {
      emitTermination("用户取消了本次执行。", "cancelled");
      abortAgent();
    };
    if (input.signal?.aborted) {
      onInputAbort();
    } else {
      input.signal?.addEventListener("abort", onInputAbort, { once: true });
    }

    const promptPromise = input.signal?.aborted
      ? Promise.resolve()
      : withTimeout(
          (async () => {
            await agent.prompt(this.buildPrompt(input));
            if (
            !terminalAssessment && !businessResultCompleted &&
            requestsViewableArtifact(input.userText) &&
            this.tools.has("publish_design_artifact") &&
            successfulToolCount > 0 &&
            !deliveredArtifact
            ) {
              await agent.prompt(ARTIFACT_REPAIR_PROMPT);
            }
          })(),
          this.runTimeoutMs,
          "agent run",
          abortAgent,
        );

    void promptPromise
      .catch((err) => {
        if (terminalAssessment || businessResultCompleted) return;
        if (err instanceof OperationTimeoutError) {
          emitTermination(
            `Agent 整体执行超过 ${Math.ceil(err.timeoutMs / 1000)} 秒截止时间，系统已调用 abort 自动中断。`,
            "failed",
            "请保留当前筛选条件后重试，或将任务拆分为较小批次。",
          );
          return;
        }
        emitTermination(
          `Agent 运行失败：${(err as Error).message}`,
        );
        abortAgent();
      })
      .finally(async () => {
        unsubscribe();
        input.signal?.removeEventListener("abort", onInputAbort);
        if (finalizationPromise) {
          await finalizationPromise;
        } else if (
          !terminationEmitted && !businessResultCompleted &&
          (toolCallCount > 0 || successfulToolCount > 0)
        ) {
          if (
            successfulToolCount > 0 &&
            (!requestsViewableArtifact(input.userText) || deliveredArtifact)
          ) {
            emitConclusion({
              type: "conclusion",
              status: "succeeded",
              summary: pendingActionCreated
                ? "已生成待确认操作，等待你的确认后执行。"
                : "本次 Agent 执行已完成。",
            });
          } else {
            emitTermination(
              requestsViewableArtifact(input.userText)
                ? artifactPublishAttempted
                  ? "报告发布未完成：没有收到可打开的应用消息 artifact。"
                  : "报告未生成：本次运行没有执行报告发布步骤。"
                : "工具调用没有返回有效的执行结果。",
              "failed",
              requestsViewableArtifact(input.userText)
                ? "请检查报告生成步骤的具体错误后重试。"
                : "请检查工具状态后重试。",
            );
          }
        } else if (!emittedUserVisibleEvent) {
          const reason = "Agent 未返回任何可展示内容，可能是模型服务未正常响应。";
          emitTermination(
            reason,
            "failed",
            "请检查模型服务状态后重试。",
          );
        }
        if (finalizationPromise) {
          await finalizationPromise;
        }
        queue.push({ type: "done" });
        queue.close();
      });

    for await (const event of queue) {
      yield event;
    }
  }
}
