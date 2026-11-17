import type { AgentEvent } from "../../../shared/wemail/agent.js";
import type {
  AgentJsonValue,
  WemailAgentArtifact,
  WemailAgentCitation,
  WemailAgentEvent,
  WemailAgentEventBase,
} from "../../../shared/wemail/agentProtocol.js";
import type { AgentPendingAction } from "../../../shared/wemail/intelligence.js";
import { extractToolCitations } from "./AgentToolCitationExtractor.js";

/**
 * Host-owned context used while translating one PI event. Deliberately does
 * not reference PI SDK types so upgrades remain isolated to implementations.
 */
export interface PiEventAdapterContext {
  conversationId: string;
  runId: string;
  messageId?: string;
  nextSequence(): number;
  now(): string;
}

/**
 * Boundary between the PI SDK and WeMail AgentEvent v1.
 *
 * Implementations accept `unknown` so PI types cannot leak into routes,
 * persistence, shared contracts, or renderer code.
 */
export interface PiToWemailEventAdapter {
  map(event: unknown, context: PiEventAdapterContext): readonly WemailAgentEvent[];
}

const CONFIRMATION_TTL_MS = 15 * 60 * 1_000;

function eventBase(context: PiEventAdapterContext): WemailAgentEventBase {
  return {
    schemaVersion: 1,
    conversationId: context.conversationId,
    runId: context.runId,
    ...(context.messageId ? { messageId: context.messageId } : {}),
    sequence: context.nextSequence(),
    timestamp: context.now(),
  };
}

function jsonValue(
  value: unknown,
  seen = new WeakSet<object>(),
  depth = 0,
): AgentJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) {
    if (depth >= 8 || seen.has(value)) return [];
    seen.add(value);
    return value.map((entry) => jsonValue(entry, seen, depth + 1));
  }
  if (value && typeof value === "object") {
    if (depth >= 8 || seen.has(value)) return {};
    seen.add(value);
    const output: Record<string, AgentJsonValue> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (entry === undefined || typeof entry === "function" || typeof entry === "symbol") {
        continue;
      }
      output[key] = jsonValue(entry, seen, depth + 1);
    }
    return output;
  }
  return null;
}

function jsonRecord(value: unknown): Record<string, AgentJsonValue> {
  const converted = jsonValue(value);
  return converted && typeof converted === "object" && !Array.isArray(converted)
    ? converted
    : {};
}

const PUBLIC_TOOL_INPUT_KEYS = new Set([
  "action",
  "attachmentCount",
  "count",
  "date",
  "endDate",
  "folder",
  "folderName",
  "format",
  "hasMore",
  "label",
  "language",
  "limit",
  "mode",
  "operation",
  "page",
  "query",
  "recipientCount",
  "resultCount",
  "startDate",
  "status",
  "tag",
]);

function projectToolInput(value: unknown): Record<string, AgentJsonValue> {
  const source = jsonRecord(value);
  const projected: Record<string, AgentJsonValue> = {};
  for (const [key, item] of Object.entries(source)) {
    if (!PUBLIC_TOOL_INPUT_KEYS.has(key)) continue;
    if (typeof item === "string") projected[key] = item.slice(0, 160);
    else if (typeof item === "number" || typeof item === "boolean" || item === null) {
      projected[key] = item;
    }
  }
  if (typeof source.title === "string") projected.titlePresent = true;
  if (typeof source.datasetId === "string") projected.datasetIdPresent = true;
  if (source.dataset && typeof source.dataset === "object") projected.datasetInline = true;
  if (typeof source.autoPivot === "boolean") projected.autoPivot = source.autoPivot;
  if (source.analysisPlan && typeof source.analysisPlan === "object") projected.analysisPlanPresent = true;
  if (Array.isArray(source.charts)) projected.chartCount = source.charts.length;
  if (typeof source.reportId === "string") projected.reportIdPresent = true;
  return projected;
}

function artifactFromToolResult(
  tool: string,
  output: unknown,
): WemailAgentArtifact | undefined {
  if (tool !== "publish_design_artifact" || !output || typeof output !== "object") {
    return undefined;
  }
  const artifact = (output as { artifact?: unknown }).artifact;
  if (!artifact || typeof artifact !== "object") return undefined;
  const candidate = artifact as Partial<WemailAgentArtifact>;
  if (
    typeof candidate.artifactId !== "string" ||
    typeof candidate.version !== "number" ||
    !["brief", "report", "dashboard", "deck"].includes(candidate.kind ?? "") ||
    typeof candidate.contentHash !== "string" ||
    typeof candidate.title !== "string" ||
    typeof candidate.preview !== "string" ||
    typeof candidate.applicationMessageId !== "string"
  ) {
    return undefined;
  }
  return candidate as WemailAgentArtifact;
}

const TOOL_FAILURE_MESSAGES: Record<string, string> = {
  "account-required": "当前运行缺少账户上下文。",
  "dataset-not-found": "未找到本次运行提取的数据集。",
  "dataset-required": "发布前需要先在本次运行中提取结构化数据。",
  "agent_invalid_tool_input": "工具参数未通过校验。",
  "analysis-plan-validation-failed": "报告分组要求与汇总数据字段不匹配。",
  "design-dataset-validation-failed": "汇总数据未通过报告数据校验。",
  "associated-email-ids-required": "滚动时间范围尚未完成相似邮件关联，不能只使用当前邮件生成报告。",
  "artifact-delivery-incomplete": "报告渲染完成但没有落到应用消息，不能视为生成成功。",
  "email-aggregation-required": "多封邮件尚未完成最终汇总，不能直接发布报告。",
  "aggregation-source-incomplete": "关联邮件没有全部完成解析，不能发布部分数据报告。",
  "aggregation-plan-too-granular": "汇总结果仍然过细，需要调整时间粒度或分组维度。",
  "insight-data-contract-missing-aggregation": "报告数据没有经过完整的多邮件汇总。",
  "insight-data-contract-source-metadata-mismatch": "报告来源邮件元数据与聚合结果不一致。",
  "insight-data-contract-source-count-mismatch": "报告来源邮件数量与聚合结果不一致。",
  "insight-data-contract-source-incomplete": "报告只包含部分关联邮件的数据。",
  "insight-data-contract-row-count-mismatch": "报告数据行数校验不一致。",
  "insight-data-contract-time-grain-missing": "报告缺少有效的时间粒度。",
  "insight-data-contract-time-field-missing": "报告缺少有效的时间字段。",
  "insight-data-contract-time-point-count-mismatch": "报告时间点数量校验不一致。",
  "insight-data-contract-aggregation-plan-missing": "报告缺少聚合维度或指标定义。",
  "insight-data-contract-group-field-missing": "报告聚合维度字段不存在。",
  "insight-data-contract-measure-field-missing": "报告聚合指标字段不存在或不是数值。",
  "artifact-delivery-pointer-mismatch": "报告已生成但当前版本指针未正确更新。",
  "artifact-publish-failed": "洞察报告编译或渲染失败。",
};

function stableToolFailure(output: unknown): { code: string; message: string } {
  if (!output || typeof output !== "object") {
    return {
      code: "tool_execution_failed",
      message: "这一步没有完成，请重试或调整请求。",
    };
  }
  const candidate = output as { code?: unknown; error?: unknown; hint?: unknown };
  const rawCode = typeof candidate.code === "string"
    ? candidate.code
    : typeof candidate.error === "string"
      ? candidate.error
      : "";
  const code = /^[a-z][a-z0-9_.:-]{0,79}$/.test(rawCode)
    ? rawCode
    : "tool_execution_failed";
  const rawError = typeof candidate.error === "string" ? candidate.error.trim() : "";
  const rawHint = typeof candidate.hint === "string" ? candidate.hint.trim() : "";
  if (/^Validation failed for tool\b/i.test(rawError)) {
    return {
      code: "tool_arguments_invalid",
      message: "工具参数格式不符合要求，本次调用失败。",
    };
  }
  const known = TOOL_FAILURE_MESSAGES[code];
  const safeError = rawError && rawError !== code && rawError !== "工具执行失败"
    ? safeProgressText(rawError, "")
    : "";
  const detail = known
    ? safeError ? `${known} 详细原因：${safeError}` : known
    : safeError || "工具执行失败，但没有返回可展示的详细原因。";
  const hint = rawHint ? safeProgressText(rawHint, "") : "";
  return {
    code,
    message: hint ? `${detail} 建议：${hint}` : detail,
  };
}

function safeProgressText(value: string | undefined, fallback: string): string {
  const text = value?.trim();
  if (!text) return fallback;
  if (
    /(?:[A-Za-z]:\\|\/(?:Users|home|tmp|var)\/|localhost|127\.0\.0\.1|stdout|stderr|toolCallId|api[_-]?key|token|password|密码|密钥)/i.test(text)
  ) {
    return fallback;
  }
  return text.slice(0, 240);
}

function confirmationFromLegacy(
  action: AgentPendingAction,
  context: PiEventAdapterContext,
) {
  let parameters = jsonRecord(action.parameters);
  if (Object.keys(parameters).length === 0) {
    try {
      parameters = jsonRecord(JSON.parse(action.inputJson));
    } catch {
      parameters = {};
    }
  }
  const now = Date.parse(context.now());
  return {
    id: action.id,
    actionType: action.actionType,
    description: action.description,
    riskLevel: action.riskLevel,
    parameters,
    expiresAt: action.expiresAt ?? new Date(
      (Number.isFinite(now) ? now : Date.now()) + CONFIRMATION_TTL_MS,
    ).toISOString(),
    idempotencyKey: action.idempotencyKey ?? `agent-action:${action.id}`,
    status: "pending" as const,
  };
}

function formatAgentConclusion(
  event: Extract<AgentEvent, { type: "conclusion" }>,
): string {
  const summary = safeProgressText(event.summary, "任务处理已结束。");
  const reason = event.reason
    ? safeProgressText(event.reason, "任务无法继续处理。")
    : undefined;
  const lines = (() => {
    if (event.status === "succeeded") return ["执行结果：成功", summary];
    if (event.status === "cancelled") return ["执行结果：已取消", reason ? `取消原因：${reason}` : summary];
    if (event.status === "blocked") return ["执行结果：未执行", reason ? `原因：${reason}` : summary];
    if (event.status === "needs_input") return ["执行结果：等待补充信息", reason ? `缺少信息：${reason}` : summary];
    return ["执行结果：失败", reason ? `失败原因：${reason}` : summary];
  })();
  if (event.impact?.trim()) {
    lines.push(`影响：${safeProgressText(event.impact, "部分操作可能尚未完成。")}`);
  }
  if (event.nextAction?.trim()) {
    lines.push(`建议：${safeProgressText(event.nextAction, "请调整请求后重试。")}`);
  }
  return lines.filter(Boolean).join("\n\n");
}

function isLegacyAgentEvent(value: unknown): value is AgentEvent {
  return !!value && typeof value === "object" && typeof (value as { type?: unknown }).type === "string";
}

/**
 * Stateful PI 0.80.6 delivery adapter.
 *
 * `PiAgentRuntime` still owns provider-specific execution and its internal
 * compatibility events. This adapter is the last server-side boundary: raw or
 * legacy event shapes terminate here and only versioned WeMail events leave it.
 */
export class PiV0806ToWemailEventAdapter implements PiToWemailEventAdapter {
  private started = false;
  private messageCompleted = false;
  private terminal = false;
  private unknownDiagnosed = false;
  private finalTextEmitted = false;
  private pendingToolCitations: WemailAgentCitation[] = [];

  private citationEvents(partId: string, context: PiEventAdapterContext): WemailAgentEvent[] {
    const citations = this.pendingToolCitations;
    this.pendingToolCitations = [];
    return citations.map((citation) => ({
      ...eventBase(context),
      type: "citation_added" as const,
      partId,
      citation,
    }));
  }

  private ensureStarted(context: PiEventAdapterContext): WemailAgentEvent[] {
    if (this.started) return [];
    this.started = true;
    return [
      { ...eventBase(context), type: "run_started" },
      { ...eventBase(context), type: "run_state_changed", state: "running" },
      { ...eventBase(context), type: "message_started", role: "assistant" },
    ];
  }

  private completeMessage(context: PiEventAdapterContext): WemailAgentEvent[] {
    if (this.messageCompleted) return [];
    this.messageCompleted = true;
    return [{ ...eventBase(context), type: "message_completed" }];
  }

  private textEvents(
    text: string,
    partId: string,
    context: PiEventAdapterContext,
  ): WemailAgentEvent[] {
    const output: WemailAgentEvent[] = [
      { ...eventBase(context), type: "text_started", partId },
      { ...eventBase(context), type: "text_completed", partId, text },
    ];
    output.push(...this.citationEvents(partId, context));
    this.finalTextEmitted = true;
    return output;
  }

  private diagnoseUnknown(context: PiEventAdapterContext): WemailAgentEvent[] {
    if (this.unknownDiagnosed) return [];
    this.unknownDiagnosed = true;
    this.terminal = true;
    return [
      ...this.ensureStarted(context),
      {
        ...eventBase(context),
        type: "run_failed",
        code: "unsupported_pi_event",
        message: "Agent runtime emitted an unsupported event.",
        retryable: false,
      },
    ];
  }

  map(value: unknown, context: PiEventAdapterContext): readonly WemailAgentEvent[] {
    if (!isLegacyAgentEvent(value)) return this.diagnoseUnknown(context);
    const event = value;
    const output = this.ensureStarted(context);

    switch (event.type) {
      case "progress_update":
        output.push({
          ...eventBase(context),
          type: "progress_added",
          partId: `progress:${context.nextSequence()}`,
          text: safeProgressText(event.text, "正在处理当前任务"),
        });
        return output;
      case "thinking":
      case "reasoning_start":
      case "reasoning_delta":
      case "reasoning_end":
        // Provider reasoning is diagnostic data. User-visible progress comes
        // exclusively from progress_update and projected tool lifecycle events.
        return output;
      case "text_start":
        output.push({
          ...eventBase(context),
          type: "text_started",
          partId: `text:${event.contentIndex}`,
        });
        return output;
      case "text_delta": {
        const partId = `text:${event.contentIndex}`;
        output.push({ ...eventBase(context), type: "text_delta", partId, delta: event.text });
        output.push(...this.citationEvents(partId, context));
        this.finalTextEmitted = true;
        return output;
      }
      case "text_end": {
        const partId = `text:${event.contentIndex}`;
        output.push({
          ...eventBase(context),
          type: "text_completed",
          partId,
          text: event.text,
        });
        output.push(...this.citationEvents(partId, context));
        this.finalTextEmitted = true;
        return output;
      }
      case "tool_call": {
        const toolCallId = event.toolCallId ?? `tool:${context.nextSequence()}`;
        output.push(
          { ...eventBase(context), type: "tool_call_started", toolCallId, toolName: event.tool },
          { ...eventBase(context), type: "tool_args_completed", toolCallId, input: projectToolInput(event.input) },
          { ...eventBase(context), type: "tool_execution_started", toolCallId },
        );
        return output;
      }
      case "tool_result": {
        const toolCallId = event.toolCallId ?? `tool:${event.tool}`;
        if (event.isError) {
          const failure = stableToolFailure(event.output);
          output.push({
            ...eventBase(context),
            type: "tool_execution_failed",
            toolCallId,
            code: failure.code,
            message: failure.message,
          });
        } else {
          this.pendingToolCitations.push(...extractToolCitations(event.tool, event.output));
          output.push({
            ...eventBase(context),
            type: "tool_execution_completed",
            toolCallId,
            summary: safeProgressText(event.observation, "操作已完成"),
          });
          const artifact = artifactFromToolResult(event.tool, event.output);
          if (artifact) {
            output.push({
              ...eventBase(context),
              type: "artifact_ready",
              partId: `artifact:${artifact.artifactId}`,
              artifact,
            });
          }
        }
        return output;
      }
      case "tool_update": {
        const toolCallId = event.toolCallId ?? `tool:${event.tool}`;
        output.push({
          ...eventBase(context),
          type: "tool_execution_updated",
          toolCallId,
          summary: safeProgressText(event.observation, "正在执行操作"),
        });
        return output;
      }
      case "assistant_text":
        output.push(...this.textEvents(event.text, `text:final:${context.nextSequence()}`, context));
        return output;
      case "pending_action":
        output.push({
          ...eventBase(context),
          type: "confirmation_requested",
          confirmation: confirmationFromLegacy(event.action, context),
        });
        return output;
      case "conclusion":
        if (!this.finalTextEmitted) {
          output.push(...this.textEvents(
            formatAgentConclusion(event),
            `text:conclusion:${context.nextSequence()}`,
            context,
          ));
        }
        if (event.status === "cancelled") {
          this.terminal = true;
          output.push({
            ...eventBase(context),
            type: "run_stopped",
            reason: safeProgressText(event.reason ?? event.summary, "任务已取消。"),
          });
        } else if (event.status === "failed") {
          this.terminal = true;
          output.push({
            ...eventBase(context),
            type: "run_failed",
            code: event.failureContext?.tool ? "tool_failed" : "agent_failed",
            message: "任务没有完成，请查看建议后重试。",
            retryable: false,
          });
        }
        return output;
      case "terminate":
        if (!this.terminal) {
          this.terminal = true;
          output.push({
            ...eventBase(context),
            type: "run_stopped",
            reason: safeProgressText(event.reason, "任务已停止。"),
          });
        }
        return output;
      case "error":
        this.terminal = true;
        output.push({
          ...eventBase(context),
          type: "run_failed",
          code: "agent_runtime_error",
          message: "Agent 暂时无法继续处理，请稍后重试。",
          retryable: false,
        });
        return output;
      case "retry_scheduled":
        output.push({
          ...eventBase(context),
          type: "retry_scheduled",
          attempt: event.attempt,
          delayMs: event.delayMs,
          reason: "正在准备重试",
        });
        return output;
      case "retry_started":
        output.push({
          ...eventBase(context),
          type: "run_state_changed",
          state: "retrying",
        }, {
          ...eventBase(context),
          type: "retry_started",
          attempt: event.attempt,
          maxAttempts: event.maxAttempts,
        });
        return output;
      case "retry_completed":
        output.push({
          ...eventBase(context),
          type: "retry_completed",
          attempt: event.attempt,
        }, {
          ...eventBase(context),
          type: "run_state_changed",
          state: "running",
        });
        return output;
      case "retry_failed":
        output.push({
          ...eventBase(context),
          type: "retry_failed",
          attempt: event.attempt,
          message: "重试没有完成，请稍后再试。",
        });
        return output;
      case "done":
        output.push(...this.completeMessage(context));
        if (!this.terminal) {
          this.terminal = true;
          output.push({ ...eventBase(context), type: "run_settled" });
        }
        return output;
      default:
        return this.diagnoseUnknown(context);
    }
  }
}

export function createPiV0806ToWemailEventAdapter(): PiToWemailEventAdapter {
  return new PiV0806ToWemailEventAdapter();
}
