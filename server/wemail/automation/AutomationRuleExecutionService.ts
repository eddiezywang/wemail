import type {
  AutomationRule,
  AutomationTrigger,
} from "../../../shared/wemail/automation.js";
import type { MailMessage } from "../../../shared/wemail/mail.js";
import type { CanonicalMailRepository } from "../mail/CanonicalMailRepository.js";
import type { MailDigestService } from "../digests/MailDigestService.js";
import type { ApplicationMessageRepository } from "../applicationMessages/ApplicationMessageRepository.js";
import type {
  AutomationActionExecutor,
  AutomationActionResult,
} from "./AutomationActionExecutor.js";
import type { AutomationRuleRepository } from "./AutomationRuleRepository.js";
import type {
  AutomationDeferredExecution,
  AutomationDeferredExecutionRepository,
} from "./AutomationDeferredExecutionRepository.js";
import { AutomationFieldRegistry } from "./AutomationFieldRegistry.js";
import {
  matchesConditionRules,
  matchesStructuredConditions,
} from "./AutomationRuleMatcher.js";
import type {
  EvaluateRuleInput,
  NaturalLanguageRuleDecision,
} from "./NaturalLanguageRuleEvaluator.js";
import {
  canonicalizeTemporalValue,
  evaluateTemporalExpression,
} from "./TemporalExpressionEvaluator.js";
import { nextScheduledOccurrence, previousScheduledOccurrence } from "./AutomationSchedule.js";
import { resolveAutomationWindow } from "./AutomationRuleService.js";

interface RuleEvaluator {
  evaluate(input: EvaluateRuleInput): Promise<NaturalLanguageRuleDecision>;
}

export interface AutomationRuleExecutionServiceOptions {
  rules: AutomationRuleRepository;
  mail: CanonicalMailRepository;
  evaluator: RuleEvaluator;
  actionExecutor: AutomationActionExecutor;
  deferredExecutions?: AutomationDeferredExecutionRepository;
  fieldRegistry?: AutomationFieldRegistry;
  now?: () => string;
  messageHasTag?: (emailId: string, tagName: string) => boolean;
  mailDigestService?: MailDigestService;
  applicationMessages?: ApplicationMessageRepository;
  editionCollectionProcessor?: EditionCollectionProcessor;
}

export type EditionCollectionProcessor = (input: {
  processorType: string;
  rule: AutomationRule;
  messages: MailMessage[];
  triggerKey: string;
  publish?: Extract<AutomationRule["actions"][number], { type: "publishApplicationMessage" }>;
}) => { summary: string; message?: Parameters<ApplicationMessageRepository["create"]>[0] } | undefined;

export interface AutomationExecutionSummary {
  ok: true;
  matchedCount: number;
  appliedCount: number;
  skippedCount: number;
}

interface MessageRunResult {
  matched: boolean;
  applied: boolean;
  skipped: boolean;
  staleRule?: boolean;
  status: "applied" | "skipped" | "evaluation_failed" | "failed";
  actionResults: AutomationActionResult[];
}

export class AutomationRuleExecutionService {
  private readonly rules: AutomationRuleRepository;
  private readonly mail: CanonicalMailRepository;
  private readonly evaluator: RuleEvaluator;
  private readonly actionExecutor: AutomationActionExecutor;
  private readonly deferredExecutions?: AutomationDeferredExecutionRepository;
  private readonly fieldRegistry: AutomationFieldRegistry;
  private readonly now: () => string;
  private readonly messageHasTag?: (emailId: string, tagName: string) => boolean;
  private readonly mailDigestService?: MailDigestService;
  private readonly applicationMessages?: ApplicationMessageRepository;
  private readonly editionCollectionProcessor?: EditionCollectionProcessor;
  private readonly inFlight = new Set<string>();
  private readonly scheduledRuns = new Map<
    string,
    Promise<AutomationExecutionSummary>
  >();
  private readonly mailReceivedRuns = new Map<
    string,
    Promise<AutomationExecutionSummary>
  >();
  private readonly waitingResolutionRuns = new Map<string, Promise<void>>();

  constructor(options: AutomationRuleExecutionServiceOptions) {
    this.rules = options.rules;
    this.mail = options.mail;
    this.evaluator = options.evaluator;
    this.actionExecutor = options.actionExecutor;
    this.deferredExecutions = options.deferredExecutions;
    this.fieldRegistry =
      options.fieldRegistry ?? AutomationFieldRegistry.withNativeFields();
    this.now = options.now ?? (() => new Date().toISOString());
    this.messageHasTag = options.messageHasTag;
    this.mailDigestService = options.mailDigestService;
    this.applicationMessages = options.applicationMessages;
    this.editionCollectionProcessor = options.editionCollectionProcessor;
  }

  runForMailReceived(
    accountId: string,
    emailId: string,
  ): Promise<AutomationExecutionSummary> {
    const rules = this.rules
      .list(accountId)
      .filter((rule) => rule.enabled && rule.trigger.type === "mailReceived");
    const ruleVersions = rules
      .map((rule) => `${rule.id}:${rule.updatedAt}`)
      .sort();
    const runKey = JSON.stringify([accountId, emailId, ruleVersions]);
    const existing = this.mailReceivedRuns.get(runKey);
    if (existing) return existing;

    const run = Promise.resolve().then(() =>
      this.runForMailReceivedOnce(accountId, emailId, rules)
    );
    this.mailReceivedRuns.set(runKey, run);
    const clear = () => {
      if (this.mailReceivedRuns.get(runKey) === run) {
        this.mailReceivedRuns.delete(runKey);
      }
    };
    void run.then(clear, clear);
    return run;
  }

  private async runForMailReceivedOnce(
    accountId: string,
    emailId: string,
    rules: AutomationRule[],
  ): Promise<AutomationExecutionSummary> {
    const message = this.mail.getMessageById(emailId, accountId);
    if (!message) return emptySummary();

    const summary = emptySummary();
    for (const rule of rules) {
      const triggerKey = `mailReceived:${emailId}`;
      if (this.rules.hasRun(rule.id, triggerKey)) {
        summary.skippedCount += 1;
        continue;
      }
      const timing = rule.trigger.type === "mailReceived"
        ? rule.trigger.execution ?? { type: "immediate" as const }
        : { type: "immediate" as const };
      if (timing.type !== "immediate" && this.deferredExecutions) {
        const matched = await this.evaluateMatch(rule, message, "mailReceived");
        if (!this.isRuleVersionCurrent(rule)) {
          summary.skippedCount += 1;
          continue;
        }
        if (!matched.matched) {
          this.addMessageResult(summary, matched);
          this.rules.logRun({
            ruleId: rule.id,
            accountId,
            dryRun: false,
            matchedCount: 0,
            appliedCount: 0,
            triggerKind: "mailReceived",
            triggerKey,
            status: matched.status,
            actionResults: [],
          });
          continue;
        }
        let scheduledStatus: string;
        let dueAt: string | undefined;
        if (timing.type === "atExpression") {
          const execution = this.deferredExecutions.scheduleWaiting({
            ruleId: rule.id,
            ruleVersion: rule.updatedAt,
            accountId,
            emailId,
            actions: rule.actions,
            execution: timing,
            dependencies: [],
          });
          if (execution.status === "waiting_fields") {
            await this.resolveWaitingExecution(execution, message);
          }
          const persisted = this.deferredExecutions.get(execution.id) ?? execution;
          if (!this.isRuleVersionCurrent(rule)) {
            this.deferredExecutions.markCancelled(execution.id);
            summary.skippedCount += 1;
            continue;
          }
          scheduledStatus = persisted.status;
          dueAt = persisted.dueAt;
        } else {
          dueAt = calculateMailReceivedDueAt(message.receivedAt, timing);
          const execution = this.deferredExecutions.schedule({
            ruleId: rule.id,
            ruleVersion: rule.updatedAt,
            accountId,
            emailId,
            dueAt,
            actions: rule.actions,
          });
          scheduledStatus = execution.status;
        }
        summary.matchedCount += 1;
        this.rules.logRun({
          ruleId: rule.id,
          accountId,
          dryRun: false,
          matchedCount: 1,
          appliedCount: 0,
          triggerKind: "mailReceivedScheduled",
          triggerKey,
          status: "matched",
          actionResults: [{
            ...(dueAt ? { dueAt } : {}),
            status: scheduledStatus === "pending" ? "scheduled" : scheduledStatus,
          }],
        });
        continue;
      }
      const result = await this.evaluateAndApply(rule, message, "mailReceived");
      if (result.staleRule) {
        summary.skippedCount += 1;
        continue;
      }
      this.addMessageResult(summary, result);
      this.rules.logRun({
        ruleId: rule.id,
        accountId,
        dryRun: false,
        matchedCount: result.matched ? 1 : 0,
        appliedCount: result.applied ? 1 : 0,
        triggerKind: "mailReceived",
        triggerKey,
        status: result.status,
        actionResults: result.actionResults,
      });
    }
    return summary;
  }

  runDueScheduled(accountId: string): Promise<AutomationExecutionSummary> {
    const existing = this.scheduledRuns.get(accountId);
    if (existing) return existing;
    const run = this.runDueScheduledOnce(accountId);
    this.scheduledRuns.set(accountId, run);
    const clear = () => {
      if (this.scheduledRuns.get(accountId) === run) {
        this.scheduledRuns.delete(accountId);
      }
    };
    void run.then(clear, clear);
    return run;
  }

  private async runDueScheduledOnce(
    accountId: string,
  ): Promise<AutomationExecutionSummary> {
    await this.refreshWaitingFields(accountId);
    const now = this.now();
    const summary = await this.runDueMailReceived(accountId, now);
    const rules = this.rules
      .list(accountId)
      .filter((rule) => rule.enabled && isDueScheduled(rule.trigger, now));
    for (const rule of rules) {
      const trigger = rule.trigger;
      if (trigger.type !== "scheduled") continue;
      const occurrence = trigger.nextRunAt ?? now;
      const triggerKey = `scheduled:${rule.id}:${occurrence}`;
      if (this.rules.hasRun(rule.id, triggerKey) || this.inFlight.has(triggerKey)) {
        summary.skippedCount += 1;
        continue;
      }

      this.inFlight.add(triggerKey);
      try {
        const previousRunAt = this.rules
          .listRuns(accountId, 500)
          .find((run) => run.ruleId === rule.id && run.triggerKind === "scheduled" && run.status !== "failed")
          ?.createdAt ?? previousScheduledOccurrence(trigger, occurrence);
        if (rule.processing?.mode === "collection") {
          const result = await this.runCollectionRule(rule, previousRunAt, occurrence, triggerKey);
          summary.matchedCount += result.matchedCount;
          summary.appliedCount += result.appliedCount;
          summary.skippedCount += result.appliedCount ? 0 : 1;
          this.advanceScheduledRule(rule, occurrence);
          continue;
        }
        const window = resolveAutomationWindow(rule, occurrence, previousRunAt);
        const scope = rule.processing?.scope;
        const limit = scope?.limit ?? 200;
        const messages = this.mail
          .listAllMessagesByAccount(accountId, 5_000)
          .filter((message) => !scope?.folder || message.folder === scope.folder)
          .filter((message) => !window || (message.receivedAt >= window.start && message.receivedAt <= window.end))
          .slice(0, limit);
        const actionResults: AutomationActionResult[] = [];
        let matchedCount = 0;
        let appliedCount = 0;

        for (const message of messages) {
          const result = await this.evaluateAndApply(rule, message, "scheduled");
          if (result.matched) matchedCount += 1;
          if (result.applied) appliedCount += 1;
          if (result.skipped) summary.skippedCount += 1;
          actionResults.push(...result.actionResults);
        }

        summary.matchedCount += matchedCount;
        summary.appliedCount += appliedCount;
        this.rules.logRun({
          ruleId: rule.id,
          accountId,
          dryRun: false,
          matchedCount,
          appliedCount,
          triggerKind: "scheduled",
          triggerKey,
          status: appliedCount > 0 ? "applied" : "skipped",
          actionResults,
        });
        this.advanceScheduledRule(rule, now);
      } finally {
        this.inFlight.delete(triggerKey);
      }
    }

    return summary;
  }

  private async refreshWaitingFields(accountId: string): Promise<void> {
    if (!this.deferredExecutions) return;
    for (const execution of this.deferredExecutions.listWaiting(accountId)) {
      const context = this.getCurrentExecutionContext(execution, accountId);
      if (!context) {
        this.deferredExecutions.markCancelled(execution.id);
        continue;
      }
      await this.resolveWaitingExecution(execution, context.message);
    }
  }

  private resolveWaitingExecution(
    execution: AutomationDeferredExecution,
    message: MailMessage,
  ): Promise<void> {
    const existing = this.waitingResolutionRuns.get(execution.id);
    if (existing) return existing;

    const run = Promise.resolve()
      .then(() => this.resolveWaitingExecutionOnce(execution, message))
      .catch(() => {
        // Keep the durable waiting row unchanged so a later scheduler tick can
        // retry it without preventing unrelated waiting/due work.
      });
    this.waitingResolutionRuns.set(execution.id, run);
    const clear = () => {
      if (this.waitingResolutionRuns.get(execution.id) === run) {
        this.waitingResolutionRuns.delete(execution.id);
      }
    };
    void run.then(clear, clear);
    return run;
  }

  private async resolveWaitingExecutionOnce(
    execution: AutomationDeferredExecution,
    message: MailMessage,
  ): Promise<void> {
    if (!this.deferredExecutions || !execution.execution) return;
    const context = {
      message,
      timezone: execution.execution.timezone,
    };
    const resolution = await evaluateTemporalExpression(
      execution.execution.expression,
      context,
      this.fieldRegistry,
    );
    if (resolution.status === "ready") {
      this.markTemporalResolution(
        execution.id,
        execution.execution.timezone,
        resolution,
      );
      return;
    }
    if (resolution.status === "unavailable") {
      this.deferredExecutions.markBlockedMissingField(execution.id, resolution);
      return;
    }

    this.deferredExecutions.markWaiting(execution.id, resolution.dependencies);
    try {
      await this.fieldRegistry.ensure(resolution.dependencies, { message });
    } catch {
      return;
    }

    const refreshed = await evaluateTemporalExpression(
      execution.execution.expression,
      context,
      this.fieldRegistry,
    );
    if (refreshed.status === "ready") {
      this.markTemporalResolution(
        execution.id,
        execution.execution.timezone,
        refreshed,
      );
      return;
    }
    if (refreshed.status === "unavailable") {
      this.deferredExecutions.markBlockedMissingField(execution.id, refreshed);
      return;
    }
    this.deferredExecutions.markWaiting(execution.id, refreshed.dependencies);
  }

  private markTemporalResolution(
    executionId: string,
    timezone: string,
    resolution: Extract<
      Awaited<ReturnType<typeof evaluateTemporalExpression>>,
      { status: "ready" }
    >,
  ): void {
    if (!this.deferredExecutions) return;
    const value = resolution.values[0];
    if (!value) {
      this.deferredExecutions.markBlockedMissingField(executionId, {
        status: "unavailable",
        reasons: ["empty-temporal-values"],
      });
      return;
    }
    let dueAt: string;
    try {
      dueAt = canonicalizeTemporalValue(
        value,
        resolution.valueType,
        timezone,
      );
    } catch {
      this.deferredExecutions.markBlockedMissingField(executionId, {
        status: "unavailable",
        reasons: ["invalid-temporal-date"],
      });
      return;
    }
    this.deferredExecutions.markPending(executionId, dueAt, resolution);
  }

  private async runDueMailReceived(
    accountId: string,
    now: string,
  ): Promise<AutomationExecutionSummary> {
    const summary = emptySummary();
    if (!this.deferredExecutions) return summary;
    for (const execution of this.deferredExecutions.listDue(accountId, now)) {
      const beforeClaim = this.getCurrentExecutionContext(execution, accountId);
      if (!beforeClaim) {
        this.deferredExecutions.cancelIfClaimable(execution.id);
        summary.skippedCount += 1;
        continue;
      }
      const claimed = this.deferredExecutions.claimDue({
        id: execution.id,
        ruleId: execution.ruleId,
        ruleVersion: execution.ruleVersion,
        accountId,
        emailId: execution.emailId,
        now,
      });
      if (!claimed) {
        const current = this.deferredExecutions.get(execution.id);
        if (
          current
          && !this.getCurrentExecutionContext(current, accountId)
        ) {
          this.deferredExecutions.cancelIfClaimable(execution.id);
        }
        continue;
      }
      const current = this.deferredExecutions.get(execution.id);
      const afterClaim = current
        ? this.getCurrentExecutionContext(current, accountId)
        : null;
      if (!current || current.status !== "running" || !afterClaim) {
        this.deferredExecutions.markCancelled(execution.id);
        summary.skippedCount += 1;
        continue;
      }
      const results = await this.actionExecutor.execute(
        accountId,
        current.emailId,
        current.actions,
        { ruleId: current.ruleId, runId: current.id },
      );
      const failed = results.filter((result) => result.status !== "applied");
      const applied = results.some((result) => result.status === "applied");
      if (failed.length === 0 && applied) {
        this.deferredExecutions.markSucceeded(execution.id);
        summary.matchedCount += 1;
        summary.appliedCount += 1;
      } else {
        const error = failed.map((result) => result.reason).join("; ") || "automation-action-not-applied";
        const retryAt = execution.attempts < 2
          ? new Date(Date.parse(now) + 15 * 60 * 1000).toISOString()
          : undefined;
        this.deferredExecutions.markFailed(execution.id, error, retryAt);
        summary.matchedCount += 1;
        summary.skippedCount += 1;
      }
      this.rules.logRun({
        ruleId: execution.ruleId,
        accountId,
        dryRun: false,
        matchedCount: 1,
        appliedCount: failed.length === 0 && applied ? 1 : 0,
        triggerKind: "mailReceivedDeferred",
        triggerKey: `deferred:${execution.id}:attempt:${execution.attempts + 1}`,
        status: failed.length === 0 && applied ? "applied" : "failed",
        actionResults: results,
      });
    }
    return summary;
  }

  private getCurrentExecutionContext(
    execution: AutomationDeferredExecution,
    accountId: string,
  ): { rule: AutomationRule; message: MailMessage } | null {
    if (execution.accountId !== accountId) return null;
    const rule = this.rules.get(execution.ruleId);
    if (
      !rule
      || !rule.enabled
      || rule.accountId !== accountId
      || rule.updatedAt !== execution.ruleVersion
    ) {
      return null;
    }
    const message = this.mail.getMessageById(execution.emailId, accountId);
    if (!message || message.accountId !== accountId) return null;
    return { rule, message };
  }

  async runRuleManually(ruleId: string): Promise<AutomationExecutionSummary> {
    const rule = this.rules.get(ruleId);
    if (!rule || !rule.enabled) return emptySummary();
    if (rule.processing?.mode === "collection") {
      const end = this.now();
      const scope = rule.processing.scope;
      const start = scope?.type === "rollingWindow"
        ? new Date(Date.parse(end) - scope.amount * (scope.unit === "hour" ? 3_600_000 : 86_400_000)).toISOString()
        : new Date(Date.parse(end) - 86_400_000).toISOString();
      return this.runCollectionRule(rule, start, end, `manual:${rule.id}:${end}`);
    }
    const messages = this.mail
      .searchMessages({ accountId: rule.accountId, folder: undefined, limit: 200 });
    const summary = emptySummary();
    const actionResults: AutomationActionResult[] = [];

    for (const message of messages) {
      const result = await this.evaluateAndApply(rule, message, "manual");
      this.addMessageResult(summary, result);
      actionResults.push(...result.actionResults);
    }

    this.rules.logRun({
      ruleId: rule.id,
      accountId: rule.accountId,
      dryRun: false,
      matchedCount: summary.matchedCount,
      appliedCount: summary.appliedCount,
      triggerKind: "manual",
      triggerKey: `manual:${this.now()}`,
      status: summary.appliedCount > 0 ? "applied" : "skipped",
      actionResults,
    });
    return summary;
  }

  private async evaluateAndApply(
    rule: AutomationRule,
    message: MailMessage,
    triggerKind: string,
  ): Promise<MessageRunResult> {
    const match = await this.evaluateMatch(rule, message, triggerKind);
    if (
      triggerKind === "mailReceived"
      && !this.isRuleVersionCurrent(rule)
    ) {
      return {
        ...skippedResult(),
        staleRule: true,
      };
    }
    if (!match.matched) return match;

    const actionResults = await this.actionExecutor.execute(
      rule.accountId,
      message.id,
      rule.actions,
      {
        ruleId: rule.id,
        runId: `${triggerKind}:${message.id}:${rule.updatedAt}`,
      },
    );
    const applied = actionResults.some((result) => result.status === "applied");
    const failed = actionResults.some((result) => result.status !== "applied");
    return {
      matched: true,
      applied,
      skipped: !applied,
      status: failed && !applied ? "failed" : applied ? "applied" : "skipped",
      actionResults,
    };
  }

  cancelPendingForRule(ruleId: string): number {
    return this.deferredExecutions?.cancelForRule(ruleId) ?? 0;
  }

  private async evaluateMatch(
    rule: AutomationRule,
    message: MailMessage,
    triggerKind: string,
  ): Promise<MessageRunResult> {
    const structuredMatched =
      rule.conditionRules && rule.conditionRules.length > 0
        ? matchesConditionRules(
            rule.conditionMode ?? "all",
            rule.conditionRules,
            message,
            this.messageHasTag,
          )
        : matchesStructuredConditions(
            rule.conditions,
            message,
            this.messageHasTag,
          );

    if (!structuredMatched) {
      return skippedResult();
    }

    if (rule.naturalLanguageCondition) {
      const decision = await this.evaluator.evaluate({
        ruleId: rule.id,
        accountId: rule.accountId,
        triggerKind,
        condition: rule.naturalLanguageCondition,
        message,
      });
      if (!decision.matched) {
        return {
          ...skippedResult(),
          status:
            decision.reason === "evaluation-failed" ||
            decision.reason === "llm-unavailable"
              ? "evaluation_failed"
              : "skipped",
        };
      }
    }

    return {
      matched: true,
      applied: false,
      skipped: false,
      status: "skipped",
      actionResults: [],
    };
  }

  private addMessageResult(
    summary: AutomationExecutionSummary,
    result: MessageRunResult,
  ): void {
    if (result.matched) summary.matchedCount += 1;
    if (result.applied) summary.appliedCount += 1;
    if (result.skipped) summary.skippedCount += 1;
  }

  private isRuleVersionCurrent(rule: AutomationRule): boolean {
    const current = this.rules.get(rule.id);
    return Boolean(
      current
      && current.enabled
      && current.accountId === rule.accountId
      && current.updatedAt === rule.updatedAt,
    );
  }

  private advanceScheduledRule(rule: AutomationRule, now: string): void {
    const trigger = rule.trigger;
    if (trigger.type !== "scheduled") return;
    this.rules.update(rule.id, {
      trigger: {
        ...trigger,
        nextRunAt: nextScheduledOccurrence(trigger, now),
      },
    });
  }

  private async runCollectionRule(
    rule: AutomationRule,
    defaultStart: string,
    end: string,
    triggerKey: string,
  ): Promise<AutomationExecutionSummary> {
    const scope = rule.processing?.scope;
    const start = resolveAutomationWindow(rule, end, defaultStart)?.start ?? defaultStart;
    const limit = scope?.limit ?? 200;
    const candidates = this.mail.searchMessages({ accountId: rule.accountId, folder: scope?.folder, limit: limit + 1 })
      .filter((message) => message.receivedAt >= start && message.receivedAt <= end);
    const matched: MailMessage[] = [];
    for (const message of candidates.slice(0, limit)) {
      const result = await this.evaluateMatch(rule, message, "collection");
      if (result.matched) matched.push(message);
    }
    const processors = rule.processing?.processors ?? [];
    const publish = rule.actions.find((action) => action.type === "publishApplicationMessage");
    const botPublishes = rule.actions
      .map((action, index) => ({ action, index }))
      .filter(
        (
          item,
        ): item is {
          action: Extract<
            AutomationRule["actions"][number],
            { type: "publishBotMessage" }
          >;
          index: number;
        } => item.action.type === "publishBotMessage",
      );
    const botSummaryParts: string[] = [];
    const actionResults: AutomationActionResult[] = [];
    let applied = false;
    try {
      for (const processor of processors) {
        if (processor.type === "mailDigest") {
          if (!this.mailDigestService) throw new Error("mail-digest-processor-unavailable");
          const digest = await this.mailDigestService.generate({
            accountId: rule.accountId, kind: "daily", windowStart: start, windowEnd: end,
            scopeKind: "folder", scopeKey: scope?.folder ?? "INBOX",
          });
          botSummaryParts.push(
            [
              `统计窗口：${start} — ${end}`,
              ...digest.result.overview,
              ...digest.result.themes.map(
                (theme) => `${theme.title}：${theme.summary}`,
              ),
              ...digest.result.actionItems.map(
                (item) => `${item.priority}：${item.text}`,
              ),
            ]
              .filter(Boolean)
              .join("\n"),
          );
          if (publish && this.applicationMessages) {
            const emailIds = [...new Set(digest.result.themes.flatMap((theme) => theme.emailIds))];
            this.applicationMessages.create({
              accountId: rule.accountId, sourceType: "automation", sourceRuleId: rule.id,
              sourceRunId: triggerKey, type: publish.messageType ?? "digest", severity: "info",
              title: publish.title, preview: digest.result.overview[0] ?? `${digest.emailCount} 封邮件的阶段摘要`,
              content: [
                { type: "status", label: "统计窗口", value: `${start} — ${end}` },
                ...digest.result.overview.map((text) => ({ type: "paragraph" as const, text })),
                ...digest.result.themes.map((theme) => ({ type: "callout" as const, tone: "info" as const, title: theme.title, text: theme.summary })),
                { type: "list", ordered: false, items: digest.result.actionItems.map((item) => `${item.priority}: ${item.text}`) },
              ],
              references: [
                { type: "automationRule", id: rule.id, label: rule.name },
                ...emailIds.slice(0, 100).map((id) => ({ type: "email" as const, id })),
              ],
              interactions: [{ type: "openAutomationRule", ruleId: rule.id, label: "查看自动化规则" }, ...(emailIds.length ? [{ type: "openEmails" as const, emailIds: emailIds.slice(0, 100), label: "查看相关邮件" }] : [])],
            });
            applied = true;
          }
        } else {
          const result = this.editionCollectionProcessor?.({ processorType: processor.type, rule, messages: matched, triggerKey, publish });
          if (!result) throw new Error(`collection-processor-unavailable:${processor.type}`);
          botSummaryParts.push(result.summary);
          if (result.message && this.applicationMessages) {
            this.applicationMessages.create(result.message);
            applied = true;
          }
        }
      }
      const botSummary =
        botSummaryParts.filter(Boolean).join("\n\n") ||
        `本次自动化匹配 ${matched.length} 封邮件。`;
      for (const item of botPublishes) {
        const result = this.actionExecutor.queueBotSummary({
          accountId: rule.accountId,
          ruleId: rule.id,
          runId: triggerKey,
          actionIndex: item.index,
          action: item.action,
          summary: botSummary,
        });
        actionResults.push(result);
        if (result.status === "applied") applied = true;
      }
      if (
        publish &&
        !actionResults.some(
          (result) => result.type === "publishApplicationMessage",
        ) &&
        applied
      ) {
        actionResults.push({
          type: "publishApplicationMessage",
          status: "applied",
          emailId: triggerKey,
        });
      }
      this.rules.logRun({ ruleId: rule.id, accountId: rule.accountId, dryRun: false, matchedCount: matched.length, appliedCount: applied ? 1 : 0, triggerKind: "collection", triggerKey, status: applied ? "applied" : "skipped", actionResults });
      return { ok: true, matchedCount: matched.length, appliedCount: applied ? 1 : 0, skippedCount: applied ? 0 : 1 };
    } catch (error) {
      actionResults.push({
        type: publish ? "publishApplicationMessage" : "publishBotMessage",
        status: "failed",
        emailId: triggerKey,
        reason: error instanceof Error ? error.message : String(error),
      });
      this.rules.logRun({ ruleId: rule.id, accountId: rule.accountId, dryRun: false, matchedCount: matched.length, appliedCount: 0, triggerKind: "collection", triggerKey, status: "failed", actionResults });
      return { ok: true, matchedCount: matched.length, appliedCount: 0, skippedCount: 1 };
    }
  }
}

export function calculateMailReceivedDueAt(
  receivedAt: string,
  timing: NonNullable<Extract<AutomationTrigger, { type: "mailReceived" }>["execution"]>,
): string {
  const received = new Date(receivedAt);
  if (!Number.isFinite(received.getTime())) throw new Error("invalid-mail-received-at");
  if (timing.type === "immediate") return received.toISOString();
  if (timing.type === "delay") {
    const unitMs = timing.unit === "minute"
      ? 60_000
      : timing.unit === "hour"
        ? 3_600_000
        : 86_400_000;
    return new Date(received.getTime() + timing.amount * unitMs).toISOString();
  }
  if (timing.type === "atExpression") {
    throw new Error("at-expression-evaluation-not-implemented");
  }
  const parts = zonedDateParts(received, timing.timezone);
  const [hour, minute] = timing.localTime.split(":").map(Number);
  const nextDate = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + 1));
  const next = {
    year: nextDate.getUTCFullYear(),
    month: nextDate.getUTCMonth() + 1,
    day: nextDate.getUTCDate(),
  };
  let candidate = new Date(Date.UTC(next.year, next.month - 1, next.day, hour, minute));
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const actual = zonedDateParts(candidate, timing.timezone);
    const desiredUtc = Date.UTC(next.year, next.month - 1, next.day, hour, minute);
    const actualUtc = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute);
    const delta = desiredUtc - actualUtc;
    if (delta === 0) break;
    candidate = new Date(candidate.getTime() + delta);
  }
  return candidate.toISOString();
}

function zonedDateParts(date: Date, timezone: string) {
  const values = new Map(
    new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date).map((part) => [part.type, part.value]),
  );
  return {
    year: Number(values.get("year")),
    month: Number(values.get("month")),
    day: Number(values.get("day")),
    hour: Number(values.get("hour")),
    minute: Number(values.get("minute")),
  };
}

function emptySummary(): AutomationExecutionSummary {
  return { ok: true, matchedCount: 0, appliedCount: 0, skippedCount: 0 };
}

function skippedResult(): MessageRunResult {
  return {
    matched: false,
    applied: false,
    skipped: true,
    status: "skipped",
    actionResults: [],
  };
}

function isDueScheduled(trigger: AutomationTrigger, now: string): boolean {
  if (trigger.type !== "scheduled") return false;
  if (!trigger.nextRunAt) return true;
  return trigger.nextRunAt <= now;
}
