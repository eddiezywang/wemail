/**
 * Priority reply decision eval fixtures.
 *
 * At least 25 fixtures covering the key scenarios:
 *   - Deterministic priority (same inputs = same result)
 *   - Explainable reply decision (reply required includes signals)
 *   - Bulk/newsletter/marketing = low priority default
 *   - Direct requests with deadlines = high priority
 *   - Edge cases: mixed signals, CC-only, no-reply senders
 */

import type { IntelligenceJobType } from "../../../../shared/wemail/intelligence.js";
import type { EvalFixture } from "../eval/EvalRunner.js";

export const PRIORITY_REPLY_DECISION_FIXTURES: EvalFixture[] = [
  // ── 1-5: Bulk/newsletter/marketing defaults to low ──────────────
  {
    fixtureId: "priority-newsletter-no-ask",
    feature: "replyDecision",
    llmResponse: {
      type: "replyDecision",
      shouldReply: false,
      reason: "Newsletter with no personal ask",
      confidence: 0.9,
      priorityScore: 0.1,
      level: "low",
      replyRequired: false,
      signals: [
        { name: "sender", value: "newsletter", weight: 0.3 },
        { name: "system-category", value: "newsletter", weight: 0.15 },
      ],
    },
    assertions: {
      "level-is-low": (r: any) => r?.level === "low" ? null : "level-not-low",
      "reply-not-required": (r: any) => r?.replyRequired === false ? null : "reply-required-should-be-false",
      "has-reason": (r: any) => typeof r?.reason === "string" && r.reason.length > 0 ? null : "missing-reason",
    },
    required: true,
  },
  {
    fixtureId: "priority-marketing-promo",
    feature: "replyDecision",
    llmResponse: {
      type: "replyDecision",
      shouldReply: false,
      reason: "Marketing promotion, no reply expected",
      confidence: 0.85,
      priorityScore: 0.08,
      level: "low",
      replyRequired: false,
      signals: [
        { name: "sender", value: "newsletter", weight: 0.3 },
        { name: "system-category", value: "marketing", weight: 0.15 },
      ],
    },
    assertions: {
      "level-is-low": (r: any) => r?.level === "low" ? null : "level-not-low",
      "reply-not-required": (r: any) => r?.replyRequired === false ? null : "reply-required-should-be-false",
    },
    required: true,
  },
  {
    fixtureId: "priority-notification-automated",
    feature: "replyDecision",
    llmResponse: {
      type: "replyDecision",
      shouldReply: false,
      reason: "Automated notification",
      confidence: 0.95,
      priorityScore: 0.05,
      level: "low",
      replyRequired: false,
      signals: [
        { name: "sender", value: "automated", weight: 0.3 },
        { name: "system-category", value: "notification", weight: 0.15 },
      ],
    },
    assertions: {
      "level-is-low": (r: any) => r?.level === "low" ? null : "level-not-low",
      "reply-not-required": (r: any) => r?.replyRequired === false ? null : "reply-required-should-be-false",
    },
    required: true,
  },
  {
    fixtureId: "priority-receipt-confirmation",
    feature: "replyDecision",
    llmResponse: {
      type: "replyDecision",
      shouldReply: false,
      reason: "Receipt confirmation, no action needed",
      confidence: 0.92,
      priorityScore: 0.1,
      level: "low",
      replyRequired: false,
      signals: [
        { name: "sender", value: "automated", weight: 0.3 },
        { name: "system-category", value: "receipt", weight: 0.15 },
      ],
    },
    assertions: {
      "level-is-low": (r: any) => r?.level === "low" ? null : "level-not-low",
    },
  },
  {
    fixtureId: "priority-daily-digest",
    feature: "replyDecision",
    llmResponse: {
      type: "replyDecision",
      shouldReply: false,
      reason: "Daily digest, no personal ask",
      confidence: 0.88,
      priorityScore: 0.12,
      level: "low",
      replyRequired: false,
      signals: [
        { name: "sender", value: "automated", weight: 0.3 },
        { name: "system-category", value: "日报", weight: 0.15 },
      ],
    },
    assertions: {
      "level-is-low": (r: any) => r?.level === "low" ? null : "level-not-low",
    },
  },

  // ── 6-10: Direct requests with deadlines = high priority ────────
  {
    fixtureId: "priority-direct-deadline-explicit",
    feature: "replyDecision",
    llmResponse: {
      type: "replyDecision",
      shouldReply: true,
      reason: "Direct request with explicit deadline",
      confidence: 0.9,
      priorityScore: 0.85,
      level: "high",
      replyRequired: true,
      deadline: "2026-05-15",
      signals: [
        { name: "sender", value: "personal", weight: 0.3 },
        { name: "questions", value: "present", weight: 0.2 },
        { name: "deadline", value: "present", weight: 0.25 },
        { name: "direct", value: "direct", weight: 0.15 },
      ],
    },
    assertions: {
      "level-is-high": (r: any) => r?.level === "high" ? null : "level-not-high",
      "reply-required": (r: any) => r?.replyRequired === true ? null : "reply-required-should-be-true",
      "has-deadline": (r: any) => typeof r?.deadline === "string" ? null : "deadline-missing",
      "has-reason": (r: any) => typeof r?.reason === "string" && r.reason.length > 0 ? null : "missing-reason",
    },
    required: true,
  },
  {
    fixtureId: "priority-urgent-action-deadline",
    feature: "replyDecision",
    llmResponse: {
      type: "replyDecision",
      shouldReply: true,
      reason: "Urgent action required by deadline",
      confidence: 0.95,
      priorityScore: 0.92,
      level: "high",
      replyRequired: true,
      deadline: "2026-06-30",
      signals: [
        { name: "sender", value: "personal", weight: 0.3 },
        { name: "questions", value: "many", weight: 0.2 },
        { name: "deadline", value: "present", weight: 0.25 },
        { name: "direct", value: "direct", weight: 0.15 },
        { name: "system-category", value: "action_required", weight: 0.15 },
      ],
    },
    assertions: {
      "level-is-high": (r: any) => r?.level === "high" ? null : "level-not-high",
      "reply-required": (r: any) => r?.replyRequired === true ? null : "reply-required-should-be-true",
      "has-deadline": (r: any) => typeof r?.deadline === "string" ? null : "deadline-missing",
    },
    required: true,
  },
  {
    fixtureId: "priority-manager-request-deadline",
    feature: "replyDecision",
    llmResponse: {
      type: "replyDecision",
      shouldReply: true,
      reason: "Manager request with due date",
      confidence: 0.88,
      priorityScore: 0.82,
      level: "high",
      replyRequired: true,
      signals: [
        { name: "sender", value: "personal", weight: 0.3 },
        { name: "deadline", value: "present", weight: 0.25 },
        { name: "direct", value: "direct", weight: 0.15 },
      ],
    },
    assertions: {
      "level-is-high": (r: any) => r?.level === "high" ? null : "level-not-high",
      "reply-required": (r: any) => r?.replyRequired === true ? null : "reply-required-should-be-true",
    },
  },
  {
    fixtureId: "priority-client-deadline",
    feature: "replyDecision",
    llmResponse: {
      type: "replyDecision",
      shouldReply: true,
      reason: "Client needs response before deadline",
      confidence: 0.91,
      priorityScore: 0.87,
      level: "high",
      replyRequired: true,
      deadline: "2026-07-01",
      signals: [
        { name: "sender", value: "personal", weight: 0.3 },
        { name: "deadline", value: "present", weight: 0.25 },
        { name: "direct", value: "direct", weight: 0.15 },
        { name: "questions", value: "present", weight: 0.2 },
      ],
    },
    assertions: {
      "level-is-high": (r: any) => r?.level === "high" ? null : "level-not-high",
    },
  },
  {
    fixtureId: "priority-approval-needed-urgent",
    feature: "replyDecision",
    llmResponse: {
      type: "replyDecision",
      shouldReply: true,
      reason: "Approval needed urgently",
      confidence: 0.93,
      priorityScore: 0.88,
      level: "high",
      replyRequired: true,
      signals: [
        { name: "sender", value: "personal", weight: 0.3 },
        { name: "system-category", value: "审批", weight: 0.15 },
        { name: "deadline", value: "present", weight: 0.25 },
        { name: "direct", value: "direct", weight: 0.15 },
      ],
    },
    assertions: {
      "level-is-high": (r: any) => r?.level === "high" ? null : "level-not-high",
      "reply-required": (r: any) => r?.replyRequired === true ? null : "reply-required-should-be-true",
    },
  },

  // ── 11-15: Normal priority scenarios ────────────────────────────
  {
    fixtureId: "priority-direct-question-no-deadline",
    feature: "replyDecision",
    llmResponse: {
      type: "replyDecision",
      shouldReply: true,
      reason: "Direct question needs response",
      confidence: 0.8,
      priorityScore: 0.55,
      level: "normal",
      replyRequired: true,
      signals: [
        { name: "sender", value: "personal", weight: 0.3 },
        { name: "questions", value: "present", weight: 0.2 },
        { name: "deadline", value: "none", weight: 0.25 },
        { name: "direct", value: "direct", weight: 0.15 },
      ],
    },
    assertions: {
      "level-is-normal": (r: any) => r?.level === "normal" ? null : "level-not-normal",
      "reply-required": (r: any) => r?.replyRequired === true ? null : "reply-required-should-be-true",
    },
  },
  {
    fixtureId: "priority-cc-question",
    feature: "replyDecision",
    llmResponse: {
      type: "replyDecision",
      shouldReply: true,
      reason: "Question on CC, optional reply",
      confidence: 0.6,
      priorityScore: 0.38,
      level: "normal",
      replyRequired: true,
      signals: [
        { name: "sender", value: "personal", weight: 0.3 },
        { name: "questions", value: "present", weight: 0.2 },
        { name: "direct", value: "cc", weight: 0.15 },
      ],
    },
    assertions: {
      "level-not-high": (r: any) => r?.level !== "high" ? null : "level-should-not-be-high",
    },
  },
  {
    fixtureId: "priority-collaboration-request",
    feature: "replyDecision",
    llmResponse: {
      type: "replyDecision",
      shouldReply: true,
      reason: "Collaboration request",
      confidence: 0.75,
      priorityScore: 0.6,
      level: "normal",
      replyRequired: true,
      signals: [
        { name: "sender", value: "personal", weight: 0.3 },
        { name: "questions", value: "present", weight: 0.2 },
        { name: "direct", value: "direct", weight: 0.15 },
      ],
    },
    assertions: {
      "reply-required": (r: any) => r?.replyRequired === true ? null : "reply-required-should-be-true",
    },
  },
  {
    fixtureId: "priority-information-request",
    feature: "replyDecision",
    llmResponse: {
      type: "replyDecision",
      shouldReply: true,
      reason: "Information requested",
      confidence: 0.7,
      priorityScore: 0.5,
      level: "normal",
      replyRequired: true,
      signals: [
        { name: "sender", value: "personal", weight: 0.3 },
        { name: "questions", value: "present", weight: 0.2 },
        { name: "direct", value: "direct", weight: 0.15 },
      ],
    },
    assertions: {
      "has-signals": (r: any) => Array.isArray(r?.signals) && r.signals.length > 0 ? null : "missing-signals",
    },
  },
  {
    fixtureId: "priority-team-update-reply-optional",
    feature: "replyDecision",
    llmResponse: {
      type: "replyDecision",
      shouldReply: false,
      reason: "Team update, reply optional",
      confidence: 0.65,
      priorityScore: 0.4,
      level: "normal",
      replyRequired: false,
      signals: [
        { name: "sender", value: "personal", weight: 0.3 },
        { name: "questions", value: "none", weight: 0.2 },
        { name: "direct", value: "direct", weight: 0.15 },
      ],
    },
    assertions: {
      "reply-not-required": (r: any) => r?.replyRequired === false ? null : "reply-required-should-be-false",
    },
  },

  // ── 16-20: Edge cases ───────────────────────────────────────────
  {
    fixtureId: "priority-bulk-with-personal-ask",
    feature: "replyDecision",
    llmResponse: {
      type: "replyDecision",
      shouldReply: true,
      reason: "Newsletter contains personal request despite bulk nature",
      confidence: 0.5,
      priorityScore: 0.4,
      level: "normal",
      replyRequired: true,
      signals: [
        { name: "sender", value: "newsletter", weight: 0.3 },
        { name: "questions", value: "present", weight: 0.2 },
        { name: "deadline", value: "present", weight: 0.25 },
      ],
    },
    assertions: {
      "has-reason": (r: any) => typeof r?.reason === "string" && r.reason.length > 0 ? null : "missing-reason",
      "has-signals": (r: any) => Array.isArray(r?.signals) && r.signals.length > 0 ? null : "missing-signals",
    },
  },
  {
    fixtureId: "priority-no-reply-system-alert",
    feature: "replyDecision",
    llmResponse: {
      type: "replyDecision",
      shouldReply: false,
      reason: "System alert, no reply possible",
      confidence: 0.98,
      priorityScore: 0.02,
      level: "low",
      replyRequired: false,
      signals: [
        { name: "sender", value: "automated", weight: 0.3 },
        { name: "system-category", value: "告警", weight: 0.15 },
      ],
    },
    assertions: {
      "level-is-low": (r: any) => r?.level === "low" ? null : "level-not-low",
      "reply-not-required": (r: any) => r?.replyRequired === false ? null : "reply-required-should-be-false",
    },
  },
  {
    fixtureId: "priority-fyi-no-action",
    feature: "replyDecision",
    llmResponse: {
      type: "replyDecision",
      shouldReply: false,
      reason: "FYI only, no action required",
      confidence: 0.85,
      priorityScore: 0.3,
      level: "low",
      replyRequired: false,
      signals: [
        { name: "sender", value: "personal", weight: 0.3 },
        { name: "questions", value: "none", weight: 0.2 },
        { name: "deadline", value: "none", weight: 0.25 },
        { name: "direct", value: "cc", weight: 0.15 },
      ],
    },
    assertions: {
      "reply-not-required": (r: any) => r?.replyRequired === false ? null : "reply-required-should-be-false",
    },
  },
  {
    fixtureId: "priority-broadcast-many-recipients",
    feature: "replyDecision",
    llmResponse: {
      type: "replyDecision",
      shouldReply: false,
      reason: "Broadcast to many recipients, no personal ask",
      confidence: 0.8,
      priorityScore: 0.25,
      level: "low",
      replyRequired: false,
      signals: [
        { name: "sender", value: "personal", weight: 0.3 },
        { name: "questions", value: "none", weight: 0.2 },
        { name: "direct", value: "broadcast", weight: 0.15 },
      ],
    },
    assertions: {
      "level-is-low": (r: any) => r?.level === "low" ? null : "level-not-low",
    },
  },
  {
    fixtureId: "priority-personal-no-deadline",
    feature: "replyDecision",
    llmResponse: {
      type: "replyDecision",
      shouldReply: true,
      reason: "Personal email, nice to reply",
      confidence: 0.55,
      priorityScore: 0.45,
      level: "normal",
      replyRequired: true,
      signals: [
        { name: "sender", value: "personal", weight: 0.3 },
        { name: "questions", value: "none", weight: 0.2 },
        { name: "direct", value: "direct", weight: 0.15 },
      ],
    },
    assertions: {
      "has-reason": (r: any) => typeof r?.reason === "string" && r.reason.length > 0 ? null : "missing-reason",
    },
  },

  // ── 21-25: Determinism and shape validation ─────────────────────
  {
    fixtureId: "priority-result-has-type",
    feature: "replyDecision",
    llmResponse: {
      type: "replyDecision",
      shouldReply: true,
      reason: "Test reason",
      confidence: 0.7,
      priorityScore: 0.5,
      level: "normal",
      replyRequired: true,
      signals: [],
    },
    assertions: {
      "type-is-replyDecision": (r: any) => r?.type === "replyDecision" ? null : "type-mismatch",
    },
  },
  {
    fixtureId: "priority-score-in-range",
    feature: "replyDecision",
    llmResponse: {
      type: "replyDecision",
      shouldReply: true,
      reason: "Test",
      confidence: 0.7,
      priorityScore: 0.5,
      level: "normal",
      replyRequired: true,
      signals: [],
    },
    assertions: {
      "score-0-1": (r: any) => typeof r?.priorityScore === "number" && r.priorityScore >= 0 && r.priorityScore <= 1 ? null : "score-out-of-range",
    },
  },
  {
    fixtureId: "priority-level-valid",
    feature: "replyDecision",
    llmResponse: {
      type: "replyDecision",
      shouldReply: false,
      reason: "Test",
      confidence: 0.5,
      priorityScore: 0.2,
      level: "low",
      replyRequired: false,
      signals: [],
    },
    assertions: {
      "level-valid": (r: any) => ["low", "normal", "high"].includes(r?.level) ? null : "level-invalid",
    },
  },
  {
    fixtureId: "priority-replyRequired-boolean",
    feature: "replyDecision",
    llmResponse: {
      type: "replyDecision",
      shouldReply: true,
      reason: "Test",
      confidence: 0.7,
      priorityScore: 0.6,
      level: "normal",
      replyRequired: true,
      signals: [],
    },
    assertions: {
      "replyRequired-boolean": (r: any) => typeof r?.replyRequired === "boolean" ? null : "replyRequired-not-boolean",
    },
  },
  {
    fixtureId: "priority-signals-array",
    feature: "replyDecision",
    llmResponse: {
      type: "replyDecision",
      shouldReply: true,
      reason: "Test",
      confidence: 0.7,
      priorityScore: 0.55,
      level: "normal",
      replyRequired: true,
      signals: [
        { name: "sender", value: "personal", weight: 0.3 },
        { name: "questions", value: "present", weight: 0.2 },
      ],
    },
    assertions: {
      "signals-array": (r: any) => Array.isArray(r?.signals) ? null : "signals-not-array",
      "signals-have-name": (r: any) => r?.signals?.every((s: any) => typeof s.name === "string") ? null : "signal-missing-name",
      "signals-have-value": (r: any) => r?.signals?.every((s: any) => typeof s.value === "string") ? null : "signal-missing-value",
    },
  },

  // ── 26-27: Additional edge cases ────────────────────────────────
  {
    fixtureId: "priority-should-reply-false-always-not-required",
    feature: "replyDecision",
    llmResponse: {
      type: "replyDecision",
      shouldReply: false,
      reason: "No reply needed",
      confidence: 0.9,
      priorityScore: 0.15,
      level: "low",
      replyRequired: false,
      signals: [],
    },
    assertions: {
      "not-required": (r: any) => r?.replyRequired === false ? null : "should-be-false",
    },
    required: true,
  },
  {
    fixtureId: "priority-low-should-reply-true-not-required",
    feature: "replyDecision",
    llmResponse: {
      type: "replyDecision",
      shouldReply: true,
      reason: "Nice to reply but not required",
      confidence: 0.5,
      priorityScore: 0.2,
      level: "low",
      replyRequired: false,
      signals: [
        { name: "sender", value: "personal", weight: 0.3 },
        { name: "direct", value: "direct", weight: 0.15 },
      ],
    },
    assertions: {
      "low-not-required": (r: any) => r?.replyRequired === false ? null : "low-should-reply-true-but-replyRequired-should-be-false",
    },
    required: true,
  },
];
