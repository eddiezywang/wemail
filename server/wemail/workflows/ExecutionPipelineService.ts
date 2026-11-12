import { createHash, randomUUID } from "node:crypto";
import type {
  AutomationBindingExpression,
  AutomationPipelineStep,
  AutomationTrigger,
} from "../../../shared/wemail/automation.js";
import type {
  AgentCapabilityDescriptor,
  ExecutionPipelineDraft,
  PipelineValidationState,
  WorkflowValueKind,
} from "../../../shared/wemail/skillCenter.js";
import { AutomationPipelineExecutor } from "../automation/AutomationPipelineExecutor.js";
import type { AutomationProviderRegistry } from "../automation/providers/AutomationProviderRegistry.js";
import { AgentCapabilityCatalogService } from "./AgentCapabilityCatalogService.js";
import {
  validateWorkflowRecipeCoverage,
  validateWorkflowRecipes,
} from "./WorkflowRecipeValidator.js";

export class ExecutionPipelineService {
  private readonly executor: AutomationPipelineExecutor;
  private skillSnapshotValidator:
    | ((snapshots: ExecutionPipelineDraft["skillSnapshots"]) => void)
    | undefined;

  constructor(
    private readonly catalog: AgentCapabilityCatalogService,
    providers: AutomationProviderRegistry,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly resolveOneShotCollection?: (
      draft: ExecutionPipelineDraft,
    ) => Record<string, unknown>,
  ) {
    this.executor = new AutomationPipelineExecutor(providers);
  }

  setSkillSnapshotValidator(
    validator: (snapshots: ExecutionPipelineDraft["skillSnapshots"]) => void,
  ): void {
    this.skillSnapshotValidator = validator;
  }

  async validate(draft: ExecutionPipelineDraft): Promise<PipelineValidationState> {
    const capabilities = new Map(
      (await this.catalog.list()).map((capability) => [capability.id, capability]),
    );
    const issues: PipelineValidationState["issues"] = [
      ...validateWorkflowRecipes(draft),
      ...validateWorkflowRecipeCoverage(draft, capabilities),
    ];
    if (draft.mode === "automation" && !draft.trigger) {
      issues.push({
        path: "trigger",
        code: "trigger-required",
        message: "自动化规则需要触发条件。",
      });
    }
    if (draft.mode === "one_shot" && draft.trigger?.event === "schedule") {
      issues.push({
        path: "trigger",
        code: "one-shot-cannot-schedule",
        message: "一次性执行不能包含定时触发。",
      });
    }
    const ids = new Set<string>();
    let previousOutput: WorkflowValueKind | undefined;
    const stepOutputs = new Map<string, WorkflowValueKind>();
    draft.steps.forEach((step, index) => {
      if (!step.id || ids.has(step.id)) {
        issues.push({
          path: `steps.${index}.id`,
          code: "step-id-invalid",
          message: "步骤 ID 必须存在且唯一。",
        });
      }
      ids.add(step.id);
      const capability = capabilities.get(step.capabilityId);
      if (!capability) {
        issues.push({
          path: `steps.${index}.capabilityId`,
          code: "unknown-capability",
          message: `未知能力：${step.capabilityId}`,
        });
        return;
      }
      if (capability.availability.state !== "ready") {
        issues.push({
          path: `steps.${index}`,
          code: `capability-${capability.availability.state}`,
          message:
            capability.availability.reason ??
            `能力 ${capability.name} 当前不可用。`,
        });
      }
      const referencedKinds = Object.values(step.input).flatMap((binding) => {
        if (
          binding &&
          typeof binding === "object" &&
          !Array.isArray(binding) &&
          (binding as Record<string, unknown>).type === "path" &&
          (binding as Record<string, unknown>).from === "step"
        ) {
          const referencedId = (binding as Record<string, unknown>).stepId;
          const kind =
            typeof referencedId === "string"
              ? stepOutputs.get(referencedId)
              : undefined;
          return kind ? [kind] : [];
        }
        return [];
      });
      const effectiveInputs =
        referencedKinds.length > 0
          ? referencedKinds
          : previousOutput
            ? [previousOutput]
            : [];
      if (
        capability.inputKinds.length > 0 &&
        effectiveInputs.some(
          (kind) => !capability.inputKinds.includes(kind),
        )
      ) {
        issues.push({
          path: `steps.${index}`,
          code: "value-kind-mismatch",
          message: `${effectiveInputs.join("、")} 不能作为 ${capability.name} 的输入。`,
        });
      }
      previousOutput = step.outputKind ?? capability.outputKinds[0] ?? previousOutput;
      if (previousOutput) stepOutputs.set(step.id, previousOutput);
    });
    return {
      status: issues.length === 0 ? "valid" : "invalid",
      issues,
      validatedAt: this.now(),
    };
  }

  async compile(draft: ExecutionPipelineDraft): Promise<{
    trigger?: AutomationTrigger;
    pipeline: AutomationPipelineStep[];
    hash: string;
  }> {
    if (draft.skillSnapshots.length > 0 && this.skillSnapshotValidator) {
      try {
        this.skillSnapshotValidator(draft.skillSnapshots);
      } catch (error) {
        throw new Error(
          `skill-snapshot-stale:${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    const validation = await this.validate(draft);
    if (validation.status !== "valid") {
      throw new Error(
        `pipeline-invalid:${validation.issues.map((issue) => issue.code).join(",")}`,
      );
    }
    const capabilities = new Map(
      (await this.catalog.list()).map((capability) => [capability.id, capability]),
    );
    const pipeline = draft.steps.map((step) => {
      const compiled = compileStep(step, capabilities.get(step.capabilityId)!);
      if (step.capabilityId !== "output.render" || !draft.artifact) {
        if (
          step.capabilityId !== "delivery.bot.sendConnected" ||
          !draft.delivery ||
          (draft.delivery.fallbackPolicy.type !== "first_available" &&
            draft.delivery.fallbackPolicy.type !== "all_available")
        ) {
          return compiled;
        }
        return {
          ...compiled,
          input: {
            ...compiled.input,
            policy: {
              type: "literal" as const,
              value: draft.delivery.fallbackPolicy.type,
            },
            ...(draft.delivery.fallbackPolicy.priority?.length
              ? {
                  priority: {
                    type: "literal" as const,
                    value: draft.delivery.fallbackPolicy.priority.map((platform) =>
                      platform === "feishu_bot" ? "feishu" : "wecom"),
                  },
                }
              : {}),
          },
        };
      }
      return {
        ...compiled,
        input: {
          ...compiled.input,
          artifactRecipe: {
            type: "literal" as const,
            value: draft.artifact,
          },
        },
      };
    });
    const trigger = draft.trigger ? compileTrigger(draft.trigger) : undefined;
    const hash = stableHash({
      trigger,
      pipeline,
      dataSelection: draft.dataSelection,
      analysis: draft.analysis,
      artifact: draft.artifact,
      delivery: draft.delivery,
      skills: draft.skillSnapshots,
      capabilities: draft.capabilitySnapshots,
      reviews: draft.reviews
        .filter((review) => review.status === "accepted")
        .map((review) => ({
          id: review.id,
          targetVersion: review.targetVersion,
          contentHash: review.contentHash,
        })),
    });
    return { ...(trigger ? { trigger } : {}), pipeline, hash };
  }

  async executeOneShot(draft: ExecutionPipelineDraft) {
    if (draft.mode !== "one_shot") throw new Error("one-shot-draft-required");
    if (draft.dataSelection && !this.resolveOneShotCollection) {
      throw new Error("data-selection-runtime-unavailable");
    }
    const compiled = await this.compile(draft);
    const runId = `one-shot-${randomUUID()}`;
    const result = await this.executor.execute(compiled.pipeline, {
      run: {
        id: runId,
        ruleId: "one-shot",
        ruleVersion: 1,
        accountId: draft.accountId,
        occurrenceKey: runId,
        actualStartedAt: this.now(),
        delayed: false,
      },
      trigger: {},
      collection: this.resolveOneShotCollection?.(draft) ?? {},
      steps: {},
      dryRun: false,
    });
    return { runId, pipelineHash: compiled.hash, ...result };
  }
}

function compileStep(
  step: ExecutionPipelineDraft["steps"][number],
  capability: AgentCapabilityDescriptor,
): AutomationPipelineStep {
  if (!capability.executorKey) {
    throw new Error(`capability-has-no-executor:${capability.id}`);
  }
  const separator = capability.executorKey.indexOf("/");
  return {
    id: step.id,
    ...(step.name ? { name: step.name } : {}),
    provider: capability.executorKey.slice(0, separator),
    capability: capability.executorKey.slice(separator + 1),
    capabilityFingerprint: capability.fingerprint,
    input: step.input as Record<string, AutomationBindingExpression>,
    onError: step.onError,
  };
}

export function compileTrigger(
  trigger: NonNullable<ExecutionPipelineDraft["trigger"]>,
): AutomationTrigger {
  if (trigger.event === "manual") return { type: "manual" };
  if (trigger.event === "mail.received") {
    const delay = numberValue(trigger.timing.delayMinutes);
    const nextDayTime = stringValue(trigger.timing.nextDayTime);
    return {
      type: "mailReceived",
      ...(delay
        ? {
            execution: {
              type: "delay" as const,
              amount: delay,
              unit: "minute" as const,
            },
          }
        : {}),
      ...(nextDayTime
        ? {
            execution: {
              type: "nextDayAt" as const,
              timezone: stringValue(trigger.timing.timezone) ?? "Asia/Shanghai",
              localTime: nextDayTime,
            },
          }
        : {}),
    };
  }
  const timezone = stringValue(trigger.timing.timezone) ?? "Asia/Shanghai";
  const localTime = stringValue(trigger.timing.localTime);
  const intervalMinutes = numberValue(trigger.timing.intervalMinutes);
  return localTime
    ? { type: "scheduled", schedule: { type: "daily", timezone, localTime } }
    : {
        type: "scheduled",
        schedule: {
          type: "interval",
          intervalMinutes: Math.max(1, intervalMinutes ?? 60),
        },
      };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stableHash(value: unknown): string {
  return createHash("sha256").update(stable(value)).digest("hex");
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
