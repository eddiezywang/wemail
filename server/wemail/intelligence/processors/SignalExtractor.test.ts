import assert from "node:assert/strict";
import { test } from "node:test";
import {
  extractSignals,
  computePriorityScore,
  deriveLevel,
  deriveReplyRequired,
  extractDeadlineDate,
  BULK_CATEGORY_SIGNALS,
  NEWSLETTER_DOMAINS,
  type PrioritySignal,
  type SignalExtractionInput,
} from "./SignalExtractor.js";

// ── Signal extraction tests ──────────────────────────────────────

test("extractSignals returns 6 signals with correct names", () => {
  const signals = extractSignals({
    subject: "Test",
    from: { email: "boss@company.com", name: "Boss" },
    to: [{ email: "me@company.com" }],
    bodyText: "Can you review this?",
  });
  assert.equal(signals.length, 6);
  const names = signals.map((s) => s.name);
  assert.ok(names.includes("sender"));
  assert.ok(names.includes("questions"));
  assert.ok(names.includes("deadline"));
  assert.ok(names.includes("direct"));
  assert.ok(names.includes("reply-history"));
  assert.ok(names.includes("system-category"));
});

test("extractSignals: personal sender detected", () => {
  const signals = extractSignals({ from: { email: "alice@company.com" } });
  const sender = signals.find((s) => s.name === "sender")!;
  assert.equal(sender.value, "personal");
  assert.equal(sender.weight, 0.3);
});

test("extractSignals: automated/noreply sender detected", () => {
  const signals = extractSignals({ from: { email: "noreply@github.com" } });
  const sender = signals.find((s) => s.name === "sender")!;
  assert.equal(sender.value, "automated");
});

test("extractSignals: newsletter domain detected", () => {
  const signals = extractSignals({ from: { email: "news@mailchimp.com" } });
  const sender = signals.find((s) => s.name === "sender")!;
  assert.equal(sender.value, "newsletter");
});

test("extractSignals: string from address works", () => {
  const signals = extractSignals({ from: "noreply@alerts.com" });
  const sender = signals.find((s) => s.name === "sender")!;
  assert.equal(sender.value, "automated");
});

test("extractSignals: questions detected in body", () => {
  const signals = extractSignals({ bodyText: "Can you help?" });
  const questions = signals.find((s) => s.name === "questions")!;
  assert.equal(questions.value, "present");
});

test("extractSignals: many questions detected", () => {
  const signals = extractSignals({
    bodyText: "Can you help? 请问什么时候？ How do I do this?",
  });
  const questions = signals.find((s) => s.name === "questions")!;
  assert.equal(questions.value, "many");
});

test("extractSignals: no questions detected", () => {
  const signals = extractSignals({ bodyText: "Just a status update." });
  const questions = signals.find((s) => s.name === "questions")!;
  assert.equal(questions.value, "none");
});

test("extractSignals: deadline detected in body", () => {
  const signals = extractSignals({ bodyText: "Please respond by Friday." });
  const deadline = signals.find((s) => s.name === "deadline")!;
  assert.equal(deadline.value, "present");
});

test("extractSignals: no deadline detected", () => {
  const signals = extractSignals({ bodyText: "FYI, no rush." });
  const deadline = signals.find((s) => s.name === "deadline")!;
  assert.equal(deadline.value, "none");
});

test("extractSignals: direct addressing (user in To)", () => {
  const signals = extractSignals({
    to: [{ email: "me@company.com" }],
    cc: [],
    userEmail: "me@company.com",
  });
  const direct = signals.find((s) => s.name === "direct")!;
  assert.equal(direct.value, "direct");
});

test("extractSignals: CC addressing", () => {
  const signals = extractSignals({
    to: [{ email: "someone@company.com" }],
    cc: [{ email: "me@company.com" }],
    userEmail: "me@company.com",
  });
  const direct = signals.find((s) => s.name === "direct")!;
  assert.equal(direct.value, "cc");
});

test("extractSignals: broadcast (many recipients)", () => {
  const signals = extractSignals({
    to: Array.from({ length: 10 }, (_, i) => ({ email: `person${i}@co.com` })),
  });
  const direct = signals.find((s) => s.name === "direct")!;
  assert.equal(direct.value, "broadcast");
});

test("extractSignals: reply history has-replied", () => {
  const signals = extractSignals({ hasRepliedBefore: true });
  const history = signals.find((s) => s.name === "reply-history")!;
  assert.equal(history.value, "has-replied");
});

test("extractSignals: reply history no-history", () => {
  const signals = extractSignals({ hasRepliedBefore: false });
  const history = signals.find((s) => s.name === "reply-history")!;
  assert.equal(history.value, "no-history");
});

test("extractSignals: bulk tag detected as system-category", () => {
  const signals = extractSignals({ tags: ["通知"] });
  const cat = signals.find((s) => s.name === "system-category")!;
  assert.equal(cat.value, "通知");
});

test("extractSignals: action tag detected as system-category", () => {
  const signals = extractSignals({ tags: ["待回复"] });
  const cat = signals.find((s) => s.name === "system-category")!;
  assert.equal(cat.value, "待回复");
});

test("extractSignals: classificationCategoryId takes precedence over tags", () => {
  const signals = extractSignals({ tags: ["通知"], classificationCategoryId: "newsletter" });
  const cat = signals.find((s) => s.name === "system-category")!;
  assert.equal(cat.value, "newsletter");
});

test("extractSignals: untagged when no tags", () => {
  const signals = extractSignals({});
  const cat = signals.find((s) => s.name === "system-category")!;
  assert.equal(cat.value, "untagged");
});

// ── Priority score tests ─────────────────────────────────────────

test("computePriorityScore: neutral baseline for empty signals", () => {
  // All signals at default values → score close to 0.5
  const signals: PrioritySignal[] = [
    { name: "sender", value: "personal", weight: 0.3 },
    { name: "questions", value: "none", weight: 0.2 },
    { name: "deadline", value: "none", weight: 0.25 },
    { name: "direct", value: "direct", weight: 0.15 },
    { name: "reply-history", value: "no-history", weight: 0.05 },
    { name: "system-category", value: "untagged", weight: 0.15 },
  ];
  const score = computePriorityScore(signals);
  assert.ok(score > 0.3, `score should be above 0.3, got ${score}`);
  assert.ok(score < 0.8, `score should be below 0.8, got ${score}`);
});

test("computePriorityScore: automated sender drops score", () => {
  const auto = computePriorityScore([
    { name: "sender", value: "automated", weight: 0.3 },
    { name: "questions", value: "none", weight: 0.2 },
    { name: "deadline", value: "none", weight: 0.25 },
    { name: "direct", value: "bcc-or-list", weight: 0.15 },
    { name: "reply-history", value: "no-history", weight: 0.05 },
    { name: "system-category", value: "untagged", weight: 0.15 },
  ]);
  assert.ok(auto < 0.35, `automated sender should produce low score, got ${auto}`);
});

test("computePriorityScore: newsletter domain drops score", () => {
  const newsletter = computePriorityScore([
    { name: "sender", value: "newsletter", weight: 0.3 },
    { name: "questions", value: "none", weight: 0.2 },
    { name: "deadline", value: "none", weight: 0.25 },
    { name: "direct", value: "bcc-or-list", weight: 0.15 },
    { name: "reply-history", value: "no-history", weight: 0.05 },
    { name: "system-category", value: "untagged", weight: 0.15 },
  ]);
  assert.ok(newsletter < 0.35, `newsletter should produce low score, got ${newsletter}`);
});

test("computePriorityScore: direct+deadline+questions = high", () => {
  const high = computePriorityScore([
    { name: "sender", value: "personal", weight: 0.3 },
    { name: "questions", value: "many", weight: 0.2 },
    { name: "deadline", value: "present", weight: 0.25 },
    { name: "direct", value: "direct", weight: 0.15 },
    { name: "reply-history", value: "has-replied", weight: 0.05 },
    { name: "system-category", value: "untagged", weight: 0.15 },
  ]);
  assert.ok(high >= 0.7, `direct+deadline+questions should be high, got ${high}`);
});

test("computePriorityScore: bulk system category drops score", () => {
  const bulk = computePriorityScore([
    { name: "sender", value: "automated", weight: 0.3 },
    { name: "questions", value: "none", weight: 0.2 },
    { name: "deadline", value: "none", weight: 0.25 },
    { name: "direct", value: "bcc-or-list", weight: 0.15 },
    { name: "reply-history", value: "no-history", weight: 0.05 },
    { name: "system-category", value: "通知", weight: 0.15 },
  ]);
  assert.ok(bulk < 0.35, `bulk category should produce low score, got ${bulk}`);
});

test("computePriorityScore: newsletter SystemCategoryId drops score", () => {
  const newsletter = computePriorityScore([
    { name: "sender", value: "newsletter", weight: 0.3 },
    { name: "questions", value: "none", weight: 0.2 },
    { name: "deadline", value: "none", weight: 0.25 },
    { name: "direct", value: "bcc-or-list", weight: 0.15 },
    { name: "reply-history", value: "no-history", weight: 0.05 },
    { name: "system-category", value: "newsletter", weight: 0.15 },
  ]);
  assert.ok(newsletter < 0.35, `newsletter category should produce low score, got ${newsletter}`);
});

test("computePriorityScore: action_required SystemCategoryId boosts score", () => {
  const action = computePriorityScore([
    { name: "sender", value: "personal", weight: 0.3 },
    { name: "questions", value: "present", weight: 0.2 },
    { name: "deadline", value: "none", weight: 0.25 },
    { name: "direct", value: "direct", weight: 0.15 },
    { name: "reply-history", value: "no-history", weight: 0.05 },
    { name: "system-category", value: "action_required", weight: 0.15 },
  ]);
  assert.ok(action >= 0.5, `action_required should boost score, got ${action}`);
});

test("computePriorityScore: score is clamped to [0, 1]", () => {
  // Extreme positive signals
  const high = computePriorityScore([
    { name: "sender", value: "personal", weight: 0.3 },
    { name: "questions", value: "many", weight: 0.2 },
    { name: "deadline", value: "present", weight: 0.25 },
    { name: "direct", value: "direct", weight: 0.15 },
    { name: "reply-history", value: "has-replied", weight: 0.05 },
    { name: "system-category", value: "action_required", weight: 0.15 },
  ]);
  assert.ok(high <= 1, `score should not exceed 1, got ${high}`);
});

// ── deriveLevel tests ─────────────────────────────────────────────

test("deriveLevel: score < 0.35 = low", () => {
  assert.equal(deriveLevel(0.1), "low");
  assert.equal(deriveLevel(0.34), "low");
  assert.equal(deriveLevel(0.0), "low");
});

test("deriveLevel: 0.35 <= score < 0.7 = normal", () => {
  assert.equal(deriveLevel(0.35), "normal");
  assert.equal(deriveLevel(0.5), "normal");
  assert.equal(deriveLevel(0.69), "normal");
});

test("deriveLevel: score >= 0.7 = high", () => {
  assert.equal(deriveLevel(0.7), "high");
  assert.equal(deriveLevel(1.0), "high");
});

// ── deriveReplyRequired tests ─────────────────────────────────────

test("deriveReplyRequired: shouldReply=false always returns false", () => {
  const signals: PrioritySignal[] = [
    { name: "deadline", value: "present", weight: 0.25 },
    { name: "direct", value: "direct", weight: 0.15 },
  ];
  assert.equal(deriveReplyRequired(false, "high", signals), false);
});

test("deriveReplyRequired: shouldReply=true + low level = false", () => {
  const signals: PrioritySignal[] = [];
  assert.equal(deriveReplyRequired(true, "low", signals), false);
});

test("deriveReplyRequired: shouldReply=true + normal level = true", () => {
  const signals: PrioritySignal[] = [];
  assert.equal(deriveReplyRequired(true, "normal", signals), true);
});

test("deriveReplyRequired: shouldReply=true + high level = true", () => {
  const signals: PrioritySignal[] = [];
  assert.equal(deriveReplyRequired(true, "high", signals), true);
});

test("deriveReplyRequired: direct+deadline always required", () => {
  const signals: PrioritySignal[] = [
    { name: "deadline", value: "present", weight: 0.25 },
    { name: "direct", value: "direct", weight: 0.15 },
  ];
  assert.equal(deriveReplyRequired(true, "high", signals), true);
});

// ── extractDeadlineDate tests ─────────────────────────────────────

test("extractDeadlineDate: extracts date with 'by' keyword", () => {
  const result = extractDeadlineDate({
    bodyText: "Please respond by 2026-05-15.",
  });
  assert.equal(result, "2026-05-15");
});

test("extractDeadlineDate: extracts date with 'due' keyword", () => {
  const result = extractDeadlineDate({
    subject: "Report due 2026/06/30",
  });
  assert.equal(result, "2026-06-30");
});

test("extractDeadlineDate: no deadline returns undefined", () => {
  const result = extractDeadlineDate({
    bodyText: "Just an FYI, no action needed.",
  });
  assert.equal(result, undefined);
});

test("extractDeadlineDate: date without deadline keyword returns undefined", () => {
  const result = extractDeadlineDate({
    bodyText: "The event is on 2026-05-15.",
  });
  assert.equal(result, undefined);
});

// ── Determinism tests ─────────────────────────────────────────────

test("extractSignals is deterministic: same input = same output", () => {
  const input: SignalExtractionInput = {
    subject: "Review request",
    from: { email: "boss@company.com", name: "Boss" },
    to: [{ email: "me@company.com" }],
    bodyText: "Can you review this document?",
    userEmail: "me@company.com",
  };
  const first = extractSignals(input);
  const second = extractSignals(input);
  assert.deepEqual(first, second);
});

test("computePriorityScore is deterministic: same signals = same score", () => {
  const signals: PrioritySignal[] = [
    { name: "sender", value: "personal", weight: 0.3 },
    { name: "questions", value: "present", weight: 0.2 },
    { name: "deadline", value: "present", weight: 0.25 },
    { name: "direct", value: "direct", weight: 0.15 },
    { name: "reply-history", value: "no-history", weight: 0.05 },
    { name: "system-category", value: "untagged", weight: 0.15 },
  ];
  const first = computePriorityScore(signals);
  const second = computePriorityScore(signals);
  assert.equal(first, second);
});

// ── Bulk/newsletter default low priority ──────────────────────────

test("newsletter with no direct request defaults to low priority", () => {
  const input: SignalExtractionInput = {
    from: { email: "digest@substack.com" },
    subject: "Weekly roundup",
    bodyText: "Here are the top stories this week...",
    tags: ["发布"],
  };
  const signals = extractSignals(input);
  const score = computePriorityScore(signals);
  const level = deriveLevel(score);
  assert.equal(level, "low");
});

test("marketing email with no direct request defaults to low priority", () => {
  const input: SignalExtractionInput = {
    from: { email: "promo@hubspot.com" },
    subject: "Special offer just for you!",
    bodyText: "Get 50% off this weekend only.",
    classificationCategoryId: "marketing",
  };
  const signals = extractSignals(input);
  const score = computePriorityScore(signals);
  const level = deriveLevel(score);
  assert.equal(level, "low");
});

test("notification email defaults to low priority", () => {
  const input: SignalExtractionInput = {
    from: { email: "noreply@github.com" },
    subject: "[GitHub] Build #123 succeeded",
    bodyText: "Your workflow run completed successfully.",
    classificationCategoryId: "notification",
  };
  const signals = extractSignals(input);
  const score = computePriorityScore(signals);
  const level = deriveLevel(score);
  assert.equal(level, "low");
});

// ── Direct deadline = high priority ───────────────────────────────

test("direct request with deadline becomes high priority", () => {
  const input: SignalExtractionInput = {
    from: { email: "boss@company.com", name: "Boss" },
    to: [{ email: "me@company.com" }],
    subject: "Urgent: Q3 plans due Friday",
    bodyText: "Can you prepare the Q3 deck by Friday?",
    userEmail: "me@company.com",
  };
  const signals = extractSignals(input);
  const score = computePriorityScore(signals);
  const level = deriveLevel(score);
  assert.equal(level, "high");
  const replyRequired = deriveReplyRequired(true, level, signals);
  assert.equal(replyRequired, true);
});

test("direct request with explicit deadline date extracts deadline", () => {
  const input: SignalExtractionInput = {
    from: { email: "pm@company.com" },
    to: [{ email: "me@company.com" }],
    subject: "Deliverable due",
    bodyText: "Please submit by 2026-06-15.",
    userEmail: "me@company.com",
  };
  const deadline = extractDeadlineDate(input);
  assert.equal(deadline, "2026-06-15");
  const signals = extractSignals(input);
  const score = computePriorityScore(signals);
  const level = deriveLevel(score);
  assert.equal(level, "high");
});

// ── CC-only message is lower priority than direct ─────────────────

test("CC-only message with questions is normal priority", () => {
  const input: SignalExtractionInput = {
    from: { email: "colleague@company.com" },
    to: [{ email: "team@company.com" }],
    cc: [{ email: "me@company.com" }],
    subject: "Team discussion",
    bodyText: "What do you all think?",
    userEmail: "me@company.com",
  };
  const signals = extractSignals(input);
  const score = computePriorityScore(signals);
  const level = deriveLevel(score);
  // CC + no deadline should not be high
  assert.ok(level !== "high", `CC-only should not be high, got ${level}`);
});

// ── Bulk category constants test ──────────────────────────────────

test("BULK_CATEGORY_SIGNALS contains expected categories", () => {
  assert.ok(BULK_CATEGORY_SIGNALS.includes("通知"));
  assert.ok(BULK_CATEGORY_SIGNALS.includes("发布"));
  assert.ok(BULK_CATEGORY_SIGNALS.includes("日报"));
});

test("NEWSLETTER_DOMAINS contains known domains", () => {
  assert.ok(NEWSLETTER_DOMAINS.has("mailchimp.com"));
  assert.ok(NEWSLETTER_DOMAINS.has("substack.com"));
  assert.ok(NEWSLETTER_DOMAINS.has("hubspot.com"));
});
