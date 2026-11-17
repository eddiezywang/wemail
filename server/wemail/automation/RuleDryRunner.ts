/**
 * RuleDryRunner — evaluates a draft rule against current mail and returns
 * matched email ids, match reasons, and planned actions. Does NOT mutate mail.
 *
 * Each matched email includes per-condition match reasons explaining why it matched.
 */

import type {
  AutomationAction,
  AutomationConditions,
  AutomationRule,
} from "../../../shared/wemail/automation.js";
import type {
  AutomationDryRunMatch,
  AutomationDryRunResult,
  AutomationMatchReason,
} from "../../../shared/wemail/intelligence.js";
import type { MailMessage } from "../../../shared/wemail/mail.js";
import type { CanonicalMailRepository } from "../mail/CanonicalMailRepository.js";
import type { AutomationRuleRepository } from "./AutomationRuleRepository.js";

export interface RuleDryRunnerDeps {
  mail: CanonicalMailRepository;
  rules: AutomationRuleRepository;
  /**
   * Checks whether a message has a specific AI-generated tag.
   * When omitted, aiTag conditions match nothing (fail-closed).
   */
  messageHasTag?: (emailId: string, tagName: string) => boolean;
}

export class RuleDryRunner {
  private readonly mail: CanonicalMailRepository;
  private readonly rules: AutomationRuleRepository;
  private readonly messageHasTag?: (emailId: string, tagName: string) => boolean;

  constructor(deps: RuleDryRunnerDeps) {
    this.mail = deps.mail;
    this.rules = deps.rules;
    this.messageHasTag = deps.messageHasTag;
  }

  /**
   * Dry-run a persisted rule by id. Returns matched emails with reasons
   * but does NOT apply any actions.
   */
  dryRun(ruleId: string, accountId: string): AutomationDryRunResult {
    const rule = this.rules.get(ruleId);
    if (!rule) {
      throw new Error(`Rule not found: ${ruleId}`);
    }
    return this.evaluateRule(rule, accountId);
  }

  /**
   * Dry-run a draft rule (not yet persisted). Used for suggestion previews.
   * The draft is treated as an in-memory rule object.
   */
  dryRunDraft(
    draft: {
      id: string;
      accountId: string;
      conditions: AutomationConditions;
      actions: AutomationAction[];
    },
    accountId: string,
  ): AutomationDryRunResult {
    const rule: AutomationRule = {
      id: draft.id,
      accountId: draft.accountId,
      name: "Draft",
      enabled: false,
      trigger: { type: "manual" },
      conditions: draft.conditions,
      actions: draft.actions,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    return this.evaluateRule(rule, accountId);
  }

  private evaluateRule(
    rule: AutomationRule,
    accountId: string,
  ): AutomationDryRunResult {
    const messages = this.mail
      .searchMessages({ folder: undefined, limit: 200 })
      .filter((m) => m.accountId === accountId);

    const matched: AutomationDryRunMatch[] = [];

    for (const message of messages) {
      const reasons = this.computeMatchReasons(rule.conditions, message);
      if (reasons.length > 0 || this.matchesAllConditions(rule.conditions, message)) {
        // Only include if it actually matches all conditions
        if (this.matchesAllConditions(rule.conditions, message)) {
          matched.push({
            id: message.id,
            subject: message.subject,
            reasons,
            plannedActions: rule.actions,
          });
        }
      }
    }

    // Log the dry-run
    this.rules.logRun({
      ruleId: rule.id,
      accountId,
      dryRun: true,
      matchedCount: matched.length,
      appliedCount: 0,
    });

    return {
      ok: true,
      ruleId: rule.id,
      matched,
      matchedCount: matched.length,
      dryRun: true,
    };
  }

  /**
   * Check if a message matches ALL conditions in the rule.
   * An empty conditions object matches everything.
   */
  private matchesAllConditions(
    conditions: AutomationConditions,
    message: MailMessage,
  ): boolean {
    if (conditions.sender !== undefined) {
      if (!this.includes(message.from.email, conditions.sender) &&
          !this.includes(message.from.name, conditions.sender)) {
        return false;
      }
    }
    if (conditions.recipient !== undefined) {
      if (!message.to.some(
        (addr) => this.includes(addr.email, conditions.recipient) ||
                  this.includes(addr.name, conditions.recipient),
      )) {
        return false;
      }
    }
    if (conditions.cc !== undefined) {
      if (!message.cc.some(
        (addr) => this.includes(addr.email, conditions.cc) ||
                  this.includes(addr.name, conditions.cc),
      )) {
        return false;
      }
    }
    if (conditions.subjectKeyword !== undefined) {
      if (!this.includes(message.subject, conditions.subjectKeyword)) {
        return false;
      }
    }
    if (conditions.bodyKeyword !== undefined) {
      const body = `${message.snippet}\n${message.bodyText ?? ""}`;
      if (!this.includes(body, conditions.bodyKeyword)) {
        return false;
      }
    }
    if (conditions.hasAttachment !== undefined) {
      if (message.hasAttachments !== conditions.hasAttachment) {
        return false;
      }
    }
    if (conditions.aiTag !== undefined) {
      if (!this.messageHasTag || !this.messageHasTag(message.id, conditions.aiTag)) {
        return false;
      }
    }
    // Time-based conditions would need current date comparison
    // For now, they pass by default (no time filtering in dry-run)
    return true;
  }

  /**
   * Compute per-condition match reasons for a message.
   * Returns an array of reasons for each condition that matched.
   */
  private computeMatchReasons(
    conditions: AutomationConditions,
    message: MailMessage,
  ): AutomationMatchReason[] {
    const reasons: AutomationMatchReason[] = [];

    if (conditions.sender) {
      if (this.includes(message.from.email, conditions.sender)) {
        reasons.push({
          field: "sender",
          reason: `Sender email "${message.from.email}" matches "${conditions.sender}"`,
        });
      } else if (this.includes(message.from.name, conditions.sender)) {
        reasons.push({
          field: "sender",
          reason: `Sender name "${message.from.name}" matches "${conditions.sender}"`,
        });
      }
    }

    if (conditions.recipient) {
      const matchingRecipient = message.to.find(
        (addr) => this.includes(addr.email, conditions.recipient) ||
                  this.includes(addr.name, conditions.recipient),
      );
      if (matchingRecipient) {
        reasons.push({
          field: "recipient",
          reason: `Recipient "${matchingRecipient.email}" matches "${conditions.recipient}"`,
        });
      }
    }

    if (conditions.cc) {
      const matchingCc = message.cc.find(
        (addr) => this.includes(addr.email, conditions.cc) ||
                  this.includes(addr.name, conditions.cc),
      );
      if (matchingCc) {
        reasons.push({
          field: "cc",
          reason: `CC "${matchingCc.email}" matches "${conditions.cc}"`,
        });
      }
    }

    if (conditions.subjectKeyword) {
      if (this.includes(message.subject, conditions.subjectKeyword)) {
        reasons.push({
          field: "subjectKeyword",
          reason: `Subject "${message.subject}" contains "${conditions.subjectKeyword}"`,
        });
      }
    }

    if (conditions.bodyKeyword) {
      const body = `${message.snippet}\n${message.bodyText ?? ""}`;
      if (this.includes(body, conditions.bodyKeyword)) {
        reasons.push({
          field: "bodyKeyword",
          reason: `Body contains "${conditions.bodyKeyword}"`,
        });
      }
    }

    if (conditions.hasAttachment !== undefined) {
      if (message.hasAttachments === conditions.hasAttachment) {
        reasons.push({
          field: "hasAttachment",
          reason: conditions.hasAttachment
            ? "Email has attachments"
            : "Email has no attachments",
        });
      }
    }

    if (conditions.aiTag) {
      const hasTag = this.messageHasTag?.(message.id, conditions.aiTag) ?? false;
      if (hasTag) {
        reasons.push({
          field: "aiTag",
          reason: `Message has AI tag "${conditions.aiTag}"`,
        });
      }
    }

    return reasons;
  }

  private includes(
    haystack: string | undefined,
    needle: string | undefined,
  ): boolean {
    if (!needle) return true;
    return (haystack ?? "").toLowerCase().includes(needle.toLowerCase());
  }
}
