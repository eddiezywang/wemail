import type {
  ConfigurationIssue,
  ConfigurationRecoveryAction,
  ConfigurationTaskSnapshot,
} from "../../../shared/wemail/configuration.js";
import type { ConfigurationTaskRepository } from "./ConfigurationTaskRepository.js";

const TERMINAL = new Set([
  "completed",
  "completed_with_warnings",
  "failed",
  "cancelled",
]);

export class ConfigurationTaskReconciler {
  constructor(
    private readonly tasks: ConfigurationTaskRepository,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  reconcile(accountId: string): {
    normalized: number;
    superseded: number;
  } {
    let normalized = 0;
    let superseded = 0;
    let tasks = this.tasks.list(accountId, 200);
    for (const task of tasks) {
      const deduplicated = deduplicate(task);
      if (!deduplicated.changed) continue;
      this.tasks.replace(
        {
          ...task,
          issues: deduplicated.issues,
          recoveries: deduplicated.recoveries,
          revision: task.revision + 1,
          // Normalization is a storage repair, not new user intent. Preserve
          // business recency so it cannot outrank a later verified rule.
          updatedAt: task.updatedAt,
        },
        task.revision,
      );
      normalized += 1;
    }
    tasks = this.tasks.list(accountId, 200);
    const completedByTarget = new Map<string, ConfigurationTaskSnapshot>();
    for (const task of tasks) {
      if (
        task.kind !== "automation_rule" ||
        !["completed", "completed_with_warnings"].includes(task.status) ||
        !task.references.some((reference) => reference.type === "committed_resource")
      ) {
        continue;
      }
      const key = `${task.kind}:${task.targetKey}`;
      const current = completedByTarget.get(key);
      if (!current || current.updatedAt < task.updatedAt) {
        completedByTarget.set(key, task);
      }
    }
    for (const task of tasks) {
      if (TERMINAL.has(task.status)) continue;
      const completed = completedByTarget.get(`${task.kind}:${task.targetKey}`);
      if (!completed || completed.updatedAt <= task.updatedAt) continue;
      const timestamp = this.now();
      this.tasks.replace(
        {
          ...task,
          status: "cancelled",
          steps: task.steps.map((step) =>
            step.status === "pending" || step.status === "running"
              ? {
                  ...step,
                  status: "cancelled" as const,
                  completedAt: timestamp,
                }
              : step,
          ),
          recoveries: task.recoveries.map((recovery) =>
            recovery.resolvedAt
              ? recovery
              : { ...recovery, resolvedAt: timestamp },
          ),
          interaction: {
            goalStatus: "cancelled",
            stage: "配置已被较新规则取代",
            message: `较新的已验证规则（${completed.title}）已经生效，本次旧配置不再继续。`,
            impact: "保留原任务和诊断记录，仅停止重复配置。",
            actions: [],
            previewLinks: [],
          },
          revision: task.revision + 1,
          updatedAt: timestamp,
        },
        task.revision,
      );
      superseded += 1;
    }
    return { normalized, superseded };
  }
}

function deduplicate(task: ConfigurationTaskSnapshot): {
  changed: boolean;
  issues: ConfigurationIssue[];
  recoveries: ConfigurationRecoveryAction[];
} {
  const issueKeys = new Map<string, ConfigurationIssue>();
  const issueAliases = new Map<string, string>();
  for (const issue of task.issues) {
    const key = `${issue.phase}:${issue.code}:${[...issue.affectedScope].sort().join(",")}`;
    const kept = issueKeys.get(key);
    if (kept) issueAliases.set(issue.id, kept.id);
    else issueKeys.set(key, issue);
  }
  const recoveryKeys = new Set<string>();
  const recoveries = task.recoveries.flatMap((recovery) => {
    const normalized = {
      ...recovery,
      issueId: issueAliases.get(recovery.issueId) ?? recovery.issueId,
    };
    const key = `${normalized.type}:${normalized.target ?? ""}:${normalized.resumesFromPhase ?? ""}:${normalized.issueId}`;
    if (recoveryKeys.has(key)) return [];
    recoveryKeys.add(key);
    return [normalized];
  });
  const issues = [...issueKeys.values()];
  return {
    changed:
      issues.length !== task.issues.length ||
      recoveries.length !== task.recoveries.length ||
      recoveries.some(
        (recovery, index) =>
          recovery.issueId !== task.recoveries[index]?.issueId,
      ),
    issues,
    recoveries,
  };
}
