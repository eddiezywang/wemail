import { randomUUID } from "node:crypto";
import type {
  AutomationDraftPatch,
  AutomationOwner,
} from "../../../shared/wemail/automationCenter.js";
import type {
  AutomationRule,
  AutomationRuleV2,
  AutomationTrigger,
} from "../../../shared/wemail/automation.js";
import type {
  AgentCapabilityDescriptor,
  DeliveryPlan,
  ExecutionPipelineDraft,
  WorkflowPipelineStepDraft,
} from "../../../shared/wemail/skillCenter.js";
import type { AutomationRuleRepository } from "./AutomationRuleRepository.js";
import type { AgentCapabilityCatalogService } from "../workflows/AgentCapabilityCatalogService.js";
import {
  PipelineDraftConflictError,
  type ExecutionPipelineDraftRepository,
} from "../workflows/ExecutionPipelineDraftRepository.js";
import type { ExecutionPipelineService } from "../workflows/ExecutionPipelineService.js";
import { PipelineReviewService } from "../workflows/PipelineReviewService.js";

function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export class CanonicalAutomationDraftService {
  private readonly reviews: PipelineReviewService;

  constructor(
    private readonly drafts: ExecutionPipelineDraftRepository,
    private readonly rules: AutomationRuleRepository,
    private readonly catalog: AgentCapabilityCatalogService,
    private readonly pipeline: ExecutionPipelineService,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {
    this.reviews = new PipelineReviewService(now);
  }

  async resumeFromRule(input: {
    ruleId: string;
    accountId: string;
    sessionId?: string;
  }): Promise<{ draft: ExecutionPipelineDraft; resumed: boolean; upgrade: boolean }> {
    const existing = this.drafts.findBySourceRule(
      input.ruleId,
      input.accountId,
    );
    if (existing) {
      return {
        draft: existing,
        resumed: true,
        upgrade: existing.sourceRuleVersion === 1,
      };
    }
    const v2 = this.rules.getV2(input.ruleId);
    const v1 = v2 ? null : this.rules.get(input.ruleId);
    const source = v2 ?? v1;
    if (!source || source.accountId !== input.accountId) {
      throw new Error("automation-rule-not-found");
    }
    const timestamp = this.now();
    const capabilities = await this.catalog.list();
    const draft = await this.fromRule(
      source,
      capabilities,
      timestamp,
      input.sessionId,
    );
    return {
      draft: this.drafts.create(draft),
      resumed: false,
      upgrade: !v2,
    };
  }

  get(draftId: string, accountId: string): ExecutionPipelineDraft | null {
    return this.drafts.get(draftId, accountId);
  }

  async patch(input: {
    draftId: string;
    accountId: string;
    patch: AutomationDraftPatch;
  }): Promise<ExecutionPipelineDraft> {
    const current = this.drafts.get(input.draftId, input.accountId);
    if (!current) throw new Error("pipeline-draft-not-found");
    const patch = input.patch;
    if (current.revision !== patch.expectedRevision) {
      throw new PipelineDraftConflictError(current);
    }
    const next: ExecutionPipelineDraft = {
      ...current,
      revision: current.revision + 1,
      updatedAt: this.now(),
      ...(patch.owner ? { owner: patch.owner } : {}),
      ...(patch.accountScope ? { accountScope: patch.accountScope } : {}),
      ...(patch.name || patch.description
        ? {
            advancedPolicy: {
              ...(current.advancedPolicy ?? {}),
              ...(patch.name ? { name: patch.name } : {}),
              ...(patch.description ? { description: patch.description } : {}),
            },
          }
        : {}),
      ...(patch.trigger ? { trigger: patch.trigger } : {}),
      ...(patch.dataSelection ? { dataSelection: patch.dataSelection } : {}),
      ...(hasOwn(patch, "analysis")
        ? { analysis: patch.analysis ?? undefined }
        : {}),
      ...(hasOwn(patch, "artifact")
        ? { artifact: patch.artifact ?? undefined }
        : {}),
      ...(patch.delivery ? { delivery: patch.delivery } : {}),
      ...(patch.templateConfiguration
        ? { templateConfiguration: patch.templateConfiguration }
        : {}),
      ...(patch.advancedPolicy
        ? {
            advancedPolicy: {
              ...(current.advancedPolicy ?? {}),
              ...patch.advancedPolicy,
            },
          }
        : {}),
      ...(patch.steps ? { steps: patch.steps } : {}),
      reviews: current.reviews.map((review) => ({ ...review })),
      validation: { status: "not_validated", issues: [] },
    };
    const changedTargets = new Set(
      [
        patch.dataSelection ? "data" : undefined,
        hasOwn(patch, "analysis") ? "analysis" : undefined,
        hasOwn(patch, "artifact") ? "artifact" : undefined,
        patch.delivery ? "delivery" : undefined,
      ].filter(
        (value): value is "data" | "analysis" | "artifact" | "delivery" =>
          !!value,
      ),
    );
    for (const review of next.reviews) {
      if (
        review.status === "accepted" &&
        (changedTargets.has(review.target) ||
          review.dependsOn.some((dependency) => changedTargets.has(dependency)))
      ) {
        review.status = "stale";
        changedTargets.add(review.target);
      }
    }
    const synchronized = this.reviews.synchronizeCheckpoints(next);
    synchronized.validation = await this.pipeline.validate(synchronized);
    return this.drafts.replace(synchronized, patch.expectedRevision);
  }

  private async fromRule(
    source: AutomationRule | AutomationRuleV2,
    capabilities: AgentCapabilityDescriptor[],
    timestamp: string,
    sessionId?: string,
  ): Promise<ExecutionPipelineDraft> {
    const v2 = isV2(source);
    const steps = v2
      ? source.pipeline.map((step) =>
          toDraftStep(step, capabilities),
        )
      : legacySteps(source, capabilities);
    const owner: AutomationOwner =
      v2 && source.owner
        ? source.owner
        : { type: "account", accountId: source.accountId };
    let draft: ExecutionPipelineDraft = {
      id: `pipeline-${randomUUID()}`,
      accountId: source.accountId,
      owner,
      accountScope:
        v2 && source.accountScope
          ? source.accountScope
          : { type: "currentAccount", accountId: source.accountId },
      sourceRuleId: source.id,
      sourceRuleVersion: v2 ? source.version : 1,
      ...(v2 && source.templateBinding
        ? { templateBinding: source.templateBinding }
        : {}),
      ...(sessionId ? { sessionId } : {}),
      revision: 1,
      mode: "automation",
      trigger: toDraftTrigger(source.trigger),
      ...(v2 && source.dataSelectionRecipe
        ? { dataSelection: source.dataSelectionRecipe }
        : !v2 && source.processing
          ? { dataSelection: legacyDataSelection(source) }
          : {}),
      ...(v2 && source.analysisRecipe
        ? { analysis: source.analysisRecipe }
        : {}),
      ...(v2 && source.artifactRecipe
        ? { artifact: source.artifactRecipe }
        : {}),
      ...(v2 && source.deliveryPlan
        ? { delivery: source.deliveryPlan }
        : !v2
          ? { delivery: legacyDelivery(source) }
          : {}),
      steps,
      skillSnapshots: v2 ? source.skillSnapshots ?? [] : [],
      capabilitySnapshots: capabilities
        .filter((capability) =>
          steps.some((step) => step.capabilityId === capability.id),
        )
        .map((capability) => ({
          capabilityId: capability.id,
          version: capability.version,
          fingerprint: capability.fingerprint,
          availabilityAtPreview: capability.availability.state,
          risk: capability.risk,
        })),
      reviews: [],
      validation: { status: "not_validated", issues: [] },
      advancedPolicy: {
        name: source.name,
        ...(v2 && source.description ? { description: source.description } : {}),
        ...(v2
          ? { compiledPipelineHash: source.compiledPipelineHash }
          : { upgradeFromLegacy: true, legacyActions: source.actions }),
      },
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    draft.validation = await this.pipeline.validate(draft);
    draft = this.reviews.synchronizeCheckpoints(draft);
    return JSON.parse(JSON.stringify(draft)) as ExecutionPipelineDraft;
  }
}

function isV2(
  source: AutomationRule | AutomationRuleV2,
): source is AutomationRuleV2 {
  return "schemaVersion" in source && source.schemaVersion === 2;
}

function toDraftTrigger(
  trigger: AutomationTrigger,
): ExecutionPipelineDraft["trigger"] {
  if (trigger.type === "manual") {
    return { event: "manual", timing: { type: "immediate" } };
  }
  if (trigger.type === "mailReceived") {
    return {
      event: "mail.received",
      timing: {
        ...(trigger.execution ?? { type: "immediate" }),
      } as Record<string, unknown>,
    };
  }
  return {
    event: "schedule",
    timing: trigger.schedule ?? {
      type: "interval",
      intervalMinutes: trigger.intervalMinutes ?? 60,
    },
  };
}

function toDraftStep(
  step: AutomationRuleV2["pipeline"][number],
  capabilities: AgentCapabilityDescriptor[],
): WorkflowPipelineStepDraft {
  const executorKey = `${step.provider}/${step.capability}`;
  const capability = capabilities.find(
    (item) => item.executorKey === executorKey,
  );
  return {
    id: step.id,
    capabilityId: capability?.id ?? `unavailable.${step.capability}`,
    ...(step.name ? { name: step.name } : {}),
    input: step.input,
    onError: {
      policy: step.onError?.policy ?? "stop",
      retries: step.onError?.retries ?? 0,
    },
  };
}

function legacyDataSelection(
  source: AutomationRule,
): NonNullable<ExecutionPipelineDraft["dataSelection"]> {
  const scope = source.processing?.scope;
  return {
    version: 1,
    source: "mail",
    scope:
      scope?.type === "calendarDay"
        ? {
            type: "calendar_day",
            timezone: scope.timezone,
          }
        : scope?.type === "rollingWindow"
          ? {
              type: "rolling_window",
              amount: scope.amount,
              unit: scope.unit,
            }
          : scope?.type === "previousScheduleWindow"
            ? { type: "previous_schedule_window" }
            : { type: "rolling_window", amount: 1, unit: "day" },
    filters: Object.entries(source.conditions).map(([field, value]) => ({
      field,
      operator: "equals",
      value,
    })),
    limits: { maxMessages: scope?.limit ?? 1_000 },
  };
}

function legacyDelivery(source: AutomationRule): DeliveryPlan {
  const destinations: DeliveryPlan["destinations"] = [];
  if (
    source.actions.some((action) => action.type === "publishApplicationMessage")
  ) {
    destinations.push({ type: "message_center", enabled: true });
  }
  if (source.actions.some((action) => action.type === "publishBotMessage")) {
    destinations.push({ type: "connected_bot", enabled: true });
  }
  return {
    version: 1,
    destinations,
    content: {
      includeSummary: true,
      includeImage: false,
      includeArtifactLink: true,
    },
    fallbackPolicy: {
      type: "continue",
      messageCenterRequired: destinations.some(
        (destination) => destination.type === "message_center",
      ),
    },
  };
}

function legacySteps(
  source: AutomationRule,
  capabilities: AgentCapabilityDescriptor[],
): WorkflowPipelineStepDraft[] {
  const ids: string[] = [];
  if (
    source.processing?.processors?.some(
      (processor) => processor.type === "mailDigest",
    )
  ) {
    ids.push("analysis.mailDigest");
  }
  if (
    source.actions.some((action) => action.type === "publishApplicationMessage")
  ) {
    ids.push("delivery.messageCenter.publish");
  }
  if (source.actions.some((action) => action.type === "publishBotMessage")) {
    ids.push("delivery.bot.sendConnected");
  }
  return ids.map((capabilityId, index) => ({
    id: `upgrade-step-${index + 1}`,
    capabilityId:
      capabilities.find((capability) => capability.id === capabilityId)?.id ??
      capabilityId,
    input: {},
    onError: { policy: "stop", retries: 0 },
  }));
}
