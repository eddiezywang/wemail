import { createHash } from "node:crypto";

export interface AgentExecutionLimits {
  maxExactRepeatCalls: number;
  maxConsecutiveNoProgress: number;
  maxEmergencyToolCalls: number;
  toolTimeoutMs: number;
  runTimeoutMs: number;
}

export const DEFAULT_AGENT_EXECUTION_LIMITS: AgentExecutionLimits = {
  maxExactRepeatCalls: 2,
  maxConsecutiveNoProgress: 4,
  maxEmergencyToolCalls: 64,
  toolTimeoutMs: 30_000,
  runTimeoutMs: 300_000,
};

export type AgentExecutionGuardKind =
  | "exact_repeat"
  | "no_progress"
  | "emergency_tool_calls";

export interface AgentExecutionGuard {
  kind: AgentExecutionGuardKind;
  reason: string;
  nextAction: string;
}

export interface AgentProgressAssessment {
  progressed: boolean;
  consecutiveNoProgress: number;
  guard?: AgentExecutionGuard;
}

const SENSITIVE_PROGRESS_KEYS =
  /body|html|content|prompt|password|secret|token|credential|absolutePath|localPath/i;
const DOMAIN_ID_KEYS = new Set([
  "emailId",
  "messageId",
  "cursor",
  "nextCursor",
  "taskId",
  "draftId",
  "checkpointId",
  "batchId",
  "datasetId",
  "artifactId",
  "actionId",
  "pendingActionId",
  "operationId",
  "runId",
]);
const DOMAIN_STATE_KEYS = new Set([
  "phase",
  "revision",
  "version",
  "status",
]);

function normalizedLimit(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

export function normalizeAgentExecutionLimits(
  input: Partial<AgentExecutionLimits> = {},
): AgentExecutionLimits {
  return {
    maxExactRepeatCalls: normalizedLimit(
      input.maxExactRepeatCalls ?? DEFAULT_AGENT_EXECUTION_LIMITS.maxExactRepeatCalls,
      DEFAULT_AGENT_EXECUTION_LIMITS.maxExactRepeatCalls,
    ),
    maxConsecutiveNoProgress: normalizedLimit(
      input.maxConsecutiveNoProgress ??
        DEFAULT_AGENT_EXECUTION_LIMITS.maxConsecutiveNoProgress,
      DEFAULT_AGENT_EXECUTION_LIMITS.maxConsecutiveNoProgress,
    ),
    maxEmergencyToolCalls: normalizedLimit(
      input.maxEmergencyToolCalls ??
        DEFAULT_AGENT_EXECUTION_LIMITS.maxEmergencyToolCalls,
      DEFAULT_AGENT_EXECUTION_LIMITS.maxEmergencyToolCalls,
    ),
    toolTimeoutMs: normalizedLimit(
      input.toolTimeoutMs ?? DEFAULT_AGENT_EXECUTION_LIMITS.toolTimeoutMs,
      DEFAULT_AGENT_EXECUTION_LIMITS.toolTimeoutMs,
    ),
    runTimeoutMs: normalizedLimit(
      input.runTimeoutMs ?? DEFAULT_AGENT_EXECUTION_LIMITS.runTimeoutMs,
      DEFAULT_AGENT_EXECUTION_LIMITS.runTimeoutMs,
    ),
  };
}

function progressProjection(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(progressProjection);
  }
  if (!value || typeof value !== "object") return value;

  const projected: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_PROGRESS_KEYS.test(key)) continue;
    projected[key] = progressProjection(child);
  }
  return projected;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  return encoded === undefined ? String(value) : encoded;
}

function privacySafeDigest(value: unknown): string {
  return createHash("sha256")
    .update(stableJson(progressProjection(value)))
    .digest("hex");
}

function callFingerprint(toolName: string, input: unknown): string {
  return `${toolName}:${privacySafeDigest(input)}`;
}

function addDomainProgressKeys(
  toolName: string,
  value: unknown,
  keys: Set<string>,
  parentKey?: string,
): void {
  if (Array.isArray(value)) {
    for (const child of value) {
      addDomainProgressKeys(toolName, child, keys, parentKey);
    }
    return;
  }
  if (!value || typeof value !== "object") return;

  const record = value as Record<string, unknown>;
  for (const [key, child] of Object.entries(record)) {
    if (SENSITIVE_PROGRESS_KEYS.test(key)) continue;
    if (
      typeof child === "string" &&
      child.length > 0 &&
      (DOMAIN_ID_KEYS.has(key) ||
        (key === "id" &&
          (/mail/i.test(toolName) ||
            /message|mail|artifact|draft|task|action|operation/i.test(
              parentKey ?? "",
            ))))
    ) {
      keys.add(`${key}:${child}`);
    } else if (
      (typeof child === "string" || typeof child === "number") &&
      DOMAIN_STATE_KEYS.has(key)
    ) {
      keys.add(`${key}:${String(child)}`);
    }
    addDomainProgressKeys(toolName, child, keys, key);
  }
}

function isEmptySuccessfulResult(output: unknown): boolean {
  if (!output || typeof output !== "object") return false;
  const record = output as Record<string, unknown>;
  if (record.ok === false) return false;
  if (record.count === 0) return true;
  const collectionKeys = ["messages", "items", "results", "entries", "rows"];
  const collections = collectionKeys
    .filter((key) => Array.isArray(record[key]))
    .map((key) => record[key] as unknown[]);
  return collections.length > 0 && collections.every((items) => items.length === 0);
}

export class AgentExecutionProgressTracker {
  readonly limits: AgentExecutionLimits;
  private readonly callCounts = new Map<string, number>();
  private readonly successfulCallFingerprints = new Set<string>();
  private readonly resultDigests = new Set<string>();
  private readonly domainProgressKeys = new Set<string>();
  private totalToolCalls = 0;
  private consecutiveNoProgress = 0;

  constructor(limits: Partial<AgentExecutionLimits> = {}) {
    this.limits = normalizeAgentExecutionLimits(limits);
  }

  beforeToolCall(toolName: string, input: unknown): AgentExecutionGuard | undefined {
    const fingerprint = callFingerprint(toolName, input);
    const repeatCount = (this.callCounts.get(fingerprint) ?? 0) + 1;
    this.callCounts.set(fingerprint, repeatCount);
    if (repeatCount > this.limits.maxExactRepeatCalls) {
      return {
        kind: "exact_repeat",
        reason: `检测到相同工具和参数被重复调用超过 ${this.limits.maxExactRepeatCalls} 次，为避免重复循环已自动停止。`,
        nextAction: "请调整任务条件或工具参数后重试。",
      };
    }
    if (this.totalToolCalls >= this.limits.maxEmergencyToolCalls) {
      return {
        kind: "emergency_tool_calls",
        reason: `Agent 已达到紧急工具调用保护上限（${this.limits.maxEmergencyToolCalls} 次），系统已停止继续执行。`,
        nextAction: "请检查任务是否需要拆分，或确认工具是否持续产生了新的结果。",
      };
    }
    this.totalToolCalls += 1;
    return undefined;
  }

  afterToolCall(
    toolName: string,
    input: unknown,
    output: unknown,
    isError: boolean,
  ): AgentProgressAssessment {
    let progressed = false;
    if (!isError) {
      const newDomainKeys = new Set<string>();
      addDomainProgressKeys(toolName, output, newDomainKeys);
      for (const key of newDomainKeys) {
        if (!this.domainProgressKeys.has(key)) {
          this.domainProgressKeys.add(key);
          progressed = true;
        }
      }

      const fingerprint = callFingerprint(toolName, input);
      const novelCall = !this.successfulCallFingerprints.has(fingerprint);
      this.successfulCallFingerprints.add(fingerprint);
      const digest = privacySafeDigest(output);
      const novelResult = !this.resultDigests.has(digest);
      if (
        !isEmptySuccessfulResult(output) &&
        novelCall &&
        novelResult
      ) {
        progressed = true;
      }
      this.resultDigests.add(digest);
    }

    this.consecutiveNoProgress = progressed
      ? 0
      : this.consecutiveNoProgress + 1;
    if (
      this.consecutiveNoProgress >=
      this.limits.maxConsecutiveNoProgress
    ) {
      return {
        progressed,
        consecutiveNoProgress: this.consecutiveNoProgress,
        guard: {
          kind: "no_progress",
          reason: `最近 ${this.consecutiveNoProgress} 个工具步骤没有产生新的结果或推进执行状态，系统已停止继续执行。`,
          nextAction: "请检查筛选条件、工具结果或调整任务目标后重试。",
        },
      };
    }
    return {
      progressed,
      consecutiveNoProgress: this.consecutiveNoProgress,
    };
  }

  snapshot(): {
    totalToolCalls: number;
    consecutiveNoProgress: number;
    distinctProgressKeys: number;
  } {
    return {
      totalToolCalls: this.totalToolCalls,
      consecutiveNoProgress: this.consecutiveNoProgress,
      distinctProgressKeys: this.domainProgressKeys.size,
    };
  }
}
