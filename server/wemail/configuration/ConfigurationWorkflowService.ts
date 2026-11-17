import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import {
  CONFIGURATION_PHASES,
  assertValidConfigurationSnapshot,
  type ConfigurationEffect,
  type ConfigurationLifecycleEvent,
  type ConfigurationOperationResult,
  type ConfigurationPhase,
  type ConfigurationRecoveryAction,
  type ConfigurationStep,
  type ConfigurationTaskSnapshot,
  type StartConfigurationRequest,
} from "../../../shared/wemail/configuration.js";
import { ConfigurationIssueCatalog } from "./ConfigurationIssueCatalog.js";
import {
  ConfigurationTaskConflictError,
  ConfigurationTaskRepository,
} from "./ConfigurationTaskRepository.js";

export interface ConfigurationWorkflowHooks<T = unknown> {
  run(input: {
    task: ConfigurationTaskSnapshot;
    phase: ConfigurationPhase;
  }): Promise<ConfigurationOperationResult<T>>;
}

export class ConfigurationWorkflowService {
  private readonly events = new EventEmitter();

  constructor(
    private readonly tasks: ConfigurationTaskRepository,
    private readonly issues = new ConfigurationIssueCatalog(),
    private readonly now = () => new Date().toISOString(),
  ) {}

  start(input: StartConfigurationRequest): ConfigurationTaskSnapshot {
    const existing = this.tasks.findActive(
      input.accountId,
      input.kind,
      input.targetKey,
      input.operation,
    );
    if (existing) return existing;
    const now = this.now();
    const snapshot: ConfigurationTaskSnapshot = {
      id: `configuration-task-${randomUUID()}`,
      accountId: input.accountId,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      kind: input.kind,
      targetKey: input.targetKey,
      operation: input.operation,
      title: input.title.trim().slice(0, 200),
      status: "checking_prerequisites",
      currentPhase: "check_prerequisites",
      source: input.source,
      steps: standardSteps(),
      issues: [],
      recoveries: [],
      effects: [],
      references: [],
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };
    snapshot.steps = updateStep(
      snapshot.steps,
      "check_prerequisites",
      "running",
      now,
    );
    const created = this.tasks.create(snapshot);
    this.emit("configuration_started", created);
    return created;
  }

  get(taskId: string, accountId: string): ConfigurationTaskSnapshot | null {
    return this.tasks.get(taskId, accountId);
  }

  list(accountId: string, limit?: number): ConfigurationTaskSnapshot[] {
    return this.tasks.list(accountId, limit);
  }

  beginPhase(input: {
    taskId: string;
    accountId: string;
    expectedRevision: number;
    phase: ConfigurationPhase;
  }): ConfigurationTaskSnapshot {
    return this.mutate(input, (task, now) => {
      assertForwardPhase(task.currentPhase, input.phase);
      return {
        ...task,
        status: statusForPhase(input.phase),
        currentPhase: input.phase,
        steps: updateStep(task.steps, input.phase, "running", now),
        updatedAt: now,
      };
    });
  }

  completePhase(input: {
    taskId: string;
    accountId: string;
    expectedRevision: number;
    phase: ConfigurationPhase;
    summary?: string;
  }): ConfigurationTaskSnapshot {
    return this.mutate(input, (task, now) => ({
      ...task,
      steps: updateStep(
        task.steps,
        input.phase,
        "completed",
        now,
        input.summary,
      ),
      updatedAt: now,
    }));
  }

  recordPreview(input: {
    taskId: string;
    accountId: string;
    expectedRevision: number;
    previewId: string;
    previewHash: string;
    expiresAt: string;
    sourceRevision?: string | number;
    capabilityFingerprints: Array<{
      provider: string;
      capability: string;
      fingerprint: string;
    }>;
    risk: "read" | "local-write" | "external-mutation" | "destructive";
    limits?: Record<string, unknown>;
  }): ConfigurationTaskSnapshot {
    return this.mutate(input, (task, now) => {
      const steps = [
        "compile_configuration",
        "validate_configuration",
        "generate_preview",
      ].reduce(
        (current, phase) =>
          updateStep(
            current,
            phase as ConfigurationPhase,
            "completed",
            now,
          ),
        task.steps,
      );
      return {
        ...task,
        status: "awaiting_confirmation",
        currentPhase: "await_confirmation",
        steps: updateStep(
          steps,
          "await_confirmation",
          "running",
          now,
          "等待确认精确预览",
        ),
        references: upsertReference(task.references, {
          type: "preview",
          id: input.previewId,
          hash: input.previewHash,
          expiresAt: input.expiresAt,
        }),
        authorization: {
          taskId: task.id,
          taskRevision: task.revision,
          accountId: task.accountId,
          kind: task.kind,
          targetKey: task.targetKey,
          operation: task.operation,
          normalizedDraftHash: input.previewHash,
          previewId: input.previewId,
          previewHash: input.previewHash,
          sourceRevision: input.sourceRevision,
          capabilityFingerprints: input.capabilityFingerprints,
          risk: input.risk,
          limits: input.limits,
          expiresAt: input.expiresAt,
        },
        updatedAt: now,
      };
    });
  }

  recordCommittedReference(input: {
    taskId: string;
    accountId: string;
    expectedRevision: number;
    resourceId: string;
    version?: string | number;
    hash?: string;
    effectType: string;
    summary: string;
    externalAuditId?: string;
  }): ConfigurationTaskSnapshot {
    return this.mutate(input, (task, now) => ({
      ...task,
      status: "verifying",
      currentPhase: "verify_configuration",
      steps: updateStep(
        updateStep(
          updateStep(
            task.steps,
            "await_confirmation",
            "completed",
            now,
            "用户已确认",
          ),
          "commit_configuration",
          "completed",
          now,
          input.summary,
        ),
        "verify_configuration",
        "running",
        now,
      ),
      references: upsertReference(task.references, {
        type: "committed_resource",
        id: input.resourceId,
        version: input.version,
        hash: input.hash,
      }),
      effects: upsertById(task.effects, {
        id: `configuration-effect-${randomUUID()}`,
        phase: "commit_configuration",
        type: input.effectType,
        state: "committed",
        summary: input.summary,
        externalAuditId: input.externalAuditId,
        createdAt: now,
        updatedAt: now,
      }),
      updatedAt: now,
    }));
  }

  async runPhase<T>(input: {
    taskId: string;
    accountId: string;
    expectedRevision: number;
    phase: ConfigurationPhase;
    hooks: ConfigurationWorkflowHooks<T>;
    successSummary?: (value: T) => string;
  }): Promise<{
    task: ConfigurationTaskSnapshot;
    result: ConfigurationOperationResult<T>;
  }> {
    let task = this.beginPhase(input);
    const result = await input.hooks.run({ task, phase: input.phase });
    if (result.status === "succeeded") {
      task = this.completePhase({
        taskId: task.id,
        accountId: task.accountId,
        expectedRevision: task.revision,
        phase: input.phase,
        summary: input.successSummary?.(result.value),
      });
      return { task, result };
    }
    const recoveries = recoveryActionsFor(result.issue, this.issues);
    task = this.block({
      taskId: task.id,
      accountId: task.accountId,
      expectedRevision: task.revision,
      issue: result.issue,
      effect:
        result.effectState === "none"
          ? undefined
          : {
              id: `configuration-effect-${randomUUID()}`,
              phase: input.phase,
              type: "configuration-operation",
              state: result.effectState,
              summary: result.issue.userMessage,
              createdAt: this.now(),
              updatedAt: this.now(),
            },
      recoveries,
    });
    return { task, result };
  }

  block(input: {
    taskId: string;
    accountId: string;
    expectedRevision: number;
    issue: ConfigurationTaskSnapshot["issues"][number];
    recoveries?: ConfigurationRecoveryAction[];
    effect?: ConfigurationEffect;
  }): ConfigurationTaskSnapshot {
    return this.mutate(input, (task, now) => {
      const issue =
        input.issue.id && input.issue.createdAt
          ? input.issue
          : this.issues.create({
              code: input.issue.code,
              phase: input.issue.phase,
            });
      const phaseIndex = CONFIGURATION_PHASES.indexOf(issue.phase);
      const steps = task.steps.map((step) => {
        const stepIndex = CONFIGURATION_PHASES.indexOf(step.phase);
        if (step.phase === issue.phase) {
          return {
            ...step,
            status: "blocked" as const,
            summary: issue.userMessage,
            completedAt: now,
          };
        }
        if (
          stepIndex > phaseIndex &&
          (step.status === "pending" || step.status === "running")
        ) {
          return { ...step, status: "skipped" as const };
        }
        return step;
      });
      const effects = input.effect
        ? upsertById(task.effects, input.effect)
        : task.effects;
      const status =
        input.effect?.state === "unknown"
          ? "outcome_unknown"
          : issue.category === "missing_information"
            ? "needs_input"
            : issue.retryability === "safe_immediate"
              ? "retryable_failure"
              : issue.severity === "fatal"
                ? "failed"
              : "blocked";
      const semanticIssue = task.issues.find(
        (current) =>
          !current.resolvedAt &&
          current.phase === issue.phase &&
          current.code === issue.code &&
          stable(current.affectedScope) === stable(issue.affectedScope),
      );
      const retainedIssue = semanticIssue ?? issue;
      const retainedRecoveries = (input.recoveries ?? []).filter(
        (candidate, index, all) =>
          all.findIndex(
            (other) =>
              other.type === candidate.type &&
              other.target === candidate.target &&
              other.resumesFromPhase === candidate.resumesFromPhase,
          ) === index,
      );
      return {
        ...task,
        status,
        currentPhase: issue.phase,
        steps,
        issues: semanticIssue ? task.issues : upsertById(task.issues, issue),
        recoveries: [
          ...task.recoveries.filter(
            (item) => item.issueId !== retainedIssue.id,
          ),
          ...retainedRecoveries.map((recovery) => ({
            ...recovery,
            issueId: retainedIssue.id,
          })),
        ],
        effects,
        retentionUntil: retentionFor(status, effects, now),
        updatedAt: now,
      };
    });
  }

  resume(input: {
    taskId: string;
    accountId: string;
    expectedRevision: number;
    recoveryActionId: string;
  }): ConfigurationTaskSnapshot {
    return this.mutate(input, (task, now) => {
      const recovery = task.recoveries.find(
        (item) =>
          item.id === input.recoveryActionId &&
          !item.resolvedAt &&
          (!item.expiresAt || item.expiresAt > now),
      );
      if (!recovery) throw new Error("configuration-recovery-not-found-or-expired");
      const issue = task.issues.find((item) => item.id === recovery.issueId);
      if (!issue || issue.resolvedAt) {
        throw new Error("configuration-recovery-issue-not-active");
      }
      const phase = recovery.resumesFromPhase ?? issue.phase;
      const phaseIndex = CONFIGURATION_PHASES.indexOf(phase);
      return {
        ...task,
        status: statusForPhase(phase),
        currentPhase: phase,
        issues: task.issues.map((item) =>
          item.id === issue.id ? { ...item, resolvedAt: now } : item,
        ),
        recoveries: task.recoveries.map((item) =>
          item.id === recovery.id ? { ...item, resolvedAt: now } : item,
        ),
        authorization:
          phaseIndex <= CONFIGURATION_PHASES.indexOf("generate_preview")
            ? undefined
            : task.authorization,
        steps: task.steps.map((step) => {
          const stepIndex = CONFIGURATION_PHASES.indexOf(step.phase);
          if (stepIndex < phaseIndex) return step;
          return {
            ...step,
            status: step.phase === phase ? "running" : "pending",
            summary: undefined,
            startedAt: step.phase === phase ? now : undefined,
            completedAt: undefined,
          };
        }),
        updatedAt: now,
        retentionUntil: undefined,
      };
    });
  }

  recordEffect(input: {
    taskId: string;
    accountId: string;
    expectedRevision: number;
    effect: ConfigurationEffect;
  }): ConfigurationTaskSnapshot {
    return this.mutate(input, (task, now) => ({
      ...task,
      effects: upsertById(task.effects, { ...input.effect, updatedAt: now }),
      updatedAt: now,
    }));
  }

  recordPipelineState(input: {
    taskId: string;
    accountId: string;
    expectedRevision: number;
    pipelineDraftId: string;
    reviewCheckpointIds: string[];
    status: "compiling" | "reviewing";
    interaction: NonNullable<ConfigurationTaskSnapshot["interaction"]>;
  }): ConfigurationTaskSnapshot {
    return this.mutate(input, (task, now) => ({
      ...task,
      pipelineDraftId: input.pipelineDraftId,
      reviewCheckpointIds: input.reviewCheckpointIds,
      status: input.status,
      currentPhase:
        input.status === "reviewing"
          ? "review_intermediate_result"
          : "compile_configuration",
      interaction: input.interaction,
      updatedAt: now,
    }));
  }

  recordFinalConfirmation(input: {
    taskId: string;
    accountId: string;
    expectedRevision: number;
    snapshot: NonNullable<ConfigurationTaskSnapshot["confirmationSnapshot"]>;
    interaction: NonNullable<ConfigurationTaskSnapshot["interaction"]>;
  }): ConfigurationTaskSnapshot {
    return this.mutate(input, (task, now) => ({
      ...task,
      status: "awaiting_final_confirmation",
      currentPhase: "await_final_confirmation",
      confirmationSnapshot: {
        ...input.snapshot,
        taskRevision: task.revision + 1,
      },
      interaction: input.interaction,
      steps: updateStep(
        task.steps,
        "await_final_confirmation",
        "running",
        now,
        "等待创建并启用此精确规则的授权",
      ),
      updatedAt: now,
    }));
  }

  confirmFinal(input: {
    taskId: string;
    accountId: string;
    expectedRevision: number;
    snapshotId: string;
    ruleHash: string;
  }): ConfigurationTaskSnapshot {
    const task = this.tasks.get(input.taskId, input.accountId);
    if (!task) throw new Error("configuration-task-not-found");
    if (task.revision !== input.expectedRevision) {
      throw new ConfigurationTaskConflictError(task);
    }
    const snapshot = task.confirmationSnapshot;
    if (
      task.status !== "awaiting_final_confirmation" ||
      !snapshot ||
      snapshot.id !== input.snapshotId ||
      snapshot.ruleHash !== input.ruleHash
    ) {
      throw new Error("configuration-final-confirmation-mismatch");
    }
    if (snapshot.expiresAt <= this.now()) {
      throw new Error("configuration-final-confirmation-expired");
    }
    return this.beginPhase({
      taskId: task.id,
      accountId: task.accountId,
      expectedRevision: task.revision,
      phase: "commit_configuration",
    });
  }

  confirm(input: {
    taskId: string;
    accountId: string;
    expectedRevision: number;
    authorization: NonNullable<ConfigurationTaskSnapshot["authorization"]>;
  }): ConfigurationTaskSnapshot {
    const task = this.tasks.get(input.taskId, input.accountId);
    if (!task) throw new Error("configuration-task-not-found");
    if (task.revision !== input.expectedRevision) {
      throw new ConfigurationTaskConflictError(task);
    }
    if (task.status !== "awaiting_confirmation" || !task.authorization) {
      throw new Error("configuration-task-not-awaiting-confirmation");
    }
    if (task.authorization.expiresAt <= this.now()) {
      throw new Error("configuration-preview-not-found-or-expired");
    }
    if (stable(task.authorization) !== stable(input.authorization)) {
      throw new Error("configuration-preview-authorization-mismatch");
    }
    return this.beginPhase({
      taskId: task.id,
      accountId: task.accountId,
      expectedRevision: task.revision,
      phase: "commit_configuration",
    });
  }

  completeVerified(input: {
    taskId: string;
    accountId: string;
    expectedRevision: number;
    warnings?: string[];
    resourceId?: string;
  }): ConfigurationTaskSnapshot {
    return this.mutate(input, (task, now) => {
      if (
        task.effects.some(
          (effect) => effect.state === "unknown" || effect.state === "partial",
        )
      ) {
        throw new Error("configuration-effects-must-be-reconciled");
      }
      const warnings = input.warnings?.filter(Boolean) ?? [];
      const status =
        warnings.length > 0 ? "completed_with_warnings" : "completed";
      return {
        ...task,
        status,
        currentPhase: "verify_configuration",
        steps: updateStep(
          task.steps,
          "verify_configuration",
          "completed",
          now,
          warnings.join("；") || "配置已验证生效",
        ),
        retentionUntil: retentionFor(status, task.effects, now),
        interaction: input.resourceId
          ? {
              goalStatus: status,
              stage: "配置完成",
              message:
                warnings.join("；") || "自动化规则已创建并验证生效。",
              impact: "规则已进入自动化中心，可以查看配置和运行记录。",
              actions: [
                {
                  id: `open-automation-${input.resourceId}`,
                  type: "open_automation",
                  label: "打开自动化规则",
                  target: `/automation/${encodeURIComponent(input.resourceId)}`,
                  preferred: true,
                },
              ],
              previewLinks: [],
            }
          : task.interaction,
        updatedAt: now,
      };
    });
  }

  completeOneShot(input: {
    taskId: string;
    accountId: string;
    expectedRevision: number;
    pipelineDraftId: string;
    runId: string;
    summary: string;
    previewLinks?: NonNullable<
      ConfigurationTaskSnapshot["interaction"]
    >["previewLinks"];
    warnings?: string[];
  }): ConfigurationTaskSnapshot {
    return this.mutate(input, (task, now) => {
      const warnings = input.warnings?.filter(Boolean) ?? [];
      return {
        ...task,
        pipelineDraftId: input.pipelineDraftId,
        status:
          warnings.length > 0 ? "completed_with_warnings" : "completed",
        currentPhase: "verify_configuration",
        steps: updateStep(
          task.steps,
          "verify_configuration",
          "completed",
          now,
          "一次性流程已执行并核对结果",
        ),
        effects: upsertById(task.effects, {
          id: `one-shot-effect-${randomUUID()}`,
          phase: "verify_configuration",
          type: "one-shot-pipeline",
          state: "completed",
          summary: input.summary,
          externalAuditId: input.runId,
          createdAt: now,
          updatedAt: now,
        }),
        references: upsertReference(task.references, {
          type: "external_audit",
          id: input.runId,
        }),
        interaction: {
          goalStatus:
            warnings.length > 0
              ? "completed_with_warnings"
              : "completed",
          stage: "本次任务已完成",
          message: input.summary,
          impact: "这是一次性执行，没有创建自动化规则。",
          actions: [],
          previewLinks: input.previewLinks ?? [],
        },
        retentionUntil: retentionFor(
          warnings.length > 0
            ? "completed_with_warnings"
            : "completed",
          task.effects,
          now,
        ),
        updatedAt: now,
      };
    });
  }

  cancel(input: {
    taskId: string;
    accountId: string;
    expectedRevision: number;
  }): ConfigurationTaskSnapshot {
    return this.mutate(input, (task, now) => ({
      ...task,
      status: "cancelled",
      steps: task.steps.map((step) =>
        step.status === "running" || step.status === "pending"
          ? { ...step, status: "cancelled" as const, completedAt: now }
          : step,
      ),
      recoveries: task.recoveries.map((recovery) =>
        recovery.resolvedAt ? recovery : { ...recovery, resolvedAt: now },
      ),
      retentionUntil: retentionFor("cancelled", task.effects, now),
      updatedAt: now,
    }));
  }

  onEvent(listener: (event: ConfigurationLifecycleEvent) => void): () => void {
    this.events.on("event", listener);
    return () => this.events.off("event", listener);
  }

  private mutate(
    input: {
      taskId: string;
      accountId: string;
      expectedRevision: number;
    },
    update: (
      task: ConfigurationTaskSnapshot,
      now: string,
    ) => ConfigurationTaskSnapshot,
  ): ConfigurationTaskSnapshot {
    const task = this.tasks.get(input.taskId, input.accountId);
    if (!task) throw new Error("configuration-task-not-found");
    if (task.revision !== input.expectedRevision) {
      throw new ConfigurationTaskConflictError(task);
    }
    const now = this.now();
    const next = update(task, now);
    const snapshot = {
      ...next,
      revision: task.revision + 1,
      updatedAt: now,
      ...(next.authorization
        ? {
            authorization: {
              ...next.authorization,
              taskRevision: task.revision + 1,
            },
          }
        : {}),
    };
    assertValidConfigurationSnapshot(snapshot);
    const saved = this.tasks.replace(snapshot, task.revision);
    this.emit(eventType(saved), saved);
    return saved;
  }

  private emit(
    type: ConfigurationLifecycleEvent["type"],
    snapshot: ConfigurationTaskSnapshot,
  ): void {
    this.events.emit("event", {
      type,
      taskId: snapshot.id,
      revision: snapshot.revision,
      snapshot,
    } satisfies ConfigurationLifecycleEvent);
  }
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function standardSteps(): ConfigurationStep[] {
  const labels: Record<ConfigurationPhase, string> = {
    understand_goal: "理解配置目标",
    collect_requirements: "补齐配置要求",
    resolve_capabilities: "匹配可用能力",
    check_prerequisites: "检查前置条件",
    discover_capabilities: "发现可用能力",
    compile_configuration: "生成规范化配置",
    validate_configuration: "校验配置",
    generate_preview: "生成配置预览",
    review_intermediate_result: "评审中间结果",
    await_confirmation: "等待用户确认",
    await_final_confirmation: "等待最终创建确认",
    commit_configuration: "提交配置",
    verify_configuration: "验证配置生效",
  };
  return CONFIGURATION_PHASES.map((phase) => ({
    id: phase,
    phase,
    label: labels[phase],
    status:
      phase === "understand_goal" || phase === "collect_requirements"
        ? "completed"
        : "pending",
  }));
}

function updateStep(
  steps: ConfigurationStep[],
  phase: ConfigurationPhase,
  status: ConfigurationStep["status"],
  now: string,
  summary?: string,
): ConfigurationStep[] {
  return steps.map((step) =>
    step.phase === phase
      ? {
          ...step,
          status,
          ...(summary ? { summary } : {}),
          ...(status === "running" && !step.startedAt ? { startedAt: now } : {}),
          ...(["completed", "blocked", "failed", "cancelled"].includes(status)
            ? { completedAt: now }
            : {}),
        }
      : step,
  );
}

function statusForPhase(
  phase: ConfigurationPhase,
): ConfigurationTaskSnapshot["status"] {
  if (phase === "check_prerequisites") return "checking_prerequisites";
  if (phase === "resolve_capabilities") return "resolving_capabilities";
  if (phase === "compile_configuration") return "compiling";
  if (phase === "review_intermediate_result") return "reviewing";
  if (
    phase === "discover_capabilities" ||
    phase === "validate_configuration" ||
    phase === "generate_preview"
  ) {
    return "preparing_preview";
  }
  if (phase === "await_confirmation") return "awaiting_confirmation";
  if (phase === "await_final_confirmation") return "awaiting_final_confirmation";
  if (phase === "commit_configuration") return "committing";
  if (phase === "verify_configuration") return "verifying";
  return "drafting";
}

function assertForwardPhase(
  current: ConfigurationPhase,
  next: ConfigurationPhase,
): void {
  if (
    CONFIGURATION_PHASES.indexOf(next) <
    CONFIGURATION_PHASES.indexOf(current)
  ) {
    throw new Error("configuration-phase-regression-requires-recovery");
  }
}

function recoveryActionsFor(
  issue: ConfigurationTaskSnapshot["issues"][number],
  catalog: ConfigurationIssueCatalog,
): ConfigurationRecoveryAction[] {
  const definition = catalog.require(issue.code);
  return definition.recoveryTypes.map((type, index) => ({
    id: `configuration-recovery-${randomUUID()}`,
    issueId: issue.id,
    type,
    label: recoveryLabel(type),
    requiresConfirmation:
      type === "install_dependency" || type === "request_permission",
    dangerous: false,
    preferred: index === 0,
    resumesFromPhase: recoveryPhase(type, issue.phase),
  }));
}

function recoveryLabel(type: ConfigurationRecoveryAction["type"]): string {
  const labels: Record<ConfigurationRecoveryAction["type"], string> = {
    provide_input: "补充信息",
    open_settings: "打开设置",
    authenticate: "重新登录",
    request_permission: "申请权限",
    install_dependency: "安装所需组件",
    select_resource: "重新选择资源",
    retry_phase: "重试当前步骤",
    regenerate_preview: "重新生成预览",
    restart_configuration: "重新检查配置",
    reconcile_outcome: "核查外部结果",
    cancel: "暂不处理",
  };
  return labels[type];
}

function recoveryPhase(
  type: ConfigurationRecoveryAction["type"],
  issuePhase: ConfigurationPhase,
): ConfigurationPhase {
  if (
    type === "install_dependency" ||
    type === "authenticate" ||
    type === "request_permission" ||
    type === "open_settings"
  ) {
    return "check_prerequisites";
  }
  if (type === "regenerate_preview") return "discover_capabilities";
  if (type === "restart_configuration") return "check_prerequisites";
  return issuePhase;
}

function retentionFor(
  status: ConfigurationTaskSnapshot["status"],
  effects: ConfigurationEffect[],
  now: string,
): string | undefined {
  if (
    !["completed", "completed_with_warnings", "failed", "cancelled"].includes(
      status,
    )
  ) {
    return undefined;
  }
  const externallyEffectful = effects.some((effect) =>
    ["committed", "partial", "unknown"].includes(effect.state),
  );
  const days = externallyEffectful
    ? 90
    : status === "completed" || status === "completed_with_warnings"
      ? 30
      : 14;
  return new Date(Date.parse(now) + days * 86_400_000).toISOString();
}

function upsertById<T extends { id: string }>(items: T[], value: T): T[] {
  return [...items.filter((item) => item.id !== value.id), value];
}

function upsertReference(
  items: ConfigurationTaskSnapshot["references"],
  value: ConfigurationTaskSnapshot["references"][number],
): ConfigurationTaskSnapshot["references"] {
  return [
    ...items.filter(
      (item) => item.type !== value.type || item.id !== value.id,
    ),
    value,
  ];
}

function eventType(
  snapshot: ConfigurationTaskSnapshot,
): ConfigurationLifecycleEvent["type"] {
  if (
    snapshot.status === "completed" ||
    snapshot.status === "completed_with_warnings"
  ) {
    return "configuration_completed";
  }
  if (snapshot.issues.some((issue) => !issue.resolvedAt)) {
    return snapshot.recoveries.some((recovery) => !recovery.resolvedAt)
      ? "configuration_recovery_available"
      : "configuration_issue_detected";
  }
  if (snapshot.currentPhase === "await_confirmation") {
    return "configuration_preview_ready";
  }
  return "configuration_phase_changed";
}

export function isSafeAutomaticConfigurationRetry(
  result: ConfigurationOperationResult<unknown>,
): boolean {
  if (result.status === "succeeded") return false;
  return (
    result.issue.retryability === "safe_immediate" &&
    result.effectState === "none"
  );
}
