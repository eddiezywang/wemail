import type {
  ConfigurationDiagnostic,
  ConfigurationOutcome,
  ConfigurationTaskSnapshot,
} from "../../../shared/wemail/configuration.js";

export class ConfigurationOutcomeProjector {
  project(task: ConfigurationTaskSnapshot): ConfigurationOutcome {
    const activeIssues = task.issues.filter((issue) => !issue.resolvedAt);
    const primary =
      activeIssues.find(
        (issue) => issue.severity === "fatal" || issue.severity === "blocking",
      ) ?? activeIssues[0];
    const completed = task.steps
      .filter((step) => step.status === "completed")
      .map((step) => step.summary || step.label);
    const notPerformed = task.steps
      .filter((step) => step.status === "skipped" || step.status === "pending")
      .map((step) => step.label);
    const effects = task.effects.filter((effect) => effect.state !== "none");
    const impact = effects.length
      ? effects.map((effect) => `${effect.summary}（${effectLabel(effect.state)}）`)
      : notPerformed.length
        ? [`${notPerformed.join("、")}尚未执行。`]
        : [];
    const unaffected = Array.from(
      new Set(activeIssues.flatMap((issue) => issue.unaffectedScope ?? [])),
    );
    const diagnostics = activeIssues
      .map((issue) => issue.diagnostic)
      .filter((value): value is ConfigurationDiagnostic => !!value);
    return {
      taskId: task.id,
      revision: task.revision,
      title: task.title,
      status: task.status,
      ...(primary ? { currentNeed: primary.userMessage } : {}),
      completed,
      notPerformed,
      impact,
      unaffected,
      actions: task.recoveries.filter(
        (action) =>
          !action.resolvedAt &&
          (!action.expiresAt || action.expiresAt > task.updatedAt),
      ),
      diagnostics,
      goalStatus: goalStatus(task.status),
      ...(task.interaction ? { interaction: task.interaction } : {}),
    };
  }

  safeSummary(
    task: ConfigurationTaskSnapshot,
    candidate?: string,
  ): string {
    const projected = this.project(task);
    const deterministic = projected.currentNeed
      ? `${task.title}：${projected.currentNeed}`
      : `${task.title}：${statusLabel(task.status)}`;
    if (!candidate?.trim()) return deterministic;
    if (contradicts(task, candidate)) return deterministic;
    return candidate.trim().slice(0, 500);
  }
}

function contradicts(
  task: ConfigurationTaskSnapshot,
  text: string,
): boolean {
  const normalized = text.toLowerCase();
  if (
    task.status !== "completed" &&
    task.status !== "completed_with_warnings" &&
    /(?:已完成|配置成功|已经生效|completed|succeeded)/i.test(normalized)
  ) {
    return true;
  }
  if (
    (task.status === "completed" ||
      task.status === "completed_with_warnings") &&
    /(?:未创建|没有保存|执行失败|failed)/i.test(normalized)
  ) {
    return true;
  }
  return false;
}

function statusLabel(status: ConfigurationTaskSnapshot["status"]): string {
  const labels: Record<ConfigurationTaskSnapshot["status"], string> = {
    drafting: "正在整理配置",
    collecting: "正在补齐配置要求",
    needs_input: "等待补充信息",
    checking_prerequisites: "正在检查前置条件",
    resolving_capabilities: "正在匹配可用能力",
    compiling: "正在生成配置",
    reviewing: "等待检查中间结果",
    blocked: "配置已暂停",
    preparing_preview: "正在生成预览",
    awaiting_confirmation: "等待确认",
    awaiting_final_confirmation: "等待最终创建确认",
    committing: "正在保存配置",
    verifying: "正在验证配置",
    completed: "配置已完成",
    completed_with_warnings: "配置已完成，但有提示",
    retryable_failure: "暂时失败，可以安全重试",
    failed: "配置未完成",
    outcome_unknown: "外部结果待核查",
    cancelled: "配置已取消",
  };
  return labels[status];
}

function effectLabel(
  state: ConfigurationTaskSnapshot["effects"][number]["state"],
): string {
  const labels: Record<
    ConfigurationTaskSnapshot["effects"][number]["state"],
    string
  > = {
    none: "未执行",
    planned: "计划执行",
    started: "已经开始",
    committed: "已经提交",
    completed: "已经完成",
    rolled_back: "已回滚",
    partial: "部分完成",
    unknown: "结果待核查",
  };
  return labels[state];
}

function goalStatus(
  status: ConfigurationTaskSnapshot["status"],
): NonNullable<ConfigurationOutcome["goalStatus"]> {
  if (status === "completed") return "completed";
  if (status === "completed_with_warnings") return "completed_with_warnings";
  if (status === "needs_input") return "needs_input";
  if (status === "reviewing" || status === "preparing_preview") return "reviewing";
  if (status === "blocked" || status === "retryable_failure") return "blocked";
  if (
    status === "awaiting_confirmation" ||
    status === "awaiting_final_confirmation"
  ) {
    return "awaiting_final_confirmation";
  }
  if (status === "committing") return "committing";
  if (status === "verifying") return "verifying";
  if (status === "failed") return "failed";
  if (status === "cancelled") return "cancelled";
  if (status === "outcome_unknown") return "outcome_unknown";
  return "in_progress";
}
