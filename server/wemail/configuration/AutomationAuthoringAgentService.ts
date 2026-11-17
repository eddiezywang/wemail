import { randomUUID } from "node:crypto";
import type { AutomationProcessing } from "../../../shared/wemail/automation.js";
import type {
  ExecutionPipelineDraft,
  ReviewTarget,
  SkillSnapshot,
} from "../../../shared/wemail/skillCenter.js";
import type { PipelineAutomationRuleService } from "../automation/PipelineAutomationRuleService.js";
import type { AutomationRuleRepository } from "../automation/AutomationRuleRepository.js";
import {
  PipelineDraftConflictError,
  type ExecutionPipelineDraftRepository,
} from "../workflows/ExecutionPipelineDraftRepository.js";
import type { AgentCapabilityCatalogService } from "../workflows/AgentCapabilityCatalogService.js";
import type { ExecutionPipelineService } from "../workflows/ExecutionPipelineService.js";
import {
  PipelinePreviewStore,
  PipelineReviewService,
} from "../workflows/PipelineReviewService.js";
import type { ConfigurationWorkflowService } from "./ConfigurationWorkflowService.js";
import { AutomationAuthoringCoordinator, classifyFinalAuthorization } from "./AutomationAuthoringCoordinator.js";
import type { CanonicalAutomationDraftService } from "../automation/CanonicalAutomationDraftService.js";
import type { UnifiedAutomationQueryService } from "../automation/UnifiedAutomationQueryService.js";
import type { AutomationDraftPatch } from "../../../shared/wemail/automationCenter.js";
import type { AutomationArtifactReference } from "../../../shared/wemail/automation.js";
import type { ApplicationMessageRepository } from "../applicationMessages/ApplicationMessageRepository.js";
import type { MessageArtifactRepository } from "../design/MessageArtifactRepository.js";
import { compileDataSelectionFilters } from "../workflows/DataSelectionRuntime.js";

export type PipelineDraftInput = Omit<
  ExecutionPipelineDraft,
  | "id"
  | "accountId"
  | "sessionId"
  | "revision"
  | "skillSnapshots"
  | "capabilitySnapshots"
  | "reviews"
  | "validation"
  | "createdAt"
  | "updatedAt"
> & {
  /**
   * Skill snapshots are resolved by the trusted Agent composition layer.
   * Callers may omit them, but must never provide arbitrary hashes from the
   * renderer or model output.
   */
  skillSnapshots?: SkillSnapshot[];
};

/**
 * Product-facing orchestration facade used by the conversational tools.
 * Provider names stay below this boundary; callers work with business
 * capability IDs, pipeline drafts, preview checkpoints and exact confirmations.
 */
export class AutomationAuthoringAgentService {
  private readonly reviews: PipelineReviewService;

  constructor(
    private readonly workflow: ConfigurationWorkflowService,
    private readonly drafts: ExecutionPipelineDraftRepository,
    private readonly pipeline: ExecutionPipelineService,
    private readonly catalog: AgentCapabilityCatalogService,
    private readonly previews: PipelinePreviewStore,
    private readonly coordinator: AutomationAuthoringCoordinator,
    private readonly rules: AutomationRuleRepository,
    private readonly ruleService: PipelineAutomationRuleService,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly canonicalDrafts?: CanonicalAutomationDraftService,
    private readonly unified?: UnifiedAutomationQueryService,
    private readonly artifactDelivery?: {
      messages: ApplicationMessageRepository;
      artifacts: MessageArtifactRepository;
    },
    private readonly skillDrafts?: import("../skill-center/SkillDraftService.js").SkillDraftService,
    private readonly skillPackages?: import("../skill-center/SkillPackageRepository.js").SkillPackageRepository,
  ) {
    this.reviews = new PipelineReviewService(now);
  }

  routeIntent(text: string) {
    return this.coordinator.routeIntent(text);
  }

  async capabilities() {
    return this.catalog.list();
  }

  async resumeRule(input: {
    accountId: string;
    ruleId: string;
    sessionId?: string;
  }) {
    if (!this.canonicalDrafts) {
      throw new Error("canonical-draft-unavailable");
    }
    const resumed = await this.canonicalDrafts.resumeFromRule(input);
    let task = this.workflow
      .list(input.accountId, 100)
      .find(
        (candidate) =>
          candidate.pipelineDraftId === resumed.draft.id &&
          candidate.status !== "completed" &&
          candidate.status !== "completed_with_warnings" &&
          candidate.status !== "cancelled" &&
          candidate.status !== "failed",
      );
    if (!task) {
      task = this.workflow.start({
        accountId: input.accountId,
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        kind: "automation_rule",
        targetKey: input.ruleId,
        operation: "update",
        title:
          typeof resumed.draft.advancedPolicy?.name === "string"
            ? resumed.draft.advancedPolicy.name
            : "修改自动化规则",
        source: { surface: "agent" },
      });
      task = await this.coordinator.projectCurrentInteraction(
        task,
        resumed.draft,
      );
    }
    return {
      ...resumed,
      task,
      interaction: task.interaction,
    };
  }

  async patchDraft(input: {
    accountId: string;
    draftId: string;
    patch: AutomationDraftPatch;
    previewRows?: Array<Record<string, unknown>>;
  }) {
    if (!this.canonicalDrafts) {
      throw new Error("canonical-draft-unavailable");
    }
    const current = this.requireDraft(input.draftId, input.accountId);
    if (current.revision !== input.patch.expectedRevision) {
      throw new PipelineDraftConflictError(current);
    }
    const recipeChanges = [
      input.patch.dataSelection
        ? { target: "data" as const, value: input.patch.dataSelection }
        : undefined,
      input.patch.analysis
        ? { target: "analysis" as const, value: input.patch.analysis }
        : undefined,
      input.patch.artifact
        ? { target: "artifact" as const, value: input.patch.artifact }
        : undefined,
      input.patch.delivery
        ? { target: "delivery" as const, value: input.patch.delivery }
        : undefined,
    ].filter((value) => value !== undefined);
    const patchKeys = Object.keys(input.patch).filter(
      (key) => key !== "expectedRevision",
    );
    if (recipeChanges.length === 1 && patchKeys.length === 1) {
      const change = recipeChanges[0]!;
      return this.revise({
        accountId: input.accountId,
        taskId: this.requireTaskForDraft(current).id,
        draftId: input.draftId,
        target: change.target,
        value: change.value,
        previewRows: input.previewRows ?? [],
      });
    }
    const draft = await this.canonicalDrafts.patch(input);
    const task = this.requireTaskForDraft(draft);
    const projected = await this.coordinator.projectCurrentInteraction(
      task,
      draft,
    );
    return { draft, task: projected, interaction: projected.interaction };
  }

  async create(input: {
    accountId: string;
    sessionId?: string;
    title: string;
    targetKey?: string;
    draft: PipelineDraftInput;
    previewRows?: Array<Record<string, unknown>>;
  }) {
    const timestamp = this.now();
    const id = `pipeline-${randomUUID()}`;
    const selected = new Set(input.draft.steps.map((step) => step.capabilityId));
    const capabilitySnapshots = (await this.catalog.list())
      .filter((capability) => selected.has(capability.id))
      .map((capability) => ({
        capabilityId: capability.id,
        version: capability.version,
        fingerprint: capability.fingerprint,
        availabilityAtPreview: capability.availability.state,
        risk: capability.risk,
      }));
    let draft: ExecutionPipelineDraft = {
      ...input.draft,
      id,
      accountId: input.accountId,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      revision: 1,
      skillSnapshots: input.draft.skillSnapshots ?? [],
      capabilitySnapshots,
      reviews: [],
      validation: { status: "not_validated", issues: [] },
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    draft.validation = await this.pipeline.validate(draft);
    // Review hashes must be computed from the same JSON-safe representation
    // that SQLite persists; optional `undefined` members are not part of the
    // durable recipe and therefore cannot be part of an acceptance hash.
    draft = JSON.parse(JSON.stringify(draft)) as ExecutionPipelineDraft;
    draft = this.withPreviewCheckpoints(draft, input.previewRows ?? []);
    draft = this.drafts.create(draft);
    if (this.skillPackages) {
      for (const snapshot of draft.skillSnapshots) {
        if (!this.skillPackages.getVersion(snapshot.skillId, snapshot.version)) {
          continue;
        }
        this.skillPackages.addUsage({
          skillId: snapshot.skillId,
          skillVersion: snapshot.version,
          referenceType: "pipeline_draft",
          referenceId: draft.id,
        });
      }
    }
    let task = this.workflow.start({
      accountId: input.accountId,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      kind:
        input.draft.mode === "automation"
          ? "automation_rule"
          : "execution_pipeline",
      targetKey: input.targetKey ?? id,
      operation: "create",
      title: input.title,
      source: { surface: "agent" },
    });
    task = await this.coordinator.projectCurrentInteraction(task, draft);
    return { draft, task, interaction: task.interaction };
  }

  /**
   * Turn a fully reviewed pipeline into a reusable Skill draft. The pipeline
   * is loaded from the trusted repository so a model or renderer cannot inject
   * arbitrary mail data, hashes, or dependencies into the generated package.
   */
  createSkillDraftFromPipeline(input: {
    accountId: string;
    pipelineDraftId: string;
    skillId: string;
    version: string;
    displayName: string;
    description: string;
  }) {
    if (!this.skillDrafts) {
      throw new Error("skill-draft-service-unavailable");
    }
    const pipeline = this.requireDraft(input.pipelineDraftId, input.accountId);
    const unresolved = pipeline.reviews.filter((review) => review.status !== "accepted");
    if (unresolved.length > 0) {
      throw new Error("skill-draft-pipeline-review-required");
    }
    if (pipeline.validation.status !== "valid") {
      throw new Error("skill-draft-pipeline-invalid");
    }
    return this.skillDrafts.createFromPipeline({
      pipeline,
      skillId: input.skillId,
      version: input.version,
      displayName: input.displayName,
      description: input.description,
    });
  }

  async respond(input: {
    accountId: string;
    taskId: string;
    draftId: string;
    checkpointId: string;
    message: string;
  }) {
    const task = this.requireTask(input.taskId, input.accountId);
    const draft = this.requireDraft(input.draftId, input.accountId);
    const response = this.reviews.respond(
      draft,
      input.checkpointId,
      input.message,
    );
    if (response.classification === "ambiguous") {
      return {
        draft,
        task,
        classification: response.classification,
        interaction: {
          goalStatus: "needs_input" as const,
          stage: "确认当前预览",
          message: response.nextQuestion,
          impact: "这里只确认当前预览，不会创建规则或发送消息。",
          actions: [],
          previewLinks: [],
        },
      };
    }
    const saved = this.drafts.replace(response.draft, draft.revision);
    const projected = await this.coordinator.projectCurrentInteraction(task, saved);
    return {
      draft: saved,
      task: projected,
      classification: response.classification,
      interaction: projected.interaction,
    };
  }

  async revise(input: {
    accountId: string;
    taskId: string;
    draftId: string;
    target: ReviewTarget;
    value: unknown;
    previewRows?: Array<Record<string, unknown>>;
  }) {
    const task = this.requireTask(input.taskId, input.accountId);
    const current = this.requireDraft(input.draftId, input.accountId);
    const nextValue = bumpVersion(input.value, current, input.target);
    const preview = this.createPreview(
      current.id,
      input.target,
      nextValue,
      input.previewRows ?? [],
    );
    const revised = this.reviews.revise(
      current,
      input.target,
      nextValue,
      preview,
    );
    revised.validation = await this.pipeline.validate(revised);
    const saved = this.drafts.replace(revised, current.revision);
    const projected = await this.coordinator.projectCurrentInteraction(task, saved);
    return { draft: saved, task: projected, interaction: projected.interaction };
  }

  async executeOneShot(input: {
    accountId: string;
    draftId: string;
  }) {
    const draft = this.requireDraft(input.draftId, input.accountId);
    if (draft.mode !== "one_shot") throw new Error("one-shot-draft-required");
    const readiness = await this.coordinator.readiness(
      this.requireTaskForDraft(draft),
      draft,
    );
    if (!readiness.ready) return { ok: false, readiness };
    const result = await this.pipeline.executeOneShot(draft);
    const acceptedPreviews = draft.reviews
      .filter(
        (review) =>
          review.status === "accepted" &&
          !!review.previewId &&
          !!review.previewUrl,
      )
      .map((review) => ({
        id: review.previewId!,
        label: `${review.target} preview`,
        url: review.previewUrl!,
        mediaType:
          review.target === "artifact"
            ? draft.artifact?.format ?? "html"
            : ("text" as const),
        version: review.targetVersion,
        contentHash: review.contentHash,
      }));
    const task = this.workflow.completeOneShot({
      taskId: this.requireTaskForDraft(draft).id,
      accountId: draft.accountId,
      expectedRevision: this.requireTaskForDraft(draft).revision,
      pipelineDraftId: draft.id,
      runId: result.runId,
      summary: "本次邮件整理与产物生成已完成。",
      previewLinks: acceptedPreviews,
      warnings: result.steps.flatMap((step) => step.result.warnings),
    });
    const artifacts = this.publishOneShotArtifacts(draft, result);
    return {
      ok: true,
      result,
      task,
      interaction: task.interaction,
      artifacts,
      artifact: artifacts.at(-1),
    };
  }

  async authorizeAndCommit(input: {
    accountId: string;
    taskId: string;
    message: string;
    snapshotId?: string;
    ruleHash?: string;
  }) {
    let task = this.requireTask(input.taskId, input.accountId);
    if (task.status !== "awaiting_final_confirmation") {
      const draftId = task.pipelineDraftId;
      if (!draftId) throw new Error("configuration-pipeline-draft-missing");
      task = await this.coordinator.projectCurrentInteraction(
        task,
        this.requireDraft(draftId, input.accountId),
      );
      if (task.status !== "awaiting_final_confirmation") {
        return { committed: false, task, interaction: task.interaction };
      }
    }
    const snapshot = task.confirmationSnapshot!;
    if (classifyFinalAuthorization(input.message) === "confirm") {
      const draft = this.requireDraft(snapshot.pipelineDraftId, input.accountId);
      if (draft.sourceRuleId) {
        const source = this.rules.getV2(draft.sourceRuleId);
        if (!source) throw new Error("legacy-automation-upgrade-not-supported");
        if (draft.sourceRuleVersion === undefined) throw new Error("automation-source-version-required");
        if (source.archivedAt || source.accountId !== draft.accountId || source.version !== draft.sourceRuleVersion) {
          throw new Error("automation-source-rule-stale");
        }
      }
    }
    task = await this.coordinator.authorizeFinal({
      task,
      message: input.message,
      snapshotId: input.snapshotId ?? snapshot.id,
      ruleHash: input.ruleHash ?? snapshot.ruleHash,
    });
    if (task.status !== "committing") {
      return { committed: false, task, interaction: task.interaction };
    }
    task = await this.coordinator.commitAndVerify({
      task,
      adapter: {
        commit: async ({ draft, compiled }) => {
          if (!compiled.trigger) throw new Error("automation-trigger-required");
          // A V1 source cannot yet be replaced atomically. Creating a new
          // enabled V2 rule here would leave the original running as well.
          if (draft.sourceRuleId && !this.rules.getV2(draft.sourceRuleId)) {
            throw new Error("legacy-automation-upgrade-not-supported");
          }
          const filters = draft.dataSelection
            ? compileDataSelectionFilters(draft.dataSelection)
            : { conditions: {}, conditionRules: [] };
          const preview = await this.ruleService.preview({
            schemaVersion: 2,
            accountId: draft.accountId,
            name: task.title,
            enabled: true,
            owner: draft.owner,
            accountScope: draft.accountScope,
            templateBinding: draft.templateBinding,
            trigger: compiled.trigger,
            conditions: filters.conditions,
            conditionMode: filters.conditionMode,
            conditionRules: filters.conditionRules,
            collection: collectionFrom(draft),
            pipeline: compiled.pipeline,
            skillSnapshots: draft.skillSnapshots,
            dataSelectionRecipe: draft.dataSelection,
            analysisRecipe: draft.analysis,
            artifactRecipe: draft.artifact,
            deliveryPlan: draft.delivery,
            acceptedReviews: draft.reviews
              .filter((review) => review.status === "accepted")
              .map((review) => ({
                checkpointId: review.id,
                target: review.target,
                targetVersion: review.targetVersion,
                contentHash: review.contentHash,
              })),
            compiledPipelineHash: compiled.hash,
          });
          const previewRule = preview.normalizedRule;
          // The source row, not editable draft metadata, determines whether
          // this replaces an existing rule.
          const existing = draft.sourceRuleId
            ? this.rules.getV2(draft.sourceRuleId)
            : null;
          if (draft.sourceRuleId && (!existing || existing.archivedAt || existing.accountId !== draft.accountId)) {
            throw new Error("automation-source-rule-stale");
          }
          if (existing && draft.sourceRuleVersion === undefined) {
            throw new Error("automation-source-version-required");
          }
          const rule = existing
            ? this.rules.replaceV2(
                existing.id,
                previewRule,
                draft.sourceRuleVersion!,
              )
            : await this.ruleService.commit({
                accountId: draft.accountId,
                previewId: preview.previewId,
                ruleHash: preview.ruleHash,
              });
          return {
            resourceId: rule.id,
            version: rule.version,
            hash: compiled.hash,
            value: rule,
          };
        },
        reload: async (resourceId) => this.rules.getV2(resourceId),
        verify: async ({ expected, actual }) => {
          let visible = true;
          if (this.unified) {
            try {
              const detail = this.unified.detail(actual.id, {
                accountId: expected.draft.accountId,
                profileId: "default",
              });
              visible = detail.id === actual.id;
            } catch {
              visible = false;
            }
          }
          return {
          valid:
            visible &&
            actual.accountId === expected.draft.accountId &&
            actual.enabled &&
            actual.compiledPipelineHash === expected.confirmation.ruleHash &&
            JSON.stringify(actual.skillSnapshots ?? []) ===
              JSON.stringify(expected.draft.skillSnapshots) &&
            JSON.stringify(actual.deliveryPlan ?? null) ===
              JSON.stringify(expected.draft.delivery ?? null),
          };
        },
      },
    });
    return { committed: true, task, interaction: task.interaction };
  }

  private withPreviewCheckpoints(
    draft: ExecutionPipelineDraft,
    rows: Array<Record<string, unknown>>,
  ): ExecutionPipelineDraft {
    const previews = Object.fromEntries(
      (["data", "analysis", "artifact", "delivery"] as ReviewTarget[])
        .filter((target) => valueFor(draft, target))
        .map((target) => [
          target,
          this.createPreview(draft.id, target, valueFor(draft, target), rows),
        ]),
    );
    return this.reviews.synchronizeCheckpoints(draft, previews);
  }

  private createPreview(
    pipelineId: string,
    target: ReviewTarget,
    value: unknown,
    rows: Array<Record<string, unknown>>,
  ) {
    if (target === "data") {
      return this.previews.createDataPreview({
        pipelineId,
        title: "数据范围预览",
        matches: rows.slice(0, 10).map((row, index) => ({
          emailId: String(row.emailId ?? `sample-${index + 1}`),
          subject: String(row.subject ?? "匹配邮件"),
          receivedAt: String(row.receivedAt ?? ""),
          reason: "符合当前邮件范围与筛选条件",
        })),
      });
    }
    if (target === "analysis") {
      const recipe = value as ExecutionPipelineDraft["analysis"];
      const operations = [
        ...(recipe?.metrics.map((metric) => metric.label) ?? []),
        ...(recipe?.modelTasks.map((task) => task.id) ?? []),
        ...(recipe?.conclusions.map((conclusion) => conclusion.id) ?? []),
      ];
      return this.previews.createAnalysisPreview({
        pipelineId,
        title: "分析结果预览",
        rows,
        provenance: rows.map((row, index) => ({
          outputPath: `rows.${index}`,
          emailIds: [String(
            row.emailId ?? row.sourceEmailId ?? `sample-${index + 1}`,
          )],
        })),
        summary: operations.length > 0
          ? `当前预览包含 ${rows.length} 行数据；将执行：${operations.join("、")}。`
          : `当前预览包含 ${rows.length} 行数据。`,
      });
    }
    if (target === "delivery") {
      const plan = value as ExecutionPipelineDraft["delivery"];
      const destinations = plan?.destinations
        .filter((destination) => destination.enabled)
        .map((destination) => deliveryDestinationLabel(destination.type)) ?? [];
      const projections = [
        plan?.content.includeSummary ? "摘要" : undefined,
        plan?.content.includeImage ? "图片" : undefined,
        plan?.content.includeArtifactLink ? "产物链接" : undefined,
        plan?.content.includeFullArtifact ? "完整内容" : undefined,
      ].filter((item): item is string => !!item);
      return this.previews.createBotMessagePreview({
        pipelineId,
        title: "投递内容预览",
        body: projections.length > 0
          ? `将投递${projections.join("、")}。`
          : "当前投递内容为空。",
        destination: destinations.join("、") || "尚未选择投递目的地",
      });
    }
    const artifact = value as ExecutionPipelineDraft["artifact"];
    const preview = deriveArtifactPreviewSpec(artifact, rows);
    return this.previews.createArtifactPreview({
      pipelineId,
      title: artifact?.title ?? "日报预览",
      format: artifact?.format ?? "html",
      rows,
      xField: preview.xField,
      series: preview.series,
      textSummary: preview.textSummary,
    });
  }

  private requireTask(id: string, accountId: string) {
    const task = this.workflow.get(id, accountId);
    if (!task) throw new Error("configuration-task-not-found");
    return task;
  }

  private requireDraft(id: string, accountId: string) {
    const draft = this.drafts.get(id, accountId);
    if (!draft) throw new Error("pipeline-draft-not-found");
    return draft;
  }

  private requireTaskForDraft(draft: ExecutionPipelineDraft) {
    const task = this.workflow
      .list(draft.accountId, 100)
      .find((item) => item.pipelineDraftId === draft.id);
    if (!task) throw new Error("configuration-task-not-found");
    return task;
  }

  private publishOneShotArtifacts(
    draft: ExecutionPipelineDraft,
    result: Awaited<ReturnType<ExecutionPipelineService["executeOneShot"]>>,
  ) {
    if (!this.artifactDelivery) return [];
    const references = Object.values(result.outputs)
      .filter(isArtifactReference)
      .filter(
        (reference, index, all) =>
          all.findIndex(
            (candidate) =>
              candidate.artifactId === reference.artifactId &&
              candidate.version === reference.version,
          ) === index,
      );
    return references.flatMap((reference) => {
      const manifest = this.artifactDelivery!.artifacts.getManifest(
        reference.artifactId,
        reference.version,
        draft.accountId,
      );
      if (!manifest) return [];
      const existingMessage = this.artifactDelivery!.messages.findByArtifact(
        reference.artifactId,
        reference.version,
        draft.accountId,
      );
      const message = existingMessage ?? this.artifactDelivery!.messages.create({
        accountId: draft.accountId,
        owner: draft.owner,
        sourceType: "agent",
        sourceRuleId: `agent-one-shot:${draft.id}:${reference.artifactId}`,
        sourceRunId: result.runId,
        type: "analysis",
        severity: "success",
        title: manifest.title,
        preview: manifest.preview,
        content: [
          {
            type: "paragraph",
            text: manifest.preview || "Agent 已生成可反复查看的完整产物。",
          },
        ],
        references: [
          { type: "automationRun", id: result.runId, label: "本次 Agent 执行" },
        ],
        interactions: [
          {
            type: "openArtifact",
            artifactId: reference.artifactId,
            version: reference.version,
			label: "应用内打开",
          },
        ],
        artifact: {
          id: reference.artifactId,
          version: reference.version,
          kind: reference.kind,
          contentHash: reference.contentHash,
        },
        delayed: false,
      });
      return [
        {
          artifactId: reference.artifactId,
          version: reference.version,
          kind: reference.kind,
          contentHash: reference.contentHash,
          title: manifest.title,
          preview: manifest.preview,
          applicationMessageId: message.id,
        },
      ];
    });
  }
}

function isArtifactReference(value: unknown): value is AutomationArtifactReference {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<AutomationArtifactReference>;
  return (
    candidate.type === "artifact-reference" &&
    typeof candidate.artifactId === "string" &&
    Number.isInteger(candidate.version) &&
    typeof candidate.contentHash === "string" &&
    (candidate.kind === "brief" ||
      candidate.kind === "report" ||
      candidate.kind === "dashboard" ||
      candidate.kind === "deck")
  );
}

function valueFor(draft: ExecutionPipelineDraft, target: ReviewTarget) {
  return target === "data"
    ? draft.dataSelection
    : target === "analysis"
      ? draft.analysis
      : target === "artifact"
        ? draft.artifact
        : draft.delivery;
}

function bumpVersion(
  value: unknown,
  draft: ExecutionPipelineDraft,
  target: ReviewTarget,
) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const current = valueFor(draft, target);
  const version =
    current && "version" in current && typeof current.version === "number"
      ? current.version + 1
      : draft.revision + 1;
  return { ...(value as Record<string, unknown>), version };
}

function collectionFrom(draft: ExecutionPipelineDraft): AutomationProcessing | undefined {
  const selection = draft.dataSelection;
  if (!selection) return undefined;
  if (
    selection.scope.type === "current_mail" ||
    selection.scope.type === "current_thread"
  ) {
    return { mode: "perMessage" };
  }
  const scope =
    selection.scope.type === "calendar_day"
      ? {
          type: "calendarDay" as const,
          timezone: selection.scope.timezone,
          limit: selection.limits.maxMessages,
        }
      : selection.scope.type === "rolling_window"
        ? {
            type: "rollingWindow" as const,
            amount: selection.scope.amount,
            unit: selection.scope.unit,
            limit: selection.limits.maxMessages,
          }
        : selection.scope.type === "previous_schedule_window"
          ? {
              type: "previousScheduleWindow" as const,
              ...(selection.scope.maxLookback
                ? { maxLookback: selection.scope.maxLookback }
                : {}),
              limit: selection.limits.maxMessages,
            }
          : undefined;
  return { mode: "collection", ...(scope ? { scope } : {}) };
}

export function deriveArtifactPreviewSpec(
  artifact: ExecutionPipelineDraft["artifact"],
  rows: Array<Record<string, unknown>>,
): {
  xField?: string;
  series: Array<{ field: string; label: string; color?: string }>;
  textSummary: string;
} {
  const chart = artifact?.components.find((component) =>
    component.type === "line_chart" || component.type === "bar_chart",
  );
  const binding = chart?.binding &&
    typeof chart.binding === "object" &&
    !Array.isArray(chart.binding)
    ? chart.binding
    : {};
  const row = rows[0] ?? {};
  const inferredX = Object.keys(row).find((field) =>
    typeof row[field] === "string",
  );
  const xField = textValue(binding.xField) ?? textValue(binding.x) ?? inferredX;
  const configured = [
    ...(Array.isArray(binding.valueFields) ? binding.valueFields : []),
    ...(Array.isArray(binding.series) ? binding.series : []),
    binding.valueField,
  ].filter((value): value is string =>
    typeof value === "string" && value.trim().length > 0,
  );
  const inferred = Object.keys(row)
    .filter((field) => field !== xField && typeof row[field] === "number")
    .slice(0, 3);
  const fields = [...new Set(configured.length > 0 ? configured : inferred)];
  const colors = ["#2563eb", "#dc2626", "#059669"];
  return {
    ...(xField ? { xField } : {}),
    series: fields.map((field, index) => ({
      field,
      label: field,
      color: colors[index % colors.length],
    })),
    textSummary: `${artifact?.title ?? "产物"}；预览 ${rows.length} 行数据${fields.length > 0 ? `，展示 ${fields.join("、")}` : ""}。`,
  };
}

function deliveryDestinationLabel(
  type: NonNullable<ExecutionPipelineDraft["delivery"]>["destinations"][number]["type"],
): string {
  return {
    conversation: "当前会话",
    message_center: "消息中心",
    feishu_bot: "飞书 Bot",
    wecom_bot: "企业微信 Bot",
    connected_bot: "已连接 Bot",
  }[type];
}

function textValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
