import { createHash } from "node:crypto";
import type { AutomationRule, AutomationRulePreviewResult } from "../../../shared/wemail/automation.js";
import type { CanonicalMailRepository } from "../mail/CanonicalMailRepository.js";
import { automationCapabilityFingerprint } from "./AutomationCapabilityRegistry.js";
import type { AutomationRulePreviewRepository } from "./AutomationRulePreviewRepository.js";
import type { AutomationRuleRepository } from "./AutomationRuleRepository.js";
import { assertValidAutomationRuleDraft, type AutomationRuleDraft } from "./AutomationRuleValidation.js";

export class AutomationRuleService {
  constructor(private readonly deps: {
    rules: AutomationRuleRepository;
    previews: AutomationRulePreviewRepository;
    mail: CanonicalMailRepository;
    now?: () => string;
  }) {}

  preview(draft: AutomationRuleDraft, sourceRuleId?: string): AutomationRulePreviewResult {
    const normalizedRule = normalizeRuleDraft(draft);
    assertValidAutomationRuleDraft(normalizedRule);
    const source = sourceRuleId ? this.deps.rules.get(sourceRuleId) : null;
    if (sourceRuleId && (!source || source.accountId !== normalizedRule.accountId)) throw new Error("automation-source-rule-not-found");
    const now = this.now();
    const resolvedWindow = resolveAutomationWindow(normalizedRule, now, source?.trigger.type === "scheduled" ? source.trigger.nextRunAt : undefined);
    const limit = normalizedRule.processing?.scope?.limit ?? 200;
    const candidates = this.deps.mail.searchMessages({ accountId: normalizedRule.accountId, folder: normalizedRule.processing?.scope?.folder, limit: limit + 1 })
      .filter((message) => !resolvedWindow || (message.receivedAt >= resolvedWindow.start && message.receivedAt <= resolvedWindow.end));
    const truncated = candidates.length > limit;
    const matched = candidates.slice(0, limit).filter((message) => matchesLegacyConditions(normalizedRule, message));
    const warnings: string[] = [];
    if (normalizedRule.naturalLanguageCondition) warnings.push("自然语言条件会在正式执行时由 AI 逐封复核");
    if (truncated) warnings.push(`候选邮件超过 ${limit} 封，预览已截断`);
    const ruleHash = hashRule(normalizedRule);
    return this.deps.previews.create({
      accountId: normalizedRule.accountId, normalizedRule, ruleHash,
      capabilityFingerprint: automationCapabilityFingerprint(),
      sourceRuleId: source?.id, sourceRuleVersion: source ? sourceRevision(source) : undefined,
      resolvedWindow,
      matchedCount: matched.length,
      matchedReferences: matched.slice(0, 50).map((message) => ({ type: "email", id: message.id, subject: message.subject })),
      truncated, plannedProcessors: normalizedRule.processing?.processors ?? [],
      plannedActions: normalizedRule.actions, warnings,
    });
  }

  commit(input: { accountId: string; previewId: string; ruleHash: string }): AutomationRule {
    const preview = this.deps.previews.get(input.previewId, input.accountId);
    if (!preview) throw new Error("automation-preview-not-found-or-expired");
    if (preview.ruleHash !== input.ruleHash || hashRule(preview.normalizedRule) !== input.ruleHash) throw new Error("automation-preview-hash-mismatch");
    if (preview.capabilityFingerprint !== automationCapabilityFingerprint()) throw new Error("automation-capabilities-changed");
    if (preview.sourceRuleId) {
      const current = this.deps.rules.get(preview.sourceRuleId);
      if (!current || current.accountId !== input.accountId || sourceRevision(current) !== preview.sourceRuleVersion) throw new Error("automation-source-rule-stale");
      const updated = this.deps.rules.update(current.id, preview.normalizedRule);
      if (!updated) throw new Error("automation-source-rule-stale");
      return updated;
    }
    return this.deps.rules.create(preview.normalizedRule);
  }

  createLegacy(draft: AutomationRuleDraft): AutomationRule {
    const normalized = normalizeRuleDraft(draft);
    assertValidAutomationRuleDraft(normalized);
    return this.deps.rules.create(normalized);
  }

  updateLegacy(id: string, draft: AutomationRuleDraft): AutomationRule {
    const normalized = normalizeRuleDraft(draft);
    assertValidAutomationRuleDraft(normalized);
    const existing = this.deps.rules.get(id);
    if (!existing || existing.accountId !== normalized.accountId) throw new Error("automation-source-rule-not-found");
    const updated = this.deps.rules.update(id, normalized);
    if (!updated) throw new Error("automation-source-rule-not-found");
    return updated;
  }

  private now() { return this.deps.now?.() ?? new Date().toISOString(); }
}

export function normalizeRuleDraft(draft: AutomationRuleDraft): AutomationRuleDraft {
  const trigger = draft.trigger.type === "scheduled" ? {
    ...draft.trigger,
    schedule: draft.trigger.schedule ?? { type: "interval" as const, intervalMinutes: draft.trigger.intervalMinutes ?? 60 },
  } : draft.trigger;
  return {
    ...draft, name: draft.name.trim(), trigger,
    naturalLanguageCondition: draft.naturalLanguageCondition?.trim() || undefined,
    conditionMode: draft.conditionRules?.length ? draft.conditionMode ?? "all" : undefined,
    conditionRules: draft.conditionRules ?? [],
    processing: draft.processing ?? { mode: "perMessage" },
  };
}

export function hashRule(rule: AutomationRuleDraft): string {
  return createHash("sha256").update(stableStringify(rule)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

export function resolveAutomationWindow(rule: AutomationRuleDraft, end: string, previous?: string) {
  const scope = rule.processing?.scope;
  if (!scope) return undefined;
  if (scope.type === "previousScheduleWindow") {
    const fallback = new Date(Date.parse(end) - 86_400_000).toISOString();
    const previousStart = previous && previous < end ? previous : fallback;
    if (!scope.maxLookback) return { start: previousStart, end };
    const unitMs = scope.maxLookback.unit === "hour" ? 3_600_000 : 86_400_000;
    const cappedStart = new Date(Date.parse(end) - scope.maxLookback.amount * unitMs).toISOString();
    return { start: previousStart > cappedStart ? previousStart : cappedStart, end };
  }
  if (scope.type === "calendarDay") return { start: zonedStartOfDay(end, scope.timezone).toISOString(), end };
  const unit = scope.unit === "hour" ? 3_600_000 : 86_400_000;
  return { start: new Date(Date.parse(end) - scope.amount * unit).toISOString(), end };
}

function zonedStartOfDay(value: string, timezone: string): Date {
  const date = new Date(value);
  const formatter = (instant: Date) => new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const source = formatter(date);
  const read = (parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);
  const guess = Date.UTC(read(source, "year"), read(source, "month") - 1, read(source, "day"));
  const offset = (instant: Date) => {
    const parts = formatter(instant);
    return Date.UTC(
      read(parts, "year"),
      read(parts, "month") - 1,
      read(parts, "day"),
      read(parts, "hour"),
      read(parts, "minute"),
      read(parts, "second"),
    ) - instant.getTime();
  };
  const first = new Date(guess - offset(new Date(guess)));
  return new Date(guess - offset(first));
}

function matchesLegacyConditions(rule: AutomationRuleDraft, message: { from: { email: string; name?: string }; to: Array<{ email: string; name?: string }>; cc: Array<{ email: string; name?: string }>; subject: string; snippet: string; bodyText?: string; hasAttachments: boolean }) {
  const c = rule.conditions; const includes = (v: string | undefined, n: string) => (v ?? "").toLowerCase().includes(n.toLowerCase());
  if (c.sender && !includes(message.from.email, c.sender) && !includes(message.from.name, c.sender)) return false;
  if (c.recipient && !message.to.some((a) => includes(a.email, c.recipient!) || includes(a.name, c.recipient!))) return false;
  if (c.cc && !message.cc.some((a) => includes(a.email, c.cc!) || includes(a.name, c.cc!))) return false;
  if (c.subjectKeyword && !includes(message.subject, c.subjectKeyword)) return false;
  if (c.bodyKeyword && !includes(`${message.snippet}\n${message.bodyText ?? ""}`, c.bodyKeyword)) return false;
  if (c.hasAttachment !== undefined && message.hasAttachments !== c.hasAttachment) return false;
  return true;
}

function sourceRevision(rule: AutomationRule): string {
  return hashRule({
    accountId: rule.accountId, name: rule.name, enabled: rule.enabled, trigger: rule.trigger,
    naturalLanguageCondition: rule.naturalLanguageCondition, conditions: rule.conditions,
    conditionMode: rule.conditionMode, conditionRules: rule.conditionRules,
    processing: rule.processing, actions: rule.actions,
  });
}
