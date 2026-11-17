import { randomUUID } from "node:crypto";
import type { AutomationPipelineStep, AutomationValue } from "../../../shared/wemail/automation.js";
import { resolveStepInput } from "./AutomationBindingResolver.js";
import type { AutomationProviderContext, AutomationStepResult } from "./providers/AutomationProvider.js";
import type { AutomationProviderRegistry } from "./providers/AutomationProviderRegistry.js";

export interface PipelineExecutionResult {
  ok: boolean;
  outcome: "succeeded" | "partially_succeeded" | "failed";
  steps: Array<{
    stepId: string;
    inputSummary: unknown;
    result: AutomationStepResult;
  }>;
  outputs: Record<string, AutomationValue | undefined>;
}

export interface PipelineExecutionObserver {
  onStepStarted?: (
    step: AutomationPipelineStep,
    inputSummary: unknown,
  ) => void | Promise<void>;
  onStepCompleted?: (
    step: AutomationPipelineStep,
    inputSummary: unknown,
    result: AutomationStepResult,
  ) => void | Promise<void>;
}

export class AutomationPipelineExecutor {
  constructor(private readonly registry: AutomationProviderRegistry) {}

  async execute(
    steps: AutomationPipelineStep[],
    context: AutomationProviderContext,
    observer?: PipelineExecutionObserver,
  ): Promise<PipelineExecutionResult> {
    const results: PipelineExecutionResult["steps"] = [];
    for (const step of steps) {
      const input = resolveStepInput(step.input, context);
      const inputSummary = summarizeStepInput(input);
      await observer?.onStepStarted?.(step, inputSummary);
      let compiled: Awaited<ReturnType<AutomationProviderRegistry["compile"]>>;
      try {
        compiled = await this.registry.compile(step);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const code = message.includes("capability-drift")
          ? "capability-drift"
          : message.includes("unavailable")
            ? "capability-unavailable"
            : "execution-failed";
        const result = failedResult(
          {
            provider: step.provider,
            id: step.capability,
            fingerprint: step.capabilityFingerprint ?? "unavailable",
          },
          code,
          message,
        );
        results.push({ stepId: step.id, inputSummary, result });
        await observer?.onStepCompleted?.(step, inputSummary, result);
        context.steps[step.id] = { status: "failed" };
        if ((step.onError?.policy ?? "stop") === "stop") break;
        continue;
      }
      const errors = await this.registry.get(step.provider)!.validate(compiled, input, context);
      let result: AutomationStepResult;
      if (errors.length) {
        result = failedResult(compiled.descriptor, "invalid-input", errors.join("; "));
      } else if (context.dryRun) {
        const preview = await this.registry.get(step.provider)!.preview(compiled, input, context);
        const now = new Date().toISOString();
        result = {
          status: "succeeded",
          output: preview.output as AutomationValue | undefined,
          warnings: preview.warnings,
          sideEffects: preview.sideEffects.map((type) => ({ type, summary: preview.plannedOperation })),
          audit: {
            provider: compiled.descriptor.provider,
            capability: compiled.descriptor.id,
            capabilityFingerprint: compiled.descriptor.fingerprint,
            startedAt: now,
            completedAt: now,
            durationMs: 0,
          },
        };
      } else {
        result = await this.executeWithRetry(compiled, input, context);
      }
      results.push({ stepId: step.id, inputSummary, result });
      await observer?.onStepCompleted?.(step, inputSummary, result);
      context.steps[step.id] = { status: result.status, output: result.output };
      if (result.status === "failed" && (step.onError?.policy ?? "stop") === "stop") break;
    }
    const failed = results.filter((item) => item.result.status === "failed").length;
    const succeeded = results.filter((item) => item.result.status === "succeeded").length;
    const outcome = failed === 0
      ? "succeeded"
      : succeeded > 0
        ? "partially_succeeded"
        : "failed";
    return {
      ok: outcome === "succeeded",
      outcome,
      steps: results,
      outputs: Object.fromEntries(Object.entries(context.steps).map(([id, state]) => [id, state.output])),
    };
  }

  private async executeWithRetry(
    step: Awaited<ReturnType<AutomationProviderRegistry["compile"]>>,
    input: Record<string, unknown>,
    context: AutomationProviderContext,
  ): Promise<AutomationStepResult> {
    const provider = this.registry.get(step.provider)!;
    const maxAttempts = Math.max(1, Math.min(3, (step.onError?.retries ?? 0) + 1));
    let last: AutomationStepResult | undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      last = await provider.execute(step, input, context);
      if (last.status !== "failed") return last;
      if (!last.error?.retryable || !last.error.retrySafe) return last;
    }
    return last ?? failedResult(step.descriptor, "execution-failed", `missing-step-result:${randomUUID()}`);
  }
}

function summarizeStepInput(value: unknown, depth = 0): unknown {
  if (depth > 3) return "[bounded]";
  if (Array.isArray(value)) {
    return {
      count: value.length,
      sample: value.slice(0, 3).map((item) => summarizeStepInput(item, depth + 1)),
    };
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (record.type === "mail-collection" && Array.isArray(record.messages)) {
      return {
        type: "mail-collection",
        count: record.messages.length,
        emailIds: record.messages
          .slice(0, 20)
          .map((item) =>
            item && typeof item === "object"
              ? (item as Record<string, unknown>).emailId
              : undefined,
          )
          .filter((item): item is string => typeof item === "string"),
      };
    }
    return Object.fromEntries(
      Object.entries(record)
        .filter(
          ([key]) =>
            !/body|html|content|token|secret|password|authorization/i.test(key),
        )
        .slice(0, 20)
        .map(([key, item]) => [
          key,
          summarizeStepInput(item, depth + 1),
        ]),
    );
  }
  if (typeof value === "string") return value.slice(0, 200);
  return value;
}

function failedResult(
  descriptor: { provider: string; id: string; fingerprint: string },
  code:
    | "invalid-input"
    | "execution-failed"
    | "capability-unavailable"
    | "capability-drift",
  message: string,
): AutomationStepResult {
  const now = new Date().toISOString();
  return {
    status: "failed",
    error: { code, message, retryable: false, retrySafe: false },
    warnings: [],
    sideEffects: [],
    audit: {
      provider: descriptor.provider,
      capability: descriptor.id,
      capabilityFingerprint: descriptor.fingerprint,
      startedAt: now,
      completedAt: now,
      durationMs: 0,
    },
  };
}
