import { createHash, randomUUID } from "node:crypto";
import type {
  AutomationRuleV2,
  AutomationValue,
} from "../../../shared/wemail/automation.js";
import type { MailDatabase } from "../database/Database.js";
import {
  AutomationPipelineExecutor,
  type PipelineExecutionResult,
} from "./AutomationPipelineExecutor.js";
import type { AutomationRuleRepository } from "./AutomationRuleRepository.js";
import type { AutomationStepRunRepository } from "./AutomationStepRunRepository.js";
import type { AutomationRuleRuntimeRepository } from "./AutomationRuleRuntimeRepository.js";
import { nextScheduledOccurrence } from "./AutomationSchedule.js";
import type { AutomationProviderRegistry } from "./providers/AutomationProviderRegistry.js";
import type { AutomationCapabilityDescriptor } from "./providers/AutomationProvider.js";
import { schemaHash } from "./providers/AutomationProviderRegistry.js";
import type { CanonicalMailRepository } from "../mail/CanonicalMailRepository.js";
import type {
  EmailIntelligenceResults,
  IntelligenceResultRepository,
} from "../intelligence/IntelligenceResultRepository.js";
import {
  AutomationRunObservabilityService,
  manifestItemContentHash,
  stageForStep,
} from "./AutomationRunObservabilityService.js";
import type {
  SummaryResult,
  SummaryThreadResult,
  TagResult,
} from "../../../shared/wemail/intelligence.js";
import type { MailMessage } from "../../../shared/wemail/mail.js";
import {
  matchesConditionRules,
  matchesStructuredConditions,
} from "./AutomationRuleMatcher.js";

export const SUMMARY_NOTIFICATION_TEMPLATE_ID =
  "wemail.received-mail-summary-notification";

function summaryOccurrenceKey(accountId: string, emailId: string): string {
  return `summary:${JSON.stringify([accountId, emailId])}`;
}

export type AutomationRuleV2Draft = Omit<AutomationRuleV2, "id" | "version" | "createdAt" | "updatedAt" | "authorization" | "capabilitySnapshots"> & {
  authorization?: AutomationRuleV2["authorization"];
  capabilitySnapshots?: AutomationRuleV2["capabilitySnapshots"];
};

export type PipelineAutomationRunResult = PipelineExecutionResult & {
  runId: string;
  status: "running" | "succeeded" | "empty" | "partial" | "failed";
  duplicate?: boolean;
};

export interface PipelineAutomationSummaryManualRunResult {
  ok: boolean;
  outcome: PipelineExecutionResult["outcome"];
  status: "running" | "succeeded" | "empty" | "partial" | "failed";
  mode: "latest-summary-notification";
  runId?: string;
  selectedEmailId?: string;
  matchedCount: number;
  readyCount: number;
  skippedCount: number;
  ignoredReadyCount: number;
  dispatchedCount: number;
  failedCount: number;
  runIds: string[];
  failures: Array<{ emailId: string; error: string }>;
}

export type PipelineAutomationManualRunResult =
  | PipelineAutomationRunResult
  | PipelineAutomationSummaryManualRunResult;

type SummaryResultsReader = Pick<
  IntelligenceResultRepository,
  "findByEmailIds"
>;

interface SummaryNotificationCandidate {
  accountId: string;
  emailId: string;
  mail: MailMessage;
  summary: SummaryResult | SummaryThreadResult;
  tags?: TagResult;
}

export class PipelineAutomationRuleService {
  private readonly executor: AutomationPipelineExecutor;
  private readonly scheduledRuns = new Map<string, Promise<void>>();
  private readonly observability: AutomationRunObservabilityService;
  constructor(private readonly deps: { db: MailDatabase; rules: AutomationRuleRepository; providers: AutomationProviderRegistry; stepRuns: AutomationStepRunRepository; runtime: AutomationRuleRuntimeRepository; accountIds?: () => string[]; accountExists?: (accountId: string) => boolean; mail?: CanonicalMailRepository; intelligenceResults?: SummaryResultsReader; observability?: AutomationRunObservabilityService; now?: () => string }) {
    this.executor = new AutomationPipelineExecutor(deps.providers);
    this.observability =
      deps.observability ??
      new AutomationRunObservabilityService(deps.db, () => this.now());
  }

  async preview(draft: AutomationRuleV2Draft) {
    validateDraft(draft);
    const descriptors = [];
    for (const step of draft.pipeline) {
      const descriptor = await this.deps.providers.resolve(step.provider, step.capability);
      if (!descriptor) throw new Error(`automation-capability-unavailable:${step.provider}/${step.capability}`);
      descriptors.push(descriptor);
    }
    const snapshots = descriptors.map((descriptor) => ({ provider: descriptor.provider, capability: descriptor.id, fingerprint: descriptor.fingerprint, risk: descriptor.risk, inputSchemaHash: schemaHash(descriptor.inputSchema) }));
    const authorization = { capabilities: descriptors.map((descriptor) => ({ provider: descriptor.provider, capability: descriptor.id, fingerprint: descriptor.fingerprint, risk: descriptor.risk, limits: { allowedAccountId: draft.accountId, ...commandPathLimit(descriptor) } })) };
    const normalized = { ...draft, schemaVersion: 2 as const, authorization, capabilitySnapshots: snapshots };
    const context = { run: { id: `preview-${randomUUID()}`, ruleId: "preview", ruleVersion: 1, accountId: draft.accountId, occurrenceKey: "preview", actualStartedAt: this.now(), delayed: false }, trigger: {}, collection: {}, steps: {}, authorization, dryRun: true, owner: draft.owner, accountScope: draft.accountScope };
    const execution = await this.executor.execute(draft.pipeline, context);
    if (!execution.ok) {
      const failed = execution.steps.find((item) => item.result.status === "failed");
      throw new Error(
        `automation-preview-validation-failed:${failed?.stepId ?? "unknown"}:${failed?.result.error?.message ?? "unknown"}`,
      );
    }
    const ruleHash = hash(normalized);
    const previewId = `automation-preview-${randomUUID()}`;
    const expiresAt = new Date(Date.parse(this.now()) + 15 * 60_000).toISOString();
    const result = { previewId, expiresAt, ruleHash, normalizedRule: normalized, capabilitySnapshots: snapshots, steps: execution.steps, warnings: execution.steps.flatMap((item) => item.result.warnings), sideEffects: descriptors.flatMap((item) => item.sideEffects), risk: maxRisk(descriptors.map((item) => item.risk)) };
    this.deps.db.prepare(`INSERT INTO automation_rule_previews (id, account_id, source_rule_id, source_rule_version, normalized_rule_json, rule_hash, capability_fingerprint, preview_json, created_at, expires_at) VALUES (?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?)`).run(previewId, draft.accountId, JSON.stringify(normalized), ruleHash, await this.deps.providers.fingerprint(), JSON.stringify(result), this.now(), expiresAt);
    return result;
  }

  async commit(input: { accountId: string; previewId: string; ruleHash: string }): Promise<AutomationRuleV2> {
    const row = this.deps.db.prepare("SELECT normalized_rule_json, rule_hash, capability_fingerprint, expires_at, preview_json FROM automation_rule_previews WHERE id = ? AND account_id = ?").get(input.previewId, input.accountId) as { normalized_rule_json: string; rule_hash: string; capability_fingerprint: string; expires_at: string; preview_json: string } | undefined;
    if (!row || row.expires_at <= this.now()) throw new Error("automation-preview-not-found-or-expired");
    if (row.rule_hash !== input.ruleHash) throw new Error("automation-preview-hash-mismatch");
    const normalized = JSON.parse(row.normalized_rule_json) as AutomationRuleV2Draft & { authorization: AutomationRuleV2["authorization"]; capabilitySnapshots: AutomationRuleV2["capabilitySnapshots"] };
    if (normalized.schemaVersion !== 2 || normalized.accountId !== input.accountId) throw new Error("automation-preview-format-mismatch");
    if (hash(normalized) !== input.ruleHash) throw new Error("automation-preview-hash-mismatch");
    const alreadyCommitted = !!(JSON.parse(row.preview_json) as { committedRuleId?: string }).committedRuleId;
    const currentFingerprint = alreadyCommitted ? undefined : await this.deps.providers.fingerprint();
    return this.deps.db.transaction(() => {
      const current = this.deps.db.prepare("SELECT preview_json, rule_hash, expires_at FROM automation_rule_previews WHERE id = ? AND account_id = ?")
        .get(input.previewId, input.accountId) as { preview_json: string; rule_hash: string; expires_at: string } | undefined;
      if (!current || current.expires_at <= this.now()) throw new Error("automation-preview-not-found-or-expired");
      if (current.rule_hash !== input.ruleHash) throw new Error("automation-preview-hash-mismatch");
      const preview = JSON.parse(current.preview_json) as { committedRuleId?: string; committedRuleVersion?: number };
      if (preview.committedRuleId) {
        const existing = this.deps.rules.getV2(preview.committedRuleId);
        if (!existing || existing.accountId !== input.accountId) throw new Error("automation-committed-rule-unavailable");
        if (existing.archivedAt || existing.version !== preview.committedRuleVersion) throw new Error("automation-committed-rule-changed");
        return existing;
      }
      if (row.capability_fingerprint !== currentFingerprint) throw new Error("automation-capabilities-changed");
      const rule = this.deps.rules.createV2(normalized);
      if (rule.trigger.type === "scheduled") this.deps.runtime.upsert({ ruleId: rule.id, ruleVersion: rule.version, nextRunAt: rule.trigger.nextRunAt ?? nextScheduledOccurrence(rule.trigger, this.now()), consecutiveFailures: 0 });
      this.deps.db.prepare("UPDATE automation_rule_previews SET preview_json = ? WHERE id = ? AND account_id = ?")
        .run(JSON.stringify({ ...preview, committedRuleId: rule.id, committedRuleVersion: rule.version }), input.previewId, input.accountId);
      return rule;
    }).immediate();
  }

  async run(rule: AutomationRuleV2, input: { trigger?: Record<string, unknown>; collection?: Record<string, unknown>; scheduledAt?: string; delayed?: boolean; occurrenceKey?: string } = {}): Promise<PipelineAutomationRunResult> {
    const current = this.deps.rules.getV2(rule.id);
    if (!current || current.archivedAt || current.accountId !== rule.accountId || current.version !== rule.version) {
      throw new Error("automation-source-rule-stale");
    }
    rule = current;
    const runId = `automation-run-${randomUUID()}`;
    const collection = input.collection ?? this.resolveCollection(rule, input.scheduledAt);
    const actualStartedAt = this.now();
    const occurrenceKey = input.occurrenceKey ?? (input.scheduledAt
      ? `${rule.id}:${rule.version}:${input.scheduledAt}`
      : runId);
    const claim = this.observability.claim({
      rule,
      runId,
      occurrenceKey,
      plannedAt: input.scheduledAt,
      actualStartedAt,
      delayed: input.delayed ?? false,
      collection,
    });
    if (!claim.claimed) {
      const existing = this.deps.db.prepare("SELECT status FROM automation_rule_runs WHERE id = ?")
        .get(claim.runId) as { status: string | null } | undefined;
      if (existing?.status === "running" && !input.scheduledAt) {
        throw new Error("automation-run-already-in-progress");
      }
      if (!existing || existing.status === "running" || existing.status === "outcome_unknown") {
        throw new Error("automation-run-outcome-unknown");
      }
      const status = existing.status === "succeeded" || existing.status === "empty"
        ? existing.status
        : existing.status === "partial" ? "partial" : "failed";
      const ok = status === "succeeded" || status === "empty";
      return {
        runId: claim.runId,
        status,
        duplicate: true,
        ok,
        outcome: ok ? "succeeded" as const : status === "partial" ? "partially_succeeded" as const : "failed" as const,
        steps: [],
        outputs: {} as Record<string, AutomationValue | undefined>,
      };
    }
    const context = { run: { id: runId, ruleId: rule.id, ruleVersion: rule.version, accountId: rule.accountId, occurrenceKey, scheduledAt: input.scheduledAt, actualStartedAt, delayed: input.delayed ?? false }, trigger: input.trigger ?? {}, collection, steps: {}, authorization: rule.authorization, dryRun: false, owner: rule.owner, accountScope: rule.accountScope };
    const stepRunIds = new Map<string, string>();
    const sequence = new Map(rule.pipeline.map((step, index) => [step.id, index]));
    let result: Awaited<ReturnType<AutomationPipelineExecutor["execute"]>>;
    try {
      result = await this.executor.execute(rule.pipeline, context, {
        onStepStarted: (step, inputSummary) => {
        const revision = this.observability.beginStep(
          runId,
          step,
          sequence.get(step.id) ?? 0,
        );
        const stepRunId = this.deps.stepRuns.start({
          runId,
          ruleId: rule.id,
          ruleVersion: rule.version,
          stepId: step.id,
          provider: step.provider,
          capability: step.capability,
          capabilityFingerprint: step.capabilityFingerprint,
          stage: stageForStep(step),
          sequence: sequence.get(step.id) ?? 0,
          runRevision: revision,
          inputSummary,
          startedAt: this.now(),
        });
        stepRunIds.set(step.id, stepRunId);
        },
        onStepCompleted: (step, _inputSummary, stepResult) => {
        const revision = this.observability.completeStep(runId);
        const stepRunId = stepRunIds.get(step.id);
        if (stepRunId) {
          this.deps.stepRuns.complete(stepRunId, {
            result: stepResult,
            runRevision: revision,
            outputSummary: summarizeOutput(stepResult.output),
          });
        }
        },
      });
    } catch {
      this.deps.db.transaction(() => {
        for (const stepRunId of stepRunIds.values()) {
          const revision = this.observability.completeStep(runId);
          this.deps.stepRuns.markOutcomeUnknown(stepRunId, revision, this.now());
        }
        this.observability.completeRun(runId, "outcome_unknown", 0);
        if (rule.trigger.type === "scheduled") {
          const state = this.deps.runtime.get(rule.id);
          this.deps.runtime.upsert({
            ruleId: rule.id,
            ruleVersion: state?.ruleVersion ?? rule.version,
            lastScheduledAt: state?.lastScheduledAt,
            lastStartedAt: state?.lastStartedAt,
            lastCompletedAt: state?.lastCompletedAt,
            nextRunAt: state?.nextRunAt ?? nextScheduledOccurrence(rule.trigger, actualStartedAt),
            consecutiveFailures: state?.consecutiveFailures ?? 0,
            pausedReason: "execution-outcome-unknown",
          });
        }
      })();
      throw new Error("automation-run-outcome-unknown");
    }
    const succeeded = result.steps.filter(
      (item) => item.result.status === "succeeded",
    ).length;
    const finalValue =
      [...result.steps]
        .reverse()
        .find((item) => {
          const sourceStep = rule.pipeline.find(
            (step) => step.id === item.stepId,
          );
          return sourceStep ? stageForStep(sourceStep) !== "delivery" : true;
        })?.result.output ??
      result.steps[result.steps.length - 1]?.result.output;
    const status =
      result.ok && isExplicitEmptyOutput(finalValue)
        ? ("empty" as const)
        : result.ok
          ? ("succeeded" as const)
          : succeeded > 0
            ? ("partial" as const)
            : ("failed" as const);
    this.observability.completeRun(
      runId,
      status,
      resultValueCount(finalValue, succeeded),
      {
      rule,
      value: finalValue,
      },
    );
    const deliveryOutcome = this.observability.reconcileChannelDeliveries(runId);
    const reportedStatus = deliveryOutcome === "pending"
      ? "running"
      : deliveryOutcome === "partial" || deliveryOutcome === "failed"
        ? deliveryOutcome
        : status;
    return {
      runId,
      status: reportedStatus,
      ...result,
    };
  }

  /**
   * Manual execution is normally the same as a normal pipeline run. The
   * summary-notification template is event-driven, though: its message body
   * is produced when a specific mail's summary becomes ready. For that
   * template, a manual run scans the recent collection and replays only the
   * newest mail that already has a ready summary.
   */
  async runManually(rule: AutomationRuleV2): Promise<PipelineAutomationManualRunResult> {
    if (rule.templateBinding?.templateId !== SUMMARY_NOTIFICATION_TEMPLATE_ID) {
      const startedAt = this.now();
      const collection = this.resolveCollection(rule, startedAt);
      // A manual run must not advance or overwrite the scheduled cursor:
      // previousScheduleWindow depends on the last scheduled occurrence.
      return this.run(rule, { collection });
    }
    if (!this.deps.mail || !this.deps.intelligenceResults) {
      throw new Error("summary-automation-manual-runtime-unavailable");
    }

    const collection = this.resolveRecentSummaryCollection(rule);
    const references = collectionMailReferences(collection);
    let readyCount = 0;
    let latestCandidate: SummaryNotificationCandidate | undefined;
    for (let offset = 0; offset < references.length; offset += 100) {
      const referenceChunk = references.slice(offset, offset + 100);
      const resultsByEmail = this.readIntelligenceResults(
        referenceChunk.map((reference) => reference.emailId),
      );
      for (const reference of referenceChunk) {
        const mail = this.deps.mail.getMessageById(
          reference.emailId,
          reference.accountId,
        );
        const stored = resultsByEmail.get(reference.emailId);
        const summary = stored?.summary;
        if (!mail || !stored || !isSummaryResult(summary)) continue;
        readyCount += 1;
        const candidate: SummaryNotificationCandidate = {
          accountId: reference.accountId,
          emailId: reference.emailId,
          mail,
          summary,
          ...(isTagResult(stored.tags) ? { tags: stored.tags } : {}),
        };
        if (
          !latestCandidate ||
          Date.parse(candidate.mail.receivedAt) >
            Date.parse(latestCandidate.mail.receivedAt)
        ) {
          latestCandidate = candidate;
        }
      }
    }

    if (!latestCandidate) {
      return {
        ok: true,
        outcome: "succeeded",
        status: "empty",
        mode: "latest-summary-notification",
        matchedCount: references.length,
        readyCount,
        skippedCount: references.length,
        ignoredReadyCount: 0,
        dispatchedCount: 0,
        failedCount: 0,
        runIds: [],
        failures: [],
      };
    }

    try {
      const execution = await this.runSummaryNotificationRule(rule, latestCandidate);
      const failed = execution.status === "failed" || execution.status === "partial";
      return {
        ok: execution.ok,
        outcome: execution.outcome,
        status: execution.status,
        mode: "latest-summary-notification",
        runId: execution.runId,
        selectedEmailId: latestCandidate.emailId,
        matchedCount: references.length,
        readyCount,
        skippedCount: references.length - readyCount,
        ignoredReadyCount: Math.max(0, readyCount - 1),
        dispatchedCount: execution.ok ? 1 : 0,
        failedCount: failed ? 1 : 0,
        runIds: [execution.runId],
        failures: failed
          ? [{ emailId: latestCandidate.emailId, error: execution.outcome }]
          : [],
      };
    } catch (error) {
      return {
        ok: false,
        outcome: "failed",
        status: "failed",
        mode: "latest-summary-notification",
        selectedEmailId: latestCandidate.emailId,
        matchedCount: references.length,
        readyCount,
        skippedCount: references.length - readyCount,
        ignoredReadyCount: Math.max(0, readyCount - 1),
        dispatchedCount: 0,
        failedCount: 1,
        runIds: [],
        failures: [{
          emailId: latestCandidate.emailId,
          error: error instanceof Error ? error.message : String(error),
        }],
      };
    }
  }

  async retryFailedStep(input: {
    rule: AutomationRuleV2;
    runId: string;
    stepId: string;
  }): Promise<
    | { ok: true; runId: string; stepId: string; status: "succeeded" | "failed" }
    | { ok: false; code: string; message: string }
  > {
    const step = input.rule.pipeline.find((item) => item.id === input.stepId);
    if (!step) {
      return {
        ok: false,
        code: "missing-step",
        message: "当前规则版本中已找不到该步骤。",
      };
    }
    const descriptor = await this.deps.providers.resolve(
      step.provider,
      step.capability,
    );
    const eligibility = this.observability.canRetryStep(
      input.runId,
      input.stepId,
      descriptor?.fingerprint,
    );
    if (!eligibility.ok) return eligibility;

    const detail = this.observability.detail(input.runId, {
      accountId: input.rule.accountId,
      profileId: "default",
    });
    if (!detail || detail.ruleId !== input.rule.id) {
      return {
        ok: false,
        code: "missing-run",
        message: "找不到原始运行。",
      };
    }
    if (detail.ruleVersion !== input.rule.version) {
      return { ok: false, code: "rule-version-changed", message: "规则版本已变化，不能使用新规则重试旧运行。" };
    }
    if (!detail.manifest) {
      return {
        ok: false,
        code: "missing-input",
        message: "原始输入清单不可用。",
      };
    }
    if (this.deps.mail) {
      for (const item of detail.manifest.items) {
        const message = this.deps.mail.getMessageById(
          item.emailId,
          item.accountId,
        );
        if (!message) {
          return {
            ok: false,
            code: "missing-source",
            message: `原始邮件已不存在：${item.emailId}`,
          };
        }
        const currentHash = manifestItemContentHash({
          accountId: item.accountId,
          emailId: item.emailId,
          subject: message.subject,
        });
        if (currentHash !== item.contentHash) {
          return {
            ok: false,
            code: "changed-input",
            message: `原始邮件已发生变化：${item.emailId}`,
          };
        }
      }
    }

    const previousSteps = this.deps.stepRuns.list(input.runId);
    const contextSteps: Record<
      string,
      { status: "succeeded" | "failed" | "skipped"; output?: AutomationValue }
    > = {};
    for (const row of previousSteps) {
      if (
        row.status !== "succeeded" &&
        row.status !== "failed" &&
        row.status !== "skipped"
      ) {
        continue;
      }
      contextSteps[String(row.step_id)] = {
        status: row.status,
        output: parseAutomationValue(row.output_json),
      };
    }
    const collection = {
      messages: {
        type: "mail-collection",
        messages: detail.manifest.items.map((item) => ({
          type: "mail-reference",
          accountId: item.accountId,
          emailId: item.emailId,
        })),
      },
      window: detail.window,
    };
    const context = {
      run: {
        id: input.runId,
        ruleId: input.rule.id,
        ruleVersion: input.rule.version,
        accountId: input.rule.accountId,
        occurrenceKey: detail.occurrenceKey ?? input.runId,
        scheduledAt: detail.plannedAt,
        actualStartedAt: this.now(),
        delayed: detail.delayed ?? false,
      },
      trigger: {},
      collection,
      steps: contextSteps,
      authorization: input.rule.authorization,
      dryRun: false,
      owner: input.rule.owner,
      accountScope: input.rule.accountScope,
    };
    const current = this.deps.rules.getV2(input.rule.id);
    if (!current || current.archivedAt || !current.enabled || current.accountId !== input.rule.accountId || current.version !== input.rule.version) {
      return { ok: false, code: "rule-version-changed", message: "规则已停用、归档或发生变化，不能重试此运行。" };
    }
    let stepRunId: string | undefined;
    const claim = this.deps.db.transaction(() => {
      const fresh = this.deps.rules.getV2(input.rule.id);
      if (!fresh || fresh.archivedAt || !fresh.enabled || fresh.accountId !== input.rule.accountId || fresh.version !== input.rule.version) {
        return { ok: false as const, code: "rule-version-changed", message: "规则已停用、归档或发生变化，不能重试此运行。" };
      }
      const retry = this.observability.canRetryStep(input.runId, input.stepId, descriptor?.fingerprint);
      if (!retry.ok) return retry;
      const revision = this.observability.beginStep(input.runId, step, 0);
      this.deps.db.prepare("UPDATE automation_rule_runs SET status = 'running', completed_at = NULL WHERE id = ?").run(input.runId);
      stepRunId = this.deps.stepRuns.start({
        runId: input.runId,
        ruleId: input.rule.id,
        ruleVersion: input.rule.version,
        stepId: step.id,
        provider: step.provider,
        capability: step.capability,
        capabilityFingerprint: descriptor?.fingerprint,
        stage: stageForStep(step),
        sequence: input.rule.pipeline.findIndex((item) => item.id === step.id),
        runRevision: revision,
        startedAt: this.now(),
      });
      return { ok: true as const };
    })();
    if (!claim.ok) return claim;
    let result: Awaited<ReturnType<AutomationPipelineExecutor["execute"]>>;
    try {
      result = await this.executor.execute([step], context, {
        onStepCompleted: (_step, _inputSummary, stepResult) => {
          const revision = this.observability.completeStep(input.runId);
          if (stepRunId) {
            this.deps.stepRuns.complete(stepRunId, {
              result: stepResult,
              runRevision: revision,
              outputSummary: summarizeOutput(stepResult.output),
            });
          }
        },
      });
    } catch {
      // The provider may already have performed a side effect. Keep the
      // result uncertain and never classify this attempt as safe to retry.
      this.deps.db.transaction(() => {
        const revision = this.observability.completeStep(input.runId);
        if (stepRunId) this.deps.stepRuns.complete(stepRunId, {
          runRevision: revision,
          result: {
            status: "failed",
            error: { code: "execution-failed", message: "执行中断，结果尚未确认。", retryable: false, retrySafe: false },
            warnings: ["请先核实是否已产生副作用。"],
            sideEffects: [],
            audit: {
              provider: step.provider, capability: step.capability,
              capabilityFingerprint: descriptor?.fingerprint ?? "unavailable",
              startedAt: context.run.actualStartedAt, completedAt: this.now(), durationMs: 0,
            },
          },
        });
        this.observability.completeRun(input.runId, "outcome_unknown", detail.resultCount);
      })();
      return { ok: false, code: "outcome-unknown", message: "执行中断，结果尚未确认；请先核实是否已产生副作用。" };
    }
    const retried = result.steps[0]?.result;
    const status = retried?.status === "succeeded" ? "succeeded" : "failed";
    const latest = new Map<string, string>();
    for (const attempt of this.deps.stepRuns.list(input.runId)) {
      latest.set(String(attempt.step_id), String(attempt.status));
    }
    const succeeded = input.rule.pipeline.filter((item) => latest.get(item.id) === "succeeded").length;
    const allSucceeded = input.rule.pipeline.every((item) => latest.get(item.id) === "succeeded");
    const runOutcome = allSucceeded ? "succeeded" : succeeded > 0 ? "partial" : "failed";
    const isFinalStep = input.rule.pipeline.at(-1)?.id === input.stepId;
    this.observability.completeRun(
      input.runId,
      runOutcome,
      isFinalStep && status === "succeeded" ? resultValueCount(retried?.output, succeeded) : detail.resultCount,
      isFinalStep ? { rule: input.rule, value: retried?.output } : undefined,
    );
    return { ok: true, runId: input.runId, stepId: input.stepId, status };
  }

  async runDueScheduled(accountId: string): Promise<void> {
    const existing = this.scheduledRuns.get(accountId);
    if (existing) return existing;
    const promise = this.runDueScheduledOnce(accountId).finally(() => this.scheduledRuns.delete(accountId));
    this.scheduledRuns.set(accountId, promise);
    return promise;
  }

  async runForMailReceived(accountId: string, mail: Record<string, unknown>): Promise<void> {
    const failures: Error[] = [];
    for (const rule of this.deps.rules.listV2(accountId).filter((item) =>
      item.enabled &&
      item.trigger.type === "mailReceived" &&
      item.templateBinding?.templateId !== SUMMARY_NOTIFICATION_TEMPLATE_ID
    )) {
      if (!matchesConditions(rule, mail)) continue;
      const emailId = typeof mail.id === "string" ? mail.id.trim() : "";
      try {
        await this.run(rule, {
          trigger: {
            mail: {
              ...mail,
              ...(emailId
                ? {
                    type: "mail-reference",
                    accountId,
                    emailId,
                  }
                : {}),
            },
          },
          ...(emailId
            ? { occurrenceKey: `${rule.id}:${rule.version}:mail:${accountId}:${emailId}` }
            : {}),
        });
      } catch (error) {
        if (error instanceof Error && error.message === "automation-run-already-in-progress") continue;
        failures.push(error instanceof Error ? error : new Error(String(error)));
      }
    }
    if (failures.length) throw new AggregateError(failures, "automation-mail-rules-failed");
  }

  async runForSummaryCompleted(input: {
    accountId: string;
    emailId: string;
    summary: SummaryResult | SummaryThreadResult;
    tags?: TagResult;
  }): Promise<PipelineAutomationRunResult[]> {
    const mail = this.deps.mail?.getMessageById(input.emailId, input.accountId);
    if (!mail) return [];
    const notification = renderReceivedMailSummaryNotification(
      mail as unknown as Record<string, unknown>,
      input.summary,
      input.tags,
    );
    const executions: PipelineAutomationRunResult[] = [];
    const failures: Error[] = [];
    for (const rule of this.deps.rules.listV2(input.accountId).filter((item) =>
      item.enabled &&
      item.trigger.type === "mailReceived" &&
      item.templateBinding?.templateId === SUMMARY_NOTIFICATION_TEMPLATE_ID
    )) {
      if (!isSummaryNotificationMailEligible(rule, mail)) continue;
      if (!matchesConditions(rule, mail as unknown as Record<string, unknown>)) {
        continue;
      }
      if (this.hasSummaryNotificationRun(rule.id, input.accountId, input.emailId)) {
        continue;
      }
      try {
        executions.push(await this.runSummaryNotificationRule(rule, {
          accountId: input.accountId,
          emailId: input.emailId,
          mail,
          summary: input.summary,
          ...(input.tags ? { tags: input.tags } : {}),
          notification,
        }));
      } catch (error) {
        if (error instanceof Error && error.message === "automation-run-already-in-progress") continue;
        failures.push(error instanceof Error ? error : new Error(String(error)));
      }
    }
    if (failures.length) throw new AggregateError(failures, "automation-summary-rules-failed");
    return executions;
  }

  private hasSummaryNotificationRun(
    ruleId: string,
    accountId: string,
    emailId: string,
  ): boolean {
    const row = this.deps.db.prepare(`
      SELECT id FROM automation_rule_runs
       WHERE rule_id = ?
         AND (trigger_key = ? OR trigger_key = rule_id || ':' || rule_version || ':summary:' || ? || ':' || ?)
      UNION ALL
      SELECT runs.id
        FROM automation_rule_runs AS runs
        JOIN automation_run_manifest_items AS items
          ON items.run_id = runs.id
       WHERE runs.rule_id = ?
         AND items.account_id = ?
         AND items.reference_type = 'mail'
         AND items.reference_id = ?
       LIMIT 1
    `).get(ruleId, summaryOccurrenceKey(accountId, emailId), accountId, emailId, ruleId, accountId, emailId) as { id: string } | undefined;
    return !!row;
  }

  private async runSummaryNotificationRule(
    rule: AutomationRuleV2,
    candidate: SummaryNotificationCandidate & {
      notification?: { title: string; body: string };
    },
  ): Promise<PipelineAutomationRunResult> {
    const notification = candidate.notification ?? renderReceivedMailSummaryNotification(
      candidate.mail as unknown as Record<string, unknown>,
      candidate.summary,
      candidate.tags,
    );
    return this.run(rule, {
      trigger: {
        mail: candidate.mail,
        notificationTitle: notification.title,
        notificationBody: notification.body,
      },
      collection: {
        messages: {
          type: "mail-collection",
          messages: [{
            type: "mail-reference",
            accountId: candidate.accountId,
            emailId: candidate.emailId,
            subject: candidate.mail.subject,
            receivedAt: candidate.mail.receivedAt,
          }],
        },
        accountIds: [candidate.accountId],
      },
      occurrenceKey: summaryOccurrenceKey(candidate.accountId, candidate.emailId),
    });
  }

  private resolveRecentSummaryCollection(
    rule: AutomationRuleV2,
  ): Record<string, unknown> {
    if (rule.collection?.mode === "collection" && rule.collection.scope) {
      return this.resolveCollection(rule);
    }
    return this.resolveCollection({
      ...rule,
      collection: {
        mode: "collection",
        scope: {
          type: "rollingWindow",
          amount: 1,
          unit: "day",
          limit: 200,
        },
      },
    });
  }

  private readIntelligenceResults(
    emailIds: string[],
  ): Map<string, EmailIntelligenceResults> {
    const results = new Map<string, EmailIntelligenceResults>();
    const reader = this.deps.intelligenceResults;
    if (!reader) return results;
    for (let offset = 0; offset < emailIds.length; offset += 200) {
      const chunk = emailIds.slice(offset, offset + 200);
      for (const [emailId, value] of reader.findByEmailIds(chunk)) {
        results.set(emailId, value);
      }
    }
    return results;
  }

  private async runDueScheduledOnce(accountId: string): Promise<void> {
    const now = this.now();
    for (const rule of this.deps.rules.listV2(accountId).filter((item) => item.enabled && item.trigger.type === "scheduled")) {
      const trigger = rule.trigger as Extract<AutomationRuleV2["trigger"], { type: "scheduled" }>;
      let state = this.deps.runtime.get(rule.id);
      if (!state) state = this.deps.runtime.upsert({ ruleId: rule.id, ruleVersion: rule.version, nextRunAt: trigger.nextRunAt ?? nextScheduledOccurrence(trigger, now), consecutiveFailures: 0 });
      if (state.ruleVersion !== rule.version && !state.pausedReason) {
        state = this.deps.runtime.upsert({
          ...state,
          ruleVersion: rule.version,
          nextRunAt: nextScheduledOccurrence(trigger, now),
          consecutiveFailures: 0,
        });
      }
      if (!state.nextRunAt || state.nextRunAt > now || state.pausedReason) continue;
      const plannedAt = state.nextRunAt;
      const ageMs = Date.parse(now) - Date.parse(plannedAt);
      let nextRunAt = nextScheduledOccurrence(trigger, plannedAt);
      while (nextRunAt <= now) nextRunAt = nextScheduledOccurrence(trigger, nextRunAt);
      if (ageMs > 72 * 3_600_000) {
        this.deps.runtime.upsert({ ...state, ruleVersion: rule.version, lastScheduledAt: plannedAt, nextRunAt, pausedReason: "stale-catch-up-skipped", consecutiveFailures: state.consecutiveFailures });
        continue;
      }
      const startedAt = this.now();
      const collection = this.resolveCollection(rule, plannedAt);
      this.deps.runtime.upsert({ ...state, ruleVersion: rule.version, lastScheduledAt: plannedAt, lastStartedAt: startedAt, nextRunAt, consecutiveFailures: state.consecutiveFailures });
      try {
        const execution = await this.run(rule, { collection, scheduledAt: plannedAt, delayed: ageMs > 60_000, trigger: { scheduledAt: plannedAt, actualStartedAt: startedAt } });
        if (!execution.ok) {
          throw new Error(
            `automation-pipeline-failed:${execution.steps
              .filter((step) => step.result.status === "failed")
              .map((step) => `${step.stepId}:${step.result.error?.code ?? "failed"}`)
              .join(",")}`,
          );
        }
        this.deps.runtime.settleScheduled({ ruleId: rule.id, ruleVersion: rule.version, plannedAt, startedAt, completedAt: this.now(), nextRunAt, consecutiveFailures: 0 });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const uncertain = message === "automation-run-outcome-unknown";
        this.deps.runtime.settleScheduled({ ruleId: rule.id, ruleVersion: rule.version, plannedAt, startedAt, completedAt: this.now(), nextRunAt, consecutiveFailures: state.consecutiveFailures + 1, pausedReason: uncertain ? "execution-outcome-unknown" : state.consecutiveFailures + 1 >= 3 ? `execution-failed:${message}` : undefined });
      }
    }
  }

  private now(): string { return this.deps.now?.() ?? new Date().toISOString(); }

  private resolveCollection(
    rule: AutomationRuleV2,
    scheduledAt?: string,
  ): Record<string, unknown> {
    if (!this.deps.mail || rule.collection?.mode !== "collection") return {};
    const scope = rule.collection.scope;
    const upperBound = scheduledAt ?? this.now();
    let lowerBound: string | undefined;
    if (scope?.type === "calendarDay") {
      lowerBound = zonedStartOfDay(upperBound, scope.timezone).toISOString();
    } else if (scope?.type === "rollingWindow") {
      const multiplier = scope.unit === "hour" ? 3_600_000 : 86_400_000;
      lowerBound = new Date(Date.parse(upperBound) - scope.amount * multiplier).toISOString();
    } else if (scope?.type === "previousScheduleWindow") {
      const runtime = this.deps.runtime.get(rule.id);
      if (scope.maxLookback) {
        lowerBound = boundedPreviousExecutionStart(
          upperBound,
          runtime?.lastScheduledAt,
          scope.maxLookback,
        );
      } else {
        lowerBound = runtime?.lastScheduledAt ??
          new Date(Date.parse(upperBound) - 86_400_000).toISOString();
      }
    }
    const limit = Math.max(1, Math.min(5_000, scope?.limit ?? 1_000));
    const accountIds = this.resolveAccountScope(rule);
    const perAccountLimit = Math.max(
      1,
      Math.min(1_000, Math.ceil(limit / Math.max(1, accountIds.length)) * 2),
    );
    const queues = accountIds.map((accountId) =>
      this.deps.mail!
        .listMessages({
          accountId,
          folder: scope?.folder,
          receivedBefore: new Date(Date.parse(upperBound) + 1).toISOString(),
          limit: perAccountLimit,
        })
        .filter((message) => !lowerBound || message.receivedAt >= lowerBound)
        .filter((message) =>
          matchesConditions(rule, message as unknown as Record<string, unknown>),
        )
        .map((message) => ({
          type: "mail-reference" as const,
          accountId,
          emailId: message.id,
          subject: message.subject,
        })),
    );
    const messages: Array<{
      type: "mail-reference";
      accountId: string;
      emailId: string;
      subject: string;
    }> = [];
    let progressed = true;
    while (messages.length < limit && progressed) {
      progressed = false;
      for (const queue of queues) {
        const message = queue.shift();
        if (!message) continue;
        messages.push(message);
        progressed = true;
        if (messages.length >= limit) break;
      }
    }
    return {
      messages: { type: "mail-collection", messages },
      window: { from: lowerBound, to: upperBound, timezone: scope?.type === "calendarDay" ? scope.timezone : undefined },
      accountIds,
      truncated: queues.some((queue) => queue.length > 0),
    };
  }

  private resolveAccountScope(rule: AutomationRuleV2): string[] {
    if (rule.accountScope?.type === "selectedAccounts") {
      return [...new Set(rule.accountScope.accountIds)].filter((accountId) =>
        this.accountExists(accountId),
      );
    }
    if (rule.accountScope?.type === "allConnectedAccounts") {
      if (!this.deps.accountIds) throw new Error("canonical-account-directory-required");
      return this.deps.accountIds();
    }
    return [rule.accountId];
  }

  private accountExists(accountId: string): boolean {
    if (!this.deps.accountExists) throw new Error("canonical-account-directory-required");
    return this.deps.accountExists(accountId);
  }
}

export function boundedPreviousExecutionStart(
  upperBound: string,
  previousExecutionAt: string | undefined,
  maxLookback: { amount: number; unit: "hour" | "day" },
): string {
  const maxLookbackMs = maxLookback.amount *
    (maxLookback.unit === "hour" ? 3_600_000 : 86_400_000);
  const cappedLowerBound = new Date(
    Date.parse(upperBound) - maxLookbackMs,
  ).toISOString();
  return previousExecutionAt && previousExecutionAt > cappedLowerBound
    ? previousExecutionAt
    : cappedLowerBound;
}

function collectionMailReferences(
  collection: Record<string, unknown>,
): Array<{ accountId: string; emailId: string }> {
  const messagesValue = collection.messages;
  if (!isRecord(messagesValue) || !Array.isArray(messagesValue.messages)) {
    return [];
  }
  return messagesValue.messages.flatMap((value) => {
    if (!isRecord(value)) return [];
    const accountId = typeof value.accountId === "string"
      ? value.accountId.trim()
      : "";
    const emailId = typeof value.emailId === "string"
      ? value.emailId.trim()
      : "";
    return accountId && emailId ? [{ accountId, emailId }] : [];
  });
}

function isSummaryResult(
  value: unknown,
): value is SummaryResult | SummaryThreadResult {
  return isRecord(value) &&
    value.type === "summary" &&
    Array.isArray(value.bullets) &&
    Array.isArray(value.actionItems);
}

function isTagResult(value: unknown): value is TagResult {
  return isRecord(value) && value.type === "tags";
}

function isSummaryNotificationMailEligible(
  rule: AutomationRuleV2,
  mail: MailMessage,
): boolean {
  const receivedAt = Date.parse(mail.receivedAt);
  const ruleUpdatedAt = Date.parse(rule.updatedAt);
  // Summary workers can finish after a restart and replay old completions.
  // Only mails received after the rule was enabled/updated are eligible for
  // the automatic "new mail" notification in that case.
  return !Number.isFinite(receivedAt) ||
    !Number.isFinite(ruleUpdatedAt) ||
    receivedAt >= ruleUpdatedAt;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function renderReceivedMailSummaryNotification(
  mail: Record<string, unknown>,
  summary: SummaryResult | SummaryThreadResult,
  tags?: TagResult,
): { title: string; body: string } {
  const from = mail.from && typeof mail.from === "object"
    ? mail.from as { name?: string; email?: string }
    : {};
  const sender = from.name?.trim()
    ? `${from.name} <${from.email ?? ""}>`
    : from.email ?? "未知发件人";
  const subject =
    typeof mail.subject === "string" && mail.subject.trim()
      ? mail.subject.trim()
      : "（无主题）";
  const receivedAt =
    typeof mail.receivedAt === "string"
      ? formatBeijingDateTime(mail.receivedAt)
      : "";
  const summaryHeadline = "headline" in summary && typeof summary.headline === "string"
    ? summary.headline.trim()
    : "";
  const summaryDetails = "details" in summary && Array.isArray(summary.details)
    ? summary.details
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, 3)
      .map((item) => `• ${item}`)
    : [];
  const bullets = summary.bullets
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 4)
    .map((item) => `• ${item}`);
  const actions = summary.actionItems
    .map((item) => typeof item === "string" ? item.trim() : item.text.trim())
    .filter(Boolean)
    .slice(0, 3)
    .map((item) => `• ${item}`);
  const labelNames = [
    ...(tags?.tags ?? []).map((item) => item.name),
    ...(tags?.contentTags ?? []).map((item) => item.name),
    ...(tags?.classification?.categoryId ? [tags.classification.categoryId] : []),
  ]
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((item, index, all) => all.indexOf(item) === index)
    .slice(0, 8);
  const summaryLines = [
    ...(summaryHeadline ? [`• ${summaryHeadline}`] : []),
    ...summaryDetails,
    ...bullets,
  ].filter((line, index, lines) => lines.indexOf(line) === index);
  return {
    title: `新邮件摘要：${subject}`.slice(0, 120),
    body: [
      `发件人：${sender}`,
      ...(receivedAt ? [`接收时间：${receivedAt}`] : []),
      "",
      `标签：${labelNames.length > 0 ? labelNames.join("、") : "暂无"}`,
      "",
      "摘要：",
      ...(summaryLines.length > 0 ? summaryLines : ["• 暂无摘要内容"]),
      ...(actions.length > 0 ? ["", "待办：", ...actions] : []),
    ].join("\n").slice(0, 3_800),
  };
}

function formatBeijingDateTime(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(timestamp))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  ) as Partial<Record<"year" | "month" | "day" | "hour" | "minute" | "second", string>>;
  if (
    !parts.year ||
    !parts.month ||
    !parts.day ||
    !parts.hour ||
    !parts.minute ||
    !parts.second
  ) {
    return value;
  }
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

function zonedStartOfDay(value: string, timezone: string): Date {
  const date = new Date(value);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);
  const guess = Date.UTC(get("year"), get("month") - 1, get("day"), 0, 0, 0);
  const offsetAt = (instant: Date) => {
    const local = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hourCycle: "h23",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(instant);
    const part = (type: Intl.DateTimeFormatPartTypes) =>
      Number(local.find((item) => item.type === type)?.value);
    return Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute"), part("second")) - instant.getTime();
  };
  const first = new Date(guess - offsetAt(new Date(guess)));
  return new Date(guess - offsetAt(first));
}

function resultValueCount(
  value: AutomationValue | undefined,
  fallback: number,
): number {
  if (!value) return fallback;
  if (value.type === "dataset") return value.rows.length;
  if (value.type !== "scalar" || !value.value || typeof value.value !== "object") {
    return fallback;
  }
  const record = value.value as Record<string, unknown>;
  if (
    record.type === "subscriptionDailyInsight" &&
    record.stats &&
    typeof record.stats === "object"
  ) {
    const groups = (record.stats as Record<string, unknown>).groups;
    return typeof groups === "number" && Number.isFinite(groups)
      ? Math.max(0, Math.floor(groups))
      : fallback;
  }
  return fallback;
}

function validateDraft(draft: AutomationRuleV2Draft): void {
  if (draft.schemaVersion !== 2) throw new Error("schemaVersion-must-be-2");
  if (!draft.accountId?.trim() || !draft.name?.trim()) throw new Error("accountId-and-name-required");
  if (!Array.isArray(draft.pipeline) || draft.pipeline.length === 0) throw new Error("pipeline-required");
  const ids = new Set<string>();
  for (const step of draft.pipeline) { if (!step.id || ids.has(step.id)) throw new Error("pipeline-step-id-invalid"); ids.add(step.id); if (!step.provider || !step.capability || !step.input) throw new Error(`pipeline-step-invalid:${step.id}`); }
}
function hash(value: unknown): string { return createHash("sha256").update(stable(value)).digest("hex"); }
function stable(value: unknown): string { if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`; if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`; return JSON.stringify(value); }
function maxRisk(values: Array<"read" | "local-write" | "external-mutation" | "destructive">) { return values.sort((a, b) => ["read", "local-write", "external-mutation", "destructive"].indexOf(b) - ["read", "local-write", "external-mutation", "destructive"].indexOf(a))[0] ?? "read"; }
function matchesConditions(rule: AutomationRuleV2, mail: Record<string, unknown>): boolean {
  const message = mail as unknown as MailMessage;
  return matchesStructuredConditions(rule.conditions, message) &&
    matchesConditionRules(
      rule.conditionMode ?? "all",
      rule.conditionRules ?? [],
      message,
    );
}

function summarizeOutput(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (record.type === "scalar" && "value" in record) {
    return {
      type: "scalar",
      empty: isExplicitEmptyOutput(record.value),
    };
  }
  if (record.type === "mail-collection" && Array.isArray(record.messages)) {
    return { type: record.type, count: record.messages.length };
  }
  if (record.type === "dataset" && Array.isArray(record.rows)) {
    return { type: record.type, rowCount: record.rows.length };
  }
  if (record.type === "artifact-reference") {
    return {
      type: record.type,
      artifactId: record.artifactId,
      version: record.version,
    };
  }
  return {
    type: typeof record.type === "string" ? record.type : "result",
    keys: Object.keys(record)
      .filter((key) => !/body|html|content|token|secret|password/i.test(key))
      .slice(0, 20),
  };
}

function parseAutomationValue(value: unknown): AutomationValue | undefined {
  if (typeof value !== "string" || !value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object"
      ? (parsed as AutomationValue)
      : undefined;
  } catch {
    return undefined;
  }
}

function isExplicitEmptyOutput(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (record.type === "scalar" && "value" in record) {
    return isExplicitEmptyOutput(record.value);
  }
  if (typeof record.emptyReason === "string") return true;
  if (record.type === "dataset" && Array.isArray(record.rows)) {
    return record.rows.length === 0;
  }
  if (record.type === "mail-collection" && Array.isArray(record.messages)) {
    return record.messages.length === 0;
  }
  return false;
}

/** Freeze a provider-declared command scope without depending on its identity. */
export function commandPathLimit(descriptor: AutomationCapabilityDescriptor): { allowedCommandPath?: string[] } {
  const path = descriptor.metadata?.commandPath;
  if (path === undefined) return {};
  if (!Array.isArray(path) || path.length === 0 || path.length > 32 ||
      path.some((part) => typeof part !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/.test(part))) {
    throw new Error("invalid-automation-command-path");
  }
  return { allowedCommandPath: [...path] as string[] };
}
