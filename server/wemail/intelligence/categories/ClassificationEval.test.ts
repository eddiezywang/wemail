import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  ClassificationResult,
  EvalFixtureResult,
  EvalRunReport,
  IntelligenceJobType,
  TagResult,
} from "../../../../shared/wemail/intelligence.js";
import type { LlmClient } from "../../ai/LlmClient.js";
import { TagProcessor } from "../processors/TagProcessor.js";
import { TagFeedbackRuleRepository } from "../../feedback/TagFeedbackRuleRepository.js";
import type { MailMessage } from "../../../../shared/wemail/mail.js";
import type { ProcessorContext } from "../MailIntelligenceProcessor.js";
import {
  type EvalFixture,
  FakeLlmAdapter,
  fakeLlmFromJson,
  runFixtureAsync,
  runEvalSuite,
  hasRequiredFailures,
} from "../eval/EvalRunner.js";
import { SYSTEM_CATEGORY_SET } from "../../../../shared/wemail/intelligence.js";

function makeMessage(overrides: Partial<MailMessage> = {}): MailMessage {
  return {
    id: "acct-1:INBOX:1:100",
    accountId: "acct-1",
    folder: "INBOX",
    messageId: "<m-100@x.com>",
    from: { email: "boss@x.com", name: "Boss" },
    to: [{ email: "me@x.com" }],
    cc: [],
    bcc: [],
    subject: "Q3 plans",
    snippet: "we need",
    bodyText: "Please prepare the Q3 deck by Friday.",
    receivedAt: "2026-04-24T10:00:00.000Z",
    hasAttachments: false,
    attachments: [],
    flags: { seen: false, flagged: false, answered: false, draft: false },
    sync: { uid: 100, uidValidity: 1, internalDate: "2026-04-24T10:00:00Z" },
    ...overrides,
  };
}

function makeJob(type: IntelligenceJobType) {
  return {
    id: "job-1",
    emailId: "acct-1:INBOX:1:100",
    type,
    status: "running",
    attempts: 0,
    maxAttempts: 2,
    createdAt: "2026-04-24T10:00:00Z",
    updatedAt: "2026-04-24T10:00:00Z",
  };
}

function makeCtx(message?: MailMessage): ProcessorContext {
  return { getMessage: () => message ?? makeMessage() };
}

function stubFeedback(): TagFeedbackRuleRepository {
  return {
    addRejection: () => ({ id: "stub", accountId: "acct-1", tag: "stub", action: "reject" as const, createdAt: "" }),
    removeRejection: () => 0,
    listRules: () => [],
    findRulesForMail: () => [],
    applyRules: (tags: TagResult) => ({ result: tags, droppedByRules: 0, dynamicTags: 0, droppedOffVocab: 0 }),
  } as unknown as TagFeedbackRuleRepository;
}

function createTagProcessorFactory() {
  const feedback = stubFeedback();
  return (llmClient: LlmClient) =>
    new TagProcessor({ llmClient, model: "test-model", feedbackRules: feedback });
}

/**
 * Classification fixtures: 30+ test cases covering all 8 system categories
 * plus dynamic tags, edge cases, and feedback suppression scenarios.
 */
const classificationFixtures: EvalFixture[] = [
  // ── Newsletter category (4 fixtures) ──
  {
    fixtureId: "cls-newsletter-weekly-digest",
    feature: "tags",
    llmResponse: {
      type: "tags",
      tags: [{ name: "newsletter", confidence: 0.95, source: "ai" }],
    },
    assertions: {
      "has-classification": (result: any) =>
        result?.classification?.categoryId === "newsletter" ? null : "wrong-category",
      "high-confidence": (result: any) =>
        result?.classification?.confidence >= 0.8 ? null : "low-confidence",
    },
  },
  {
    fixtureId: "cls-newsletter-monthly-update",
    feature: "tags",
    llmResponse: {
      type: "tags",
      tags: [{ name: "newsletter", confidence: 0.85, source: "ai" }],
    },
    assertions: {
      "has-classification": (result: any) =>
        result?.classification?.categoryId === "newsletter" ? null : "wrong-category",
    },
  },
  {
    fixtureId: "cls-newsletter-low-confidence",
    feature: "tags",
    llmResponse: {
      type: "tags",
      tags: [{ name: "newsletter", confidence: 0.6, source: "ai" }],
    },
    assertions: {
      "has-classification": (result: any) =>
        result?.classification?.categoryId === "newsletter" ? null : "wrong-category",
    },
  },
  {
    fixtureId: "cls-newsletter-with-dynamic",
    feature: "tags",
    llmResponse: {
      type: "tags",
      tags: [
        { name: "newsletter", confidence: 0.9, source: "ai" },
        { name: "tech", confidence: 0.7, source: "ai" },
      ],
    },
    assertions: {
      "has-classification": (result: any) =>
        result?.classification?.categoryId === "newsletter" ? null : "wrong-category",
    },
  },

  // ── Marketing category (4 fixtures) ──
  {
    fixtureId: "cls-marketing-promo",
    feature: "tags",
    llmResponse: {
      type: "tags",
      tags: [{ name: "marketing", confidence: 0.92, source: "ai" }],
    },
    assertions: {
      "has-classification": (result: any) =>
        result?.classification?.categoryId === "marketing" ? null : "wrong-category",
    },
  },
  {
    fixtureId: "cls-marketing-sale",
    feature: "tags",
    llmResponse: {
      type: "tags",
      tags: [{ name: "marketing", confidence: 0.88, source: "ai" }],
    },
    assertions: {
      "has-classification": (result: any) =>
        result?.classification?.categoryId === "marketing" ? null : "wrong-category",
    },
  },
  {
    fixtureId: "cls-marketing-discount",
    feature: "tags",
    llmResponse: {
      type: "tags",
      tags: [{ name: "marketing", confidence: 0.75, source: "ai" }],
    },
    assertions: {
      "has-classification": (result: any) =>
        result?.classification?.categoryId === "marketing" ? null : "wrong-category",
    },
  },
  {
    fixtureId: "cls-marketing-with-newsletter",
    feature: "tags",
    llmResponse: {
      type: "tags",
      tags: [
        { name: "marketing", confidence: 0.9, source: "ai" },
        { name: "newsletter", confidence: 0.6, source: "ai" },
      ],
    },
    assertions: {
      "has-classification": (result: any) =>
        result?.classification?.categoryId === "marketing" ? null : "wrong-category",
      "picks-highest-confidence": (result: any) =>
        result?.classification?.confidence >= 0.9 ? null : "should-pick-highest",
    },
  },

  // ── Receipt category (4 fixtures) ──
  {
    fixtureId: "cls-receipt-purchase",
    feature: "tags",
    llmResponse: {
      type: "tags",
      tags: [{ name: "receipt", confidence: 0.95, source: "ai" }],
    },
    assertions: {
      "has-classification": (result: any) =>
        result?.classification?.categoryId === "receipt" ? null : "wrong-category",
    },
  },
  {
    fixtureId: "cls-receipt-invoice",
    feature: "tags",
    llmResponse: {
      type: "tags",
      tags: [{ name: "receipt", confidence: 0.9, source: "ai" }],
    },
    assertions: {
      "has-classification": (result: any) =>
        result?.classification?.categoryId === "receipt" ? null : "wrong-category",
    },
  },
  {
    fixtureId: "cls-receipt-order-confirm",
    feature: "tags",
    llmResponse: {
      type: "tags",
      tags: [{ name: "receipt", confidence: 0.85, source: "ai" }],
    },
    assertions: {
      "has-classification": (result: any) =>
        result?.classification?.categoryId === "receipt" ? null : "wrong-category",
    },
  },
  {
    fixtureId: "cls-receipt-payment",
    feature: "tags",
    llmResponse: {
      type: "tags",
      tags: [{ name: "receipt", confidence: 0.7, source: "ai" }],
    },
    assertions: {
      "has-classification": (result: any) =>
        result?.classification?.categoryId === "receipt" ? null : "wrong-category",
    },
  },

  // ── Notification category (4 fixtures) ──
  {
    fixtureId: "cls-notification-alert",
    feature: "tags",
    llmResponse: {
      type: "tags",
      tags: [{ name: "notification", confidence: 0.93, source: "ai" }],
    },
    assertions: {
      "has-classification": (result: any) =>
        result?.classification?.categoryId === "notification" ? null : "wrong-category",
    },
  },
  {
    fixtureId: "cls-notification-system",
    feature: "tags",
    llmResponse: {
      type: "tags",
      tags: [{ name: "notification", confidence: 0.88, source: "ai" }],
    },
    assertions: {
      "has-classification": (result: any) =>
        result?.classification?.categoryId === "notification" ? null : "wrong-category",
    },
  },
  {
    fixtureId: "cls-notification-automated",
    feature: "tags",
    llmResponse: {
      type: "tags",
      tags: [{ name: "notification", confidence: 0.8, source: "ai" }],
    },
    assertions: {
      "has-classification": (result: any) =>
        result?.classification?.categoryId === "notification" ? null : "wrong-category",
    },
  },
  {
    fixtureId: "cls-notification-update",
    feature: "tags",
    llmResponse: {
      type: "tags",
      tags: [
        { name: "notification", confidence: 0.85, source: "ai" },
        { name: "security", confidence: 0.6, source: "ai" },
      ],
    },
    assertions: {
      "has-classification": (result: any) =>
        result?.classification?.categoryId === "notification" ? null : "wrong-category",
    },
  },

  // ── Important category (3 fixtures) ──
  {
    fixtureId: "cls-important-urgent",
    feature: "tags",
    llmResponse: {
      type: "tags",
      tags: [{ name: "important", confidence: 0.95, source: "ai" }],
    },
    assertions: {
      "has-classification": (result: any) =>
        result?.classification?.categoryId === "important" ? null : "wrong-category",
    },
  },
  {
    fixtureId: "cls-important-critical",
    feature: "tags",
    llmResponse: {
      type: "tags",
      tags: [{ name: "important", confidence: 0.88, source: "ai" }],
    },
    assertions: {
      "has-classification": (result: any) =>
        result?.classification?.categoryId === "important" ? null : "wrong-category",
    },
  },
  {
    fixtureId: "cls-important-with-action",
    feature: "tags",
    llmResponse: {
      type: "tags",
      tags: [
        { name: "important", confidence: 0.9, source: "ai" },
        { name: "action_required", confidence: 0.7, source: "ai" },
      ],
    },
    assertions: {
      "has-classification": (result: any) =>
        result?.classification?.categoryId === "important" ? null : "wrong-category",
      "picks-highest": (result: any) =>
        result?.classification?.confidence >= 0.9 ? null : "should-pick-highest",
    },
  },

  // ── Action Required category (3 fixtures) ──
  {
    fixtureId: "cls-action-deadline",
    feature: "tags",
    llmResponse: {
      type: "tags",
      tags: [{ name: "action_required", confidence: 0.92, source: "ai" }],
    },
    assertions: {
      "has-classification": (result: any) =>
        result?.classification?.categoryId === "action_required" ? null : "wrong-category",
    },
  },
  {
    fixtureId: "cls-action-review",
    feature: "tags",
    llmResponse: {
      type: "tags",
      tags: [{ name: "action_required", confidence: 0.85, source: "ai" }],
    },
    assertions: {
      "has-classification": (result: any) =>
        result?.classification?.categoryId === "action_required" ? null : "wrong-category",
    },
  },
  {
    fixtureId: "cls-action-approval",
    feature: "tags",
    llmResponse: {
      type: "tags",
      tags: [{ name: "action_required", confidence: 0.78, source: "ai" }],
    },
    assertions: {
      "has-classification": (result: any) =>
        result?.classification?.categoryId === "action_required" ? null : "wrong-category",
    },
  },

  // ── Personal category (3 fixtures) ──
  {
    fixtureId: "cls-personal-friend",
    feature: "tags",
    llmResponse: {
      type: "tags",
      tags: [{ name: "personal", confidence: 0.9, source: "ai" }],
    },
    assertions: {
      "has-classification": (result: any) =>
        result?.classification?.categoryId === "personal" ? null : "wrong-category",
    },
  },
  {
    fixtureId: "cls-personal-family",
    feature: "tags",
    llmResponse: {
      type: "tags",
      tags: [{ name: "personal", confidence: 0.85, source: "ai" }],
    },
    assertions: {
      "has-classification": (result: any) =>
        result?.classification?.categoryId === "personal" ? null : "wrong-category",
    },
  },
  {
    fixtureId: "cls-personal-social",
    feature: "tags",
    llmResponse: {
      type: "tags",
      tags: [{ name: "personal", confidence: 0.75, source: "ai" }],
    },
    assertions: {
      "has-classification": (result: any) =>
        result?.classification?.categoryId === "personal" ? null : "wrong-category",
    },
  },

  // ── Other category (3 fixtures) ──
  {
    fixtureId: "cls-other-no-system-tag",
    feature: "tags",
    llmResponse: {
      type: "tags",
      tags: [{ name: "finance", confidence: 0.8, source: "ai" }],
    },
    assertions: {
      "defaults-to-other": (result: any) =>
        result?.classification?.categoryId === "other" ? null : "should-default-to-other",
    },
  },
  {
    fixtureId: "cls-other-multiple-dynamic",
    feature: "tags",
    llmResponse: {
      type: "tags",
      tags: [
        { name: "travel", confidence: 0.7, source: "ai" },
        { name: "food", confidence: 0.6, source: "ai" },
      ],
    },
    assertions: {
      "defaults-to-other": (result: any) =>
        result?.classification?.categoryId === "other" ? null : "should-default-to-other",
    },
  },
  {
    fixtureId: "cls-other-empty-tags",
    feature: "tags",
    llmResponse: {
      type: "tags",
      tags: [],
    },
    assertions: {
      "defaults-to-other": (result: any) =>
        result?.classification?.categoryId === "other" ? null : "should-default-to-other",
    },
    required: false,
  },

  // ── Multi-category conflict resolution (2 fixtures) ──
  {
    fixtureId: "cls-multi-highest-confidence-wins",
    feature: "tags",
    llmResponse: {
      type: "tags",
      tags: [
        { name: "marketing", confidence: 0.9, source: "ai" },
        { name: "notification", confidence: 0.7, source: "ai" },
        { name: "newsletter", confidence: 0.5, source: "ai" },
      ],
    },
    assertions: {
      "picks-marketing": (result: any) =>
        result?.classification?.categoryId === "marketing" ? null : "should-pick-highest-confidence",
    },
  },
  {
    fixtureId: "cls-multi-important-overrides",
    feature: "tags",
    llmResponse: {
      type: "tags",
      tags: [
        { name: "important", confidence: 0.95, source: "ai" },
        { name: "action_required", confidence: 0.8, source: "ai" },
      ],
    },
    assertions: {
      "picks-important": (result: any) =>
        result?.classification?.categoryId === "important" ? null : "should-pick-highest",
    },
  },
];

test("classification eval: retained legacy projections pass while removed buckets stay internal", async () => {
  const factory = createTagProcessorFactory();
  const retainedFixtures = classificationFixtures.filter((fixture) =>
    !/(newsletter|marketing|receipt|notification|personal|highest-confidence-wins)/u.test(fixture.fixtureId),
  );

  const report = await runEvalSuite(
    retainedFixtures,
    (llmClient, _feature) => factory(llmClient),
    () => makeJob("tags"),
    makeCtx,
  );

  assert.equal(report.fixturesLoaded, retainedFixtures.length, "should load retained compatibility fixtures");
  const failedFixtures = report.results.filter((r) => r.status === "fail");
  assert.equal(
    failedFixtures.length,
    0,
    `${failedFixtures.length} fixtures failed: ${failedFixtures.map((f) => `${f.fixtureId}: ${f.violations.join(", ")}`).join("; ")}`,
  );
  assert.equal(report.passed, retainedFixtures.length);
  assert.equal(report.failed, 0);
  assert.equal(hasRequiredFailures(report, retainedFixtures), false);
});

test("classification result structure: categoryId is a system category id", async () => {
  const factory = createTagProcessorFactory();
  const fixture: EvalFixture = {
    fixtureId: "cls-structure-check",
    feature: "tags",
    llmResponse: {
      type: "tags",
      tags: [{ name: "newsletter", confidence: 0.9, source: "ai" }],
    },
    assertions: {
      "classification-has-categoryId": (result: any) =>
        typeof result?.classification?.categoryId === "string" ? null : "missing-categoryId",
      "classification-has-reason": (result: any) =>
        typeof result?.classification?.reason === "string" && result.classification.reason.length > 0
          ? null
          : "missing-reason",
      "classification-has-confidence": (result: any) =>
        typeof result?.classification?.confidence === "number" &&
        result.classification.confidence >= 0 &&
        result.classification.confidence <= 1
          ? null
          : "invalid-confidence",
      "categoryId-is-system": (result: any) =>
        SYSTEM_CATEGORY_SET.has(result?.classification?.categoryId) ? null : "not-a-system-category",
    },
  };

  const result = await runFixtureAsync(
    fixture,
    factory,
    makeJob("tags"),
    makeCtx(),
  );

  assert.equal(result.status, "pass");
  assert.deepEqual(result.violations, []);
});

test("classification eval: suppressed category defaults to next best", async () => {
  const feedback = stubFeedback();
  // Add a rejection for "marketing" to simulate feedback suppression
  const feedbackWithSuppression = {
    ...feedback,
    findRulesForMail: () => [{
      id: "tfr-suppress",
      accountId: "acct-1",
      tag: "marketing",
      action: "reject" as const,
      senderPattern: "boss@x.com",
      subjectPattern: "q3 plans",
      createdAt: "2026-04-24T10:00:00Z",
    }],
  } as unknown as TagFeedbackRuleRepository;

  const factory = (llmClient: LlmClient) =>
    new TagProcessor({ llmClient, model: "test-model", feedbackRules: feedbackWithSuppression });

  const fixture: EvalFixture = {
    fixtureId: "cls-suppressed-marketing",
    feature: "tags",
    llmResponse: {
      type: "tags",
      tags: [
        { name: "marketing", confidence: 0.9, source: "ai" },
        { name: "newsletter", confidence: 0.7, source: "ai" },
      ],
    },
    assertions: {
      "not-marketing": (result: any) =>
        result?.classification?.categoryId !== "marketing" ? null : "should-suppress-marketing",
      "fallback-to-other": (result: any) =>
        result?.classification?.categoryId === "other" ? null : "removed legacy buckets must not be promoted",
    },
  };

  const result = await runFixtureAsync(
    fixture,
    factory,
    makeJob("tags"),
    makeCtx(),
  );

  assert.equal(result.status, "pass", `violations: ${result.violations.join(", ")}`);
});

test("classification eval report has correct structure", async () => {
  const factory = createTagProcessorFactory();

  const report = await runEvalSuite(
    classificationFixtures.slice(0, 5),
    (llmClient, _feature) => factory(llmClient),
    () => makeJob("tags"),
    makeCtx,
  );

  assert.ok(report.runAt);
  assert.equal(typeof report.fixturesLoaded, "number");
  assert.equal(typeof report.passed, "number");
  assert.equal(typeof report.failed, "number");
  assert.ok(Array.isArray(report.results));
  for (const result of report.results) {
    assert.ok(result.fixtureId);
    assert.ok(result.feature);
    assert.ok(result.status === "pass" || result.status === "fail");
    assert.ok(Array.isArray(result.violations));
    assert.ok(typeof result.tokenEstimate === "number");
  }
});
