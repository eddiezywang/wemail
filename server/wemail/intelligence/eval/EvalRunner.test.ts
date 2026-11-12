import assert from "node:assert/strict";
import { test } from "node:test";
import type { IntelligenceJobType, EvalRunReport, TagResult } from "../../../../shared/wemail/intelligence.js";
import type { LlmClient, LlmRequest, LlmResponse } from "../../ai/LlmClient.js";
import { SummaryProcessor } from "../processors/SummaryProcessor.js";
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
} from "./EvalRunner.js";

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

function makeCtx(): ProcessorContext {
  return { getMessage: () => makeMessage() };
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

function createProcessorFactory() {
  const feedback = stubFeedback();
  const factory = (llmClient: LlmClient, feature: IntelligenceJobType) => {
    if (feature === "summary") {
      return new SummaryProcessor({ llmClient, model: "test-model" });
    }
    if (feature === "tags") {
      return new TagProcessor({ llmClient, model: "test-model", feedbackRules: feedback });
    }
    throw new Error(`Unknown feature: ${feature}`);
  };
  return { factory };
}

test("FakeLlmAdapter returns predetermined response", async () => {
  const adapter = fakeLlmFromJson(JSON.stringify({ type: "summary", bullets: ["a"], actionItems: [], urgency: "low" }), 10, 5);
  const response = await adapter.generate({ model: "x", messages: [] });
  assert.equal(response.finishReason, "stop");
  assert.equal(response.usage?.inputTokens, 10);
  assert.equal(response.usage?.outputTokens, 5);
  const parsed = JSON.parse(response.text);
  assert.equal(parsed.type, "summary");
});

test("runFixtureAsync passes a valid summary fixture", async () => {
  const { factory } = createProcessorFactory();

  const fixture: EvalFixture = {
    fixtureId: "test-summary-pass",
    feature: "summary",
    llmResponse: {
      type: "summary",
      bullets: ["one", "two", "three"],
      actionItems: [],
      urgency: "low",
    },
    inputTokens: 10,
    outputTokens: 5,
    assertions: {
      "has-bullets": (result: any) => {
        return (Array.isArray(result?.bullets) && result.bullets.length >= 3) ? null : "bullets-count-wrong";
      },
    },
  };

  const result = await runFixtureAsync(
    fixture,
    (llmClient) => factory(llmClient, "summary"),
    makeJob("summary"),
    makeCtx(),
  );

  assert.equal(result.fixtureId, "test-summary-pass");
  assert.equal(result.feature, "summary");
  assert.equal(result.status, "pass");
  assert.deepEqual(result.violations, []);
  assert.ok(result.tokenEstimate > 0);
});

test("runFixtureAsync fails a fixture with wrong type (processor throws)", async () => {
  const { factory } = createProcessorFactory();

  const fixture: EvalFixture = {
    fixtureId: "test-summary-type-mismatch",
    feature: "summary",
    llmResponse: {
      type: "tags",
      tags: [],
    },
    assertions: {},
  };

  const result = await runFixtureAsync(
    fixture,
    (llmClient) => factory(llmClient, "summary"),
    makeJob("summary"),
    makeCtx(),
  );

  // The SummaryProcessor validates the response, so it will throw
  // because the response doesn't have bullets/urgency. The eval runner
  // catches this and reports it as a failure.
  assert.equal(result.status, "fail");
  assert.ok(result.violations.length > 0);
});

test("runFixtureAsync fails when processor throws due to invalid response", async () => {
  const { factory } = createProcessorFactory();

  const fixture: EvalFixture = {
    fixtureId: "test-summary-assertion-fail",
    feature: "summary",
    llmResponse: {
      type: "summary",
      bullets: ["only one"],
      actionItems: [],
      urgency: "medium",
    },
    assertions: {
      "needs-3-bullets": (result: any) => {
        return result?.bullets?.length >= 3 ? null : "too-few-bullets";
      },
    },
  };

  const result = await runFixtureAsync(
    fixture,
    (llmClient) => factory(llmClient, "summary"),
    makeJob("summary"),
    makeCtx(),
  );

  // The SummaryProcessor validates bullets (1-4 required), so it will
  // throw before the assertion runs. The eval runner reports this as a failure.
  assert.equal(result.status, "fail");
  assert.ok(result.violations.length > 0);
});

test("runEvalSuite produces machine-readable report with correct structure", async () => {
  const { factory } = createProcessorFactory();

  const fixtures: EvalFixture[] = [
    {
      fixtureId: "suite-summary-1",
      feature: "summary",
      llmResponse: {
        type: "summary",
        bullets: ["one", "two", "three"],
        actionItems: [],
        urgency: "low",
      },
      assertions: {
        "has-bullets": (result: any) => result?.bullets?.length >= 3 ? null : "too-few",
      },
    },
    {
      fixtureId: "suite-summary-2",
      feature: "summary",
      llmResponse: {
        type: "summary",
        bullets: ["one", "two", "three", "four"],
        actionItems: ["do something"],
        urgency: "high",
      },
      assertions: {
        "urgency-valid": (result: any) => ["low", "medium", "high"].includes(result?.urgency) ? null : "bad-urgency",
      },
    },
  ];

  const report = await runEvalSuite(
    fixtures,
    (llmClient, feature) => factory(llmClient, feature),
    makeJob,
    makeCtx,
  );

  assert.ok(report.runAt);
  assert.equal(report.fixturesLoaded, 2);
  assert.equal(report.passed, 2);
  assert.equal(report.failed, 0);
  assert.equal(report.results.length, 2);
  assert.equal(report.results[0]!.fixtureId, "suite-summary-1");
  assert.equal(report.results[0]!.status, "pass");
  assert.equal(report.results[1]!.fixtureId, "suite-summary-2");
  assert.equal(report.results[1]!.status, "pass");
});

test("runEvalSuite reports failures correctly", async () => {
  const { factory } = createProcessorFactory();

  const fixtures: EvalFixture[] = [
    {
      fixtureId: "suite-pass",
      feature: "summary",
      llmResponse: {
        type: "summary",
        bullets: ["one", "two", "three"],
        actionItems: [],
        urgency: "low",
      },
      assertions: {},
    },
    {
      fixtureId: "suite-fail-type",
      feature: "summary",
      llmResponse: {
        type: "wrong-type",
      },
      assertions: {},
    },
  ];

  const report = await runEvalSuite(
    fixtures,
    (llmClient, feature) => factory(llmClient, feature),
    makeJob,
    makeCtx,
  );

  assert.equal(report.fixturesLoaded, 2);
  assert.equal(report.passed, 1);
  assert.equal(report.failed, 1);
});

test("hasRequiredFailures returns true when a required fixture fails", () => {
  const report: EvalRunReport = {
    runAt: "2026-04-26T12:00:00Z",
    fixturesLoaded: 2,
    passed: 1,
    failed: 1,
    results: [
      { fixtureId: "a", feature: "summary", status: "pass", violations: [], tokenEstimate: 10 },
      { fixtureId: "b", feature: "summary", status: "fail", violations: ["x"], tokenEstimate: 10 },
    ],
  };

  const fixtures: EvalFixture[] = [
    { fixtureId: "a", feature: "summary", llmResponse: {}, assertions: {}, required: true },
    { fixtureId: "b", feature: "summary", llmResponse: {}, assertions: {}, required: true },
  ];

  assert.equal(hasRequiredFailures(report, fixtures), true);
});

test("hasRequiredFailures returns false when only optional fixtures fail", () => {
  const report: EvalRunReport = {
    runAt: "2026-04-26T12:00:00Z",
    fixturesLoaded: 2,
    passed: 1,
    failed: 1,
    results: [
      { fixtureId: "a", feature: "summary", status: "pass", violations: [], tokenEstimate: 10 },
      { fixtureId: "b", feature: "summary", status: "fail", violations: ["x"], tokenEstimate: 10 },
    ],
  };

  const fixtures: EvalFixture[] = [
    { fixtureId: "a", feature: "summary", llmResponse: {}, assertions: {}, required: true },
    { fixtureId: "b", feature: "summary", llmResponse: {}, assertions: {}, required: false },
  ];

  assert.equal(hasRequiredFailures(report, fixtures), false);
});

test("eval runner tag fixture passes correctly", async () => {
  const { factory } = createProcessorFactory();

  const fixture: EvalFixture = {
    fixtureId: "test-tag-pass",
    feature: "tags",
    llmResponse: {
      type: "tags",
      tags: [],
      contentTags: [{ name: "构建日报", confidence: 0.9, source: "ai", tier: "auto" }],
    },
    assertions: {
      "has-content-tags": (result: any) => result?.contentTags?.length > 0 ? null : "no-content-tags",
    },
  };

  const result = await runFixtureAsync(
    fixture,
    (llmClient) => factory(llmClient, "tags"),
    makeJob("tags"),
    makeCtx(),
  );

  assert.equal(result.status, "pass");
  assert.equal(result.feature, "tags");
});

test("eval fixture result includes tokenEstimate from metadata", async () => {
  const { factory } = createProcessorFactory();

  const fixture: EvalFixture = {
    fixtureId: "test-token-estimate",
    feature: "summary",
    llmResponse: {
      type: "summary",
      bullets: ["one", "two", "three"],
      actionItems: [],
      urgency: "low",
    },
    inputTokens: 100,
    outputTokens: 50,
    assertions: {},
  };

  const result = await runFixtureAsync(
    fixture,
    (llmClient) => factory(llmClient, "summary"),
    makeJob("summary"),
    makeCtx(),
  );

  // tokenEstimate should come from _metadata.tokenUsage if present
  assert.ok(typeof result.tokenEstimate === "number");
  assert.ok(result.tokenEstimate > 0);
});

test("eval run against all fixture files passes", async () => {
  const { factory } = createProcessorFactory();

  const fixtures: EvalFixture[] = [
    {
      fixtureId: "summary-basic",
      feature: "summary",
      llmResponse: {
        type: "summary",
        bullets: ["Team meeting scheduled for Friday", "Budget review needed by end of week", "New hire starts on Monday"],
        actionItems: ["Prepare budget report", "Set up onboarding for new hire"],
        urgency: "medium",
      },
      inputTokens: 150,
      outputTokens: 60,
      assertions: {
        "has-bullets": (result: any) => {
          const b = result?.bullets;
          return (Array.isArray(b) && b.length >= 3 && b.length <= 4) ? null : "bullets-count-out-of-range";
        },
        "has-urgency": (result: any) => ["low", "medium", "high"].includes(result?.urgency) ? null : "urgency-not-valid",
        "has-action-items": (result: any) => Array.isArray(result?.actionItems) ? null : "actionItems-not-array",
      },
    },
    {
      fixtureId: "summary-urgent",
      feature: "summary",
      llmResponse: {
        type: "summary",
        bullets: ["Server outage affecting production", "Customer complaints rising", "Incident response team activated"],
        actionItems: ["Join incident bridge", "Update status page"],
        urgency: "high",
      },
      inputTokens: 200,
      outputTokens: 50,
      assertions: {
        "urgency-is-high": (result: any) => result?.urgency === "high" ? null : "urgency-not-high",
        "has-action-items": (result: any) => result?.actionItems?.length > 0 ? null : "no-action-items",
      },
    },
    {
      fixtureId: "summary-low-urgency",
      feature: "summary",
      llmResponse: {
        type: "summary",
        bullets: ["Newsletter about new product features", "Monthly digest of industry news", "Tips for better productivity"],
        actionItems: [],
        urgency: "low",
      },
      inputTokens: 120,
      outputTokens: 40,
      assertions: {
        "urgency-is-low": (result: any) => result?.urgency === "low" ? null : "urgency-not-low",
        "no-action-items": (result: any) => Array.isArray(result?.actionItems) && result.actionItems.length === 0 ? null : "action-items-should-be-empty",
      },
    },
    {
      fixtureId: "summary-with-action-items",
      feature: "summary",
      llmResponse: {
        type: "summary",
        bullets: ["Client requested changes to the proposal", "Deadline extended to next Wednesday", "Team lead approval still pending"],
        actionItems: ["Revise proposal sections 3-5", "Get team lead sign-off", "Send updated version to client"],
        urgency: "medium",
      },
      inputTokens: 180,
      outputTokens: 70,
      assertions: {
        "has-multiple-action-items": (result: any) => result?.actionItems?.length >= 2 ? null : "too-few-action-items",
        "has-bullets": (result: any) => result?.bullets?.length >= 3 ? null : "too-few-bullets",
      },
    },
    {
      fixtureId: "summary-four-bullets",
      feature: "summary",
      llmResponse: {
        type: "summary",
        bullets: ["Point one about the project", "Point two about timeline", "Point three about resources", "Point four about risks"],
        actionItems: ["Review timeline"],
        urgency: "medium",
      },
      inputTokens: 160,
      outputTokens: 80,
      assertions: {
        "max-four-bullets": (result: any) => result?.bullets?.length <= 4 ? null : "too-many-bullets",
        "has-bullets": (result: any) => result?.bullets?.length >= 3 ? null : "too-few-bullets",
      },
    },
    {
      fixtureId: "tags-basic",
      feature: "tags",
      llmResponse: {
        type: "tags",
        tags: [],
        contentTags: [
          { name: "系统告警", confidence: 0.9, source: "ai", tier: "auto" },
          { name: "运行日报", confidence: 0.7, source: "ai", tier: "suggested" },
        ],
      },
      inputTokens: 100,
      outputTokens: 30,
      assertions: {
        "has-tags": (result: any) => Array.isArray(result?.contentTags) && result.contentTags.length > 0 ? null : "no-tags",
        "tags-have-confidence": (result: any) => result?.contentTags?.every((t: any) => typeof t.confidence === "number" && t.confidence >= 0 && t.confidence <= 1) ? null : "confidence-out-of-range",
      },
    },
    {
      fixtureId: "tags-high-confidence",
      feature: "tags",
      llmResponse: {
        type: "tags",
        tags: [],
        contentTags: [{ name: "采购审批", confidence: 0.95, source: "ai", tier: "auto" }],
      },
      inputTokens: 90,
      outputTokens: 25,
      assertions: {
        "has-tags": (result: any) => result?.contentTags?.length > 0 ? null : "no-tags",
        "high-confidence": (result: any) => result?.contentTags?.some((t: any) => t.confidence >= 0.85) ? null : "no-high-confidence-tag",
      },
    },
    {
      fixtureId: "tags-multiple-categories",
      feature: "tags",
      llmResponse: {
        type: "tags",
        tags: [],
        contentTags: [
          { name: "客户会议", confidence: 0.85, source: "ai", tier: "auto" },
          { name: "季度需求", confidence: 0.6, source: "ai", tier: "suggested" },
          { name: "方案评审", confidence: 0.5, source: "ai", tier: "suggested" },
        ],
      },
      inputTokens: 110,
      outputTokens: 40,
      assertions: {
        "has-multiple-tags": (result: any) => result?.contentTags?.length >= 2 ? null : "too-few-tags",
        "all-have-source": (result: any) => result?.contentTags?.every((t: any) => t.source === "ai") ? null : "source-not-ai",
      },
    },
    {
      fixtureId: "tags-with-tier",
      feature: "tags",
      llmResponse: {
        type: "tags",
        tags: [],
        contentTags: [{ name: "系统告警", confidence: 0.92, source: "ai", tier: "auto" }],
      },
      inputTokens: 80,
      outputTokens: 20,
      assertions: {
        "has-tier": (result: any) => result?.contentTags?.every((t: any) => t.tier === "auto" || t.tier === "suggested") ? null : "tier-missing",
      },
    },
    {
      fixtureId: "tags-empty",
      feature: "tags",
      llmResponse: {
        type: "tags",
        tags: [],
      },
      inputTokens: 70,
      outputTokens: 10,
      assertions: {
        "has-empty-tags": (result: any) => Array.isArray(result?.tags) ? null : "tags-not-array",
      },
      required: false,
    },
  ];

  const report = await runEvalSuite(
    fixtures,
    (llmClient, feature) => factory(llmClient, feature as IntelligenceJobType),
    (feature: IntelligenceJobType) => makeJob(feature),
    makeCtx,
  );

  assert.equal(report.fixturesLoaded, 10, "should load 10 fixtures");
  assert.equal(report.passed, 10, `all 10 fixtures should pass, but ${report.failed} failed: ${report.results.filter((r) => r.status === "fail").map((r) => `${r.fixtureId}: ${r.violations.join(", ")}`).join("; ")}`);

  // Verify machine-readable structure
  for (const result of report.results) {
    assert.ok(result.fixtureId, "each result should have fixtureId");
    assert.ok(result.feature, "each result should have feature");
    assert.ok(result.status === "pass" || result.status === "fail", "each result should have valid status");
    assert.ok(Array.isArray(result.violations), "each result should have violations array");
    assert.ok(typeof result.tokenEstimate === "number", "each result should have tokenEstimate");
  }

  // No required failures
  assert.equal(hasRequiredFailures(report, fixtures), false, "no required fixtures should fail");
});

// ---------------------------------------------------------------------------
// Concurrency / determinism
// ---------------------------------------------------------------------------

/**
 * A FakeLlmAdapter that sleeps for `delayMs` before resolving. Used to
 * verify that the worker pool actually overlaps fixtures.
 */
class SlowFakeLlmAdapter implements LlmClient {
  private readonly response: LlmResponse;
  private readonly delayMs: number;

  constructor(response: LlmResponse, delayMs: number) {
    this.response = response;
    this.delayMs = delayMs;
  }

  async generate(_input: LlmRequest): Promise<LlmResponse> {
    await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    return this.response;
  }
}

test("runEvalSuite sorts results by fixtureId for deterministic output", async () => {
  const { factory } = createProcessorFactory();

  // Insert fixtures out-of-order on purpose. With concurrency, the
  // resolution order is non-deterministic; the report must still be
  // sorted alphabetically by fixtureId.
  const ids = ["zeta", "alpha", "mike", "bravo", "yankee", "charlie", "delta", "echo"];
  const fixtures: EvalFixture[] = ids.map((id) => ({
    fixtureId: id,
    feature: "summary",
    llmResponse: {
      type: "summary",
      bullets: ["one", "two", "three"],
      actionItems: [],
      urgency: "low",
    },
    assertions: {},
  }));

  const report = await runEvalSuite(
    fixtures,
    (llmClient, feature) => factory(llmClient, feature),
    makeJob,
    makeCtx,
    { concurrency: 4 },
  );

  const sortedIds = [...ids].sort((a, b) => a.localeCompare(b));
  assert.deepEqual(
    report.results.map((r) => r.fixtureId),
    sortedIds,
    "results must be sorted by fixtureId regardless of resolution order",
  );
});

test("runEvalSuite with concurrency:1 still produces correct results", async () => {
  const { factory } = createProcessorFactory();

  const fixtures: EvalFixture[] = ["b", "a", "c"].map((id) => ({
    fixtureId: id,
    feature: "summary",
    llmResponse: {
      type: "summary",
      bullets: ["one", "two", "three"],
      actionItems: [],
      urgency: "low",
    },
    assertions: {},
  }));

  const report = await runEvalSuite(
    fixtures,
    (llmClient, feature) => factory(llmClient, feature),
    makeJob,
    makeCtx,
    { concurrency: 1 },
  );

  assert.equal(report.fixturesLoaded, 3);
  assert.equal(report.passed, 3);
  assert.deepEqual(
    report.results.map((r) => r.fixtureId),
    ["a", "b", "c"],
  );
});

test("runEvalSuite with concurrency overlaps slow fixtures", async () => {
  // Build a one-off processor factory wired to a SlowFakeLlmAdapter.
  // We deliberately do NOT reuse fakeLlmFromJson because we need the
  // adapter to actually wait — that's what proves the pool overlaps.
  const feedback = stubFeedback();
  const slowFactory = (llmClient: LlmClient, feature: IntelligenceJobType) => {
    if (feature === "summary") {
      return new SummaryProcessor({ llmClient, model: "test-model" });
    }
    if (feature === "tags") {
      return new TagProcessor({ llmClient, model: "test-model", feedbackRules: feedback });
    }
    throw new Error(`Unknown feature: ${feature}`);
  };

  const slowResponse: LlmResponse = {
    text: JSON.stringify({
      type: "summary",
      bullets: ["one", "two", "three"],
      actionItems: [],
      urgency: "low",
    }),
    finishReason: "stop",
    usage: { inputTokens: 10, outputTokens: 5 },
  };
  const delayMs = 50;
  const fixtures: EvalFixture[] = Array.from({ length: 8 }, (_, i) => ({
    fixtureId: `slow-${String(i).padStart(2, "0")}`,
    feature: "summary" as IntelligenceJobType,
    llmResponse: {
      type: "summary",
      bullets: ["one", "two", "three"],
      actionItems: [],
      urgency: "low",
    },
    assertions: {},
  }));

  // Patch the runner to feed a SlowFakeLlmAdapter — easiest way is to
  // wrap the factory so the LlmClient handed to the processor is slow.
  const wrappedFactory = (
    _llmClient: LlmClient,
    feature: IntelligenceJobType,
  ) => slowFactory(new SlowFakeLlmAdapter(slowResponse, delayMs), feature);

  const start = Date.now();
  const report = await runEvalSuite(
    fixtures,
    wrappedFactory,
    makeJob,
    makeCtx,
    { concurrency: 4 },
  );
  const elapsed = Date.now() - start;

  assert.equal(report.fixturesLoaded, 8, "all 8 fixtures load");
  assert.equal(report.passed, 8, "all 8 fixtures pass");
  // Sorted by fixtureId.
  assert.deepEqual(
    report.results.map((r) => r.fixtureId),
    [...fixtures.map((f) => f.fixtureId)].sort((a, b) => a.localeCompare(b)),
  );

  // Sequential time would be ~ 8 * 50 = 400ms. With concurrency 4 the
  // floor is ~ (8/4) * 50 = 100ms. Allow generous slack on slow CI:
  // require elapsed < (sequential / 1.5) = 266ms.
  const sequentialTime = delayMs * fixtures.length;
  assert.ok(
    elapsed < sequentialTime / 1.5,
    `concurrency expected to cut wall time but got ${elapsed}ms vs sequential ${sequentialTime}ms`,
  );
});
