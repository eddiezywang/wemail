import { randomUUID } from "node:crypto";
import type {
  ConfigurationConfirmationSnapshot,
  ConfigurationInteraction,
  ConfigurationTaskSnapshot,
} from "../../../shared/wemail/configuration.js";
import type {
  AgentCapabilityDescriptor,
  ExecutionPipelineDraft,
  ReviewCheckpoint,
} from "../../../shared/wemail/skillCenter.js";
import type { ExecutionPipelineDraftRepository } from "../workflows/ExecutionPipelineDraftRepository.js";
import type { AgentCapabilityCatalogService } from "../workflows/AgentCapabilityCatalogService.js";
import type { ExecutionPipelineService } from "../workflows/ExecutionPipelineService.js";
import { PipelineReviewService } from "../workflows/PipelineReviewService.js";
import { ConfigurationWorkflowService } from "./ConfigurationWorkflowService.js";

export type AgentWorkflowIntent =
  | "one_shot"
  | "automation"
  | "preview_revision"
  | "skill_authoring"
  | "general";

export interface AuthoringReadiness {
  ready: boolean;
  issues: Array<{ code: string; message: string; scope: string }>;
}

export interface AutomationCommitAdapter<T> {
  commit(input: {
    draft: ExecutionPipelineDraft;
    confirmation: ConfigurationConfirmationSnapshot;
    compiled: Awaited<ReturnType<ExecutionPipelineService["compile"]>>;
  }): Promise<{ resourceId: string; version?: string | number; hash?: string; value: T }>;
  reload(resourceId: string): Promise<T | null>;
  verify(input: {
    expected: {
      draft: ExecutionPipelineDraft;
      confirmation: ConfigurationConfirmationSnapshot;
    };
    actual: T;
  }): Promise<{ valid: boolean; warnings?: string[] }>;
}

export class AutomationAuthoringCoordinator {
  private readonly reviews: PipelineReviewService;

  constructor(
    private readonly workflow: ConfigurationWorkflowService,
    private readonly drafts: ExecutionPipelineDraftRepository,
    private readonly pipeline: ExecutionPipelineService,
    private readonly catalog: AgentCapabilityCatalogService,
    now: () => string = () => new Date().toISOString(),
    private readonly resolveAccountLabels?: (
      draft: ExecutionPipelineDraft,
    ) => string[],
  ) {
    this.now = now;
    this.reviews = new PipelineReviewService(now);
  }

  private readonly now: () => string;

  routeIntent(text: string): AgentWorkflowIntent {
    const normalized = text.trim().toLowerCase();
    if (/保存|创建|生成/.test(normalized) && /\bskill\b|技能/.test(normalized)) {
      return "skill_authoring";
    }
    if (/预览|图表|报告/.test(normalized) && /修改|调整|改成|换成/.test(normalized)) {
      return "preview_revision";
    }
    if (/每天|每晚|每日|定时|每隔|收到.+邮件.+后|以后都|自动/.test(normalized)) {
      return "automation";
    }
    if (/这封|今天|现在|立即|这一次|一次|发给我|整理/.test(normalized)) {
      return "one_shot";
    }
    return "general";
  }

  async readiness(
    task: ConfigurationTaskSnapshot,
    draft: ExecutionPipelineDraft,
  ): Promise<AuthoringReadiness> {
    const issues: AuthoringReadiness["issues"] = [];
    if (draft.mode === "automation" && !draft.trigger) {
      issues.push({ code: "trigger-required", message: "还没有完整触发条件。", scope: "trigger" });
    }
    const validation = await this.pipeline.validate(draft);
    issues.push(
      ...validation.issues.map((issue) => ({
        code: issue.code,
        message: issue.message,
        scope: issue.path,
      })),
    );
    const capabilities = new Map(
      (await this.catalog.list()).map((capability) => [capability.id, capability]),
    );
    for (const step of draft.steps) {
      const capability = capabilities.get(step.capabilityId);
      if (!capability) continue;
      if (capability.availability.state !== "ready") {
        issues.push({
          code: `capability-${capability.availability.state}`,
          message:
            capability.availability.reason ??
            `${capability.name} 当前不可用。`,
          scope: `step:${step.id}`,
        });
      }
    }
    const policies = this.reviews.derivePolicies(draft);
    for (const [target, policy] of Object.entries(policies)) {
      if (policy !== "required") continue;
      const current = latest(draft.reviews, target as ReviewCheckpoint["target"]);
      const currentHash = this.reviews.targetHash(
        draft,
        target as ReviewCheckpoint["target"],
      );
      if (
        !current ||
        current.status !== "accepted" ||
        current.contentHash !== currentHash ||
        (target === "artifact" && !current.previewId)
      ) {
        issues.push({
          code: "review-required",
          message: `${reviewLabel(target)}预览还没有确认。`,
          scope: `review:${target}`,
        });
      }
    }
    if (
      draft.delivery &&
      !draft.delivery.destinations.some((destination) => destination.enabled)
    ) {
      issues.push({
        code: "delivery-required",
        message: "还没有选择有效的投递方式。",
        scope: "delivery",
      });
    }
    for (const issue of task.issues.filter((item) => !item.resolvedAt)) {
      issues.push({
        code: issue.code,
        message: issue.userMessage,
        scope: issue.affectedScope.join(","),
      });
    }
    return {
      ready: dedupe(issues).length === 0,
      issues: dedupe(issues),
    };
  }

  async projectCurrentInteraction(
    task: ConfigurationTaskSnapshot,
    draft: ExecutionPipelineDraft,
  ): Promise<ConfigurationTaskSnapshot> {
    const currentReview = draft.reviews.find((review) => review.status === "pending");
    if (currentReview) {
      return this.workflow.recordPipelineState({
        taskId: task.id,
        accountId: task.accountId,
        expectedRevision: task.revision,
        pipelineDraftId: draft.id,
        reviewCheckpointIds: draft.reviews.map((review) => review.id),
        status: "reviewing",
        interaction: {
          goalStatus: "reviewing",
          stage: `评审${reviewLabel(currentReview.target)}`,
          message: `我已经生成一版${reviewLabel(currentReview.target)}预览。这版符合你的要求吗？你可以直接说“符合”，或告诉我哪里要改。`,
          impact: "这里只确认当前预览，不会创建规则或发送消息。",
          actions: [
            ...(currentReview.previewUrl
              ? [{
                  id: `open-${currentReview.id}`,
                  type: "open_preview" as const,
                  label: "打开预览",
                  target: currentReview.previewUrl,
                }]
              : []),
            {
              id: `revise-${currentReview.id}`,
              type: "revise_preview" as const,
              label: "告诉我怎么修改",
            },
            {
              id: `cancel-${currentReview.id}`,
              type: "cancel" as const,
              label: "取消",
            },
          ],
          previewLinks:
            currentReview.previewUrl && currentReview.previewId
              ? [{
                  id: currentReview.previewId,
                  label: `${reviewLabel(currentReview.target)}预览`,
                  url: currentReview.previewUrl,
                  mediaType: currentReview.target === "artifact" ? "html" : "text",
                  version: currentReview.targetVersion,
                  contentHash: currentReview.contentHash,
                }]
              : [],
        },
      });
    }
    const readiness = await this.readiness(task, draft);
    if (!readiness.ready) {
      return this.workflow.recordPipelineState({
        taskId: task.id,
        accountId: task.accountId,
        expectedRevision: task.revision,
        pipelineDraftId: draft.id,
        reviewCheckpointIds: draft.reviews.map((review) => review.id),
        status: "compiling",
        interaction: {
          goalStatus: "needs_input",
          stage: "完善自动化流程",
          message: readiness.issues[0]!.message,
          impact: `当前只影响${readiness.issues[0]!.scope}，已完成的其他步骤会保留。`,
          actions: [
            {
              id: "adjust-pipeline",
              type: "adjust_pipeline",
              label: "调整流程",
              preferred: true,
            },
            { id: "cancel-authoring", type: "cancel", label: "取消" },
          ],
          previewLinks: [],
          technicalDetails: {
            issueCodes: readiness.issues.map((issue) => issue.code),
          },
        },
      });
    }
    if (draft.mode === "one_shot") {
      return this.workflow.recordPipelineState({
        taskId: task.id,
        accountId: task.accountId,
        expectedRevision: task.revision,
        pipelineDraftId: draft.id,
        reviewCheckpointIds: draft.reviews.map((review) => review.id),
        status: "reviewing",
        interaction: {
          goalStatus: "needs_input",
          stage: "立即执行",
          message: "当前数据、分析和产物预览都已确认。是否立即执行这一次？",
          impact: "只执行本次流程，不会创建定时任务或自动化规则。",
          actions: [{
            id: `execute-${draft.id}`,
            type: "accept_preview",
            label: "立即执行一次",
            preferred: true,
          }],
          previewLinks: draft.reviews
            .filter(
              (review) =>
                review.status === "accepted" &&
                !!review.previewId &&
                !!review.previewUrl,
            )
            .map((review) => ({
              id: review.previewId!,
              label: `${reviewLabel(review.target)}预览`,
              url: review.previewUrl!,
              mediaType:
                review.target === "artifact"
                  ? draft.artifact?.format ?? "html"
                  : "text",
              version: review.targetVersion,
              contentHash: review.contentHash,
            })),
        },
      });
    }
    return this.prepareFinalConfirmation(task, draft);
  }

  async prepareFinalConfirmation(
    task: ConfigurationTaskSnapshot,
    draft: ExecutionPipelineDraft,
  ): Promise<ConfigurationTaskSnapshot> {
    if (draft.mode !== "automation") {
      throw new Error("durable-automation-draft-required");
    }
    const readiness = await this.readiness(task, draft);
    if (!readiness.ready) {
      throw new Error(`automation-not-ready:${readiness.issues.map((item) => item.code).join(",")}`);
    }
    const compiled = await this.pipeline.compile(draft);
    const resolvedAccountLabels =
      this.resolveAccountLabels?.(draft) ?? defaultAccountLabels(draft);
    const expiresAt = new Date(Date.parse(this.now()) + 15 * 60_000).toISOString();
    const snapshot: ConfigurationConfirmationSnapshot = {
      id: `configuration-confirmation-${randomUUID()}`,
      taskId: task.id,
      taskRevision: task.revision + 1,
      accountId: task.accountId,
      pipelineDraftId: draft.id,
      pipelineDraftRevision: draft.revision,
      ruleHash: compiled.hash,
      skillSnapshots: draft.skillSnapshots,
      capabilitySnapshots: draft.capabilitySnapshots,
      reviewHashes: draft.reviews
        .filter((review) => review.status === "accepted")
        .map((review) => ({
          checkpointId: review.id,
          target: review.target,
          contentHash: review.contentHash,
          targetVersion: review.targetVersion,
        })),
      risk: finalRisk(
        await this.catalog.list(),
        draft.steps.map((step) => step.capabilityId),
      ),
      configuration: {
        ...(draft.trigger ? { trigger: draft.trigger } : {}),
        ...(draft.dataSelection ? { dataSelection: draft.dataSelection } : {}),
        ...(draft.analysis ? { analysis: draft.analysis } : {}),
        ...(draft.artifact ? { artifact: draft.artifact } : {}),
        ...(draft.delivery ? { delivery: draft.delivery } : {}),
        defaults: {
          timezone:
            draft.trigger?.timing.timezone ??
            (draft.dataSelection?.scope.type === "calendar_day"
              ? draft.dataSelection.scope.timezone
              : undefined),
        },
        failurePolicy: Object.fromEntries(
          draft.steps.map((step) => [step.id, step.onError]),
        ),
        authorizationBounds: {
          accountId: draft.accountId,
          accountScope:
            draft.accountScope ?? {
              type: "currentAccount",
              accountId: draft.accountId,
            },
          resolvedAccounts: resolvedAccountLabels,
          capabilities: draft.steps.map((step) => step.capabilityId),
        },
      },
      expiresAt,
    };
    return this.workflow.recordFinalConfirmation({
      taskId: task.id,
      accountId: task.accountId,
      expectedRevision: task.revision,
      snapshot,
      interaction: finalInteraction(draft, snapshot),
    });
  }

  async authorizeFinal(input: {
    task: ConfigurationTaskSnapshot;
    message: string;
    snapshotId: string;
    ruleHash: string;
  }): Promise<ConfigurationTaskSnapshot> {
    const decision = classifyFinalAuthorization(input.message);
    if (decision === "decline") {
      return this.workflow.cancel({
        taskId: input.task.id,
        accountId: input.task.accountId,
        expectedRevision: input.task.revision,
      });
    }
    if (decision !== "confirm") {
      throw new Error("configuration-final-confirmation-ambiguous");
    }
    const confirmation = input.task.confirmationSnapshot;
    if (!confirmation) throw new Error("configuration-final-confirmation-missing");
    const current = this.drafts.get(
      confirmation.pipelineDraftId,
      input.task.accountId,
    );
    if (
      !current ||
      current.revision !== confirmation.pipelineDraftRevision ||
      (await this.pipeline.compile(current)).hash !== confirmation.ruleHash
    ) {
      throw new Error("configuration-final-confirmation-stale");
    }
    return this.workflow.confirmFinal({
      taskId: input.task.id,
      accountId: input.task.accountId,
      expectedRevision: input.task.revision,
      snapshotId: input.snapshotId,
      ruleHash: input.ruleHash,
    });
  }

  async commitAndVerify<T>(input: {
    task: ConfigurationTaskSnapshot;
    adapter: AutomationCommitAdapter<T>;
  }): Promise<ConfigurationTaskSnapshot> {
    const confirmation = input.task.confirmationSnapshot;
    if (
      input.task.status !== "committing" ||
      !confirmation ||
      confirmation.expiresAt <= this.now()
    ) {
      throw new Error("configuration-not-authorized-for-commit");
    }
    const draft = this.drafts.get(
      confirmation.pipelineDraftId,
      input.task.accountId,
    );
    if (
      !draft ||
      draft.revision !== confirmation.pipelineDraftRevision
    ) {
      throw new Error("configuration-commit-draft-stale");
    }
    const compiled = await this.pipeline.compile(draft);
    if (compiled.hash !== confirmation.ruleHash) {
      throw new Error("configuration-commit-hash-stale");
    }
    const committed = await input.adapter.commit({
      draft,
      confirmation,
      compiled,
    });
    let task = this.workflow.recordCommittedReference({
      taskId: input.task.id,
      accountId: input.task.accountId,
      expectedRevision: input.task.revision,
      resourceId: committed.resourceId,
      version: committed.version,
      hash: committed.hash,
      effectType: "automation-rule",
      summary: "自动化规则已提交，正在回读验证",
    });
    const actual = await input.adapter.reload(committed.resourceId);
    if (!actual) {
      throw new Error("configuration-commit-verification-resource-missing");
    }
    const verified = await input.adapter.verify({
      expected: { draft, confirmation },
      actual,
    });
    if (!verified.valid) {
      throw new Error("configuration-commit-verification-mismatch");
    }
    task = this.workflow.completeVerified({
      taskId: task.id,
      accountId: task.accountId,
      expectedRevision: task.revision,
      warnings: verified.warnings,
      resourceId: committed.resourceId,
    });
    return task;
  }
}

export function classifyFinalAuthorization(
  message: string,
): "confirm" | "decline" | "ambiguous" {
  const normalized = message.trim().toLowerCase();
  if (/^(取消|不创建|不配置|先不要|否|no|cancel)[。.!！]?$/.test(normalized)) {
    return "decline";
  }
  if (
    /^(确认创建并启用|确认创建|创建并启用|确认配置|同意创建|按这个配置|confirm|approve)[了的吧啊呀嘛\s。.!！]*$/.test(
      normalized,
    )
  ) {
    return "confirm";
  }
  return "ambiguous";
}

function finalInteraction(
  draft: ExecutionPipelineDraft,
  snapshot: ConfigurationConfirmationSnapshot,
): ConfigurationInteraction {
  const trigger = draft.trigger
    ? draft.trigger.event === "schedule"
      ? `每天 ${String(draft.trigger.timing.localTime ?? "")}（${String(draft.trigger.timing.timezone ?? "账户时区")}）`
      : draft.trigger.event === "mail.received"
        ? "收到匹配邮件后"
        : "手动"
    : "无";
  const destination =
    draft.delivery?.destinations
      .filter((item) => item.enabled)
      .map((item) => item.type)
      .join("、") ?? "无";
  const authorizationBounds =
    snapshot.configuration?.authorizationBounds as
      | { resolvedAccounts?: unknown }
      | undefined;
  const accounts = Array.isArray(authorizationBounds?.resolvedAccounts)
    ? authorizationBounds.resolvedAccounts
        .filter((item): item is string => typeof item === "string")
        .join("、")
    : draft.accountId;
  return {
    goalStatus: "awaiting_final_confirmation",
    stage: "最终创建确认",
    message: `完整流程已串通：邮箱范围 ${accounts || "当前邮箱"}；${trigger}，读取约定范围的邮件，完成分析并生成${draft.artifact?.format ?? "结果"}，投递到 ${destination}。是否确认创建并启用这条规则？`,
    impact: "这是创建定时规则和授权未来自动投递的最终确认；此前的预览接受不包含这项授权。",
    actions: [
      {
        id: `confirm-${snapshot.id}`,
        type: "confirm_final",
        label: "确认创建并启用",
        requiresConfirmation: true,
        preferred: true,
      },
      {
        id: `adjust-${snapshot.id}`,
        type: "adjust_pipeline",
        label: "继续修改",
      },
      { id: `cancel-${snapshot.id}`, type: "cancel", label: "取消" },
    ],
    previewLinks: [],
  };
}

function defaultAccountLabels(draft: ExecutionPipelineDraft): string[] {
  if (draft.accountScope?.type === "selectedAccounts") {
    return [...new Set(draft.accountScope.accountIds)];
  }
  return [draft.accountId];
}

function finalRisk(
  capabilities: AgentCapabilityDescriptor[],
  selected: string[],
): ConfigurationConfirmationSnapshot["risk"] {
  const ranks = ["read", "local_write", "external_side_effect", "destructive"];
  const risk = capabilities
    .filter((capability) => selected.includes(capability.id))
    .map((capability) => capability.risk)
    .sort((left, right) => ranks.indexOf(right) - ranks.indexOf(left))[0];
  return risk === "local_write"
    ? "local-write"
    : risk === "external_side_effect"
      ? "external-mutation"
      : risk ?? "read";
}

function latest(
  reviews: ReviewCheckpoint[],
  target: ReviewCheckpoint["target"],
): ReviewCheckpoint | undefined {
  return reviews.filter((review) => review.target === target).at(-1);
}

function reviewLabel(target: string): string {
  return (
    {
      data: "数据范围",
      analysis: "分析方式",
      artifact: "图表报告",
      delivery: "投递内容",
    }[target] ?? target
  );
}

function dedupe<T extends { code: string; scope: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.code}:${item.scope}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
