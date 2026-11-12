import assert from "node:assert/strict";
import { test } from "node:test";
import {
  replyDecisionShouldReplyEquals,
  summaryActionItemCountAtMost,
  summaryHasBulletsInRange,
  summaryUrgencyIs,
  tagsClassificationCategoryIs,
  tagsContainsName,
  todoCountAtLeast,
  todoCountEquals,
} from "./QualityAssertions.js";

// ---------------------------------------------------------------------------
// summaryHasBulletsInRange
// ---------------------------------------------------------------------------

test("summaryHasBulletsInRange returns null for in-range bullets", () => {
  const assertion = summaryHasBulletsInRange(1, 5);
  const result = {
    type: "summary",
    bullets: ["a", "b", "c"],
    actionItems: [],
    urgency: "low",
  };
  assert.equal(assertion(result), null);
});

test("summaryHasBulletsInRange returns violation for out-of-range bullets", () => {
  const assertion = summaryHasBulletsInRange(1, 5);
  const result = {
    type: "summary",
    bullets: ["a", "b", "c", "d", "e", "f", "g"],
    actionItems: [],
    urgency: "low",
  };
  const violation = assertion(result);
  assert.ok(violation !== null);
  assert.ok(violation.startsWith("bullets-out-of-range:"));
});

test("summaryHasBulletsInRange returns shape violation for non-summary", () => {
  const assertion = summaryHasBulletsInRange(1, 5);
  assert.equal(assertion(null), "not-an-object");
  assert.equal(assertion({ type: "tags" }), "not-a-summary-result");
  assert.equal(
    assertion({ type: "summary", bullets: "nope" }),
    "bullets-not-array",
  );
});

// ---------------------------------------------------------------------------
// summaryUrgencyIs
// ---------------------------------------------------------------------------

test("summaryUrgencyIs returns null for matching urgency", () => {
  const assertion = summaryUrgencyIs("high");
  const result = { type: "summary", bullets: [], actionItems: [], urgency: "high" };
  assert.equal(assertion(result), null);
});

test("summaryUrgencyIs returns violation for mismatched urgency", () => {
  const assertion = summaryUrgencyIs("high");
  const result = { type: "summary", bullets: [], actionItems: [], urgency: "low" };
  const violation = assertion(result);
  assert.ok(violation !== null);
  assert.ok(violation.startsWith("urgency-mismatch:"));
});

// ---------------------------------------------------------------------------
// summaryActionItemCountAtMost
// ---------------------------------------------------------------------------

test("summaryActionItemCountAtMost returns null when within cap", () => {
  const assertion = summaryActionItemCountAtMost(3);
  const result = {
    type: "summary",
    bullets: [],
    actionItems: ["one", "two"],
    urgency: "low",
  };
  assert.equal(assertion(result), null);
});

test("summaryActionItemCountAtMost returns violation when over cap", () => {
  const assertion = summaryActionItemCountAtMost(2);
  const result = {
    type: "summary",
    bullets: [],
    actionItems: ["one", "two", "three", "four"],
    urgency: "low",
  };
  const violation = assertion(result);
  assert.ok(violation !== null);
  assert.ok(violation.startsWith("action-items-over-cap:"));
});

// ---------------------------------------------------------------------------
// tagsContainsName
// ---------------------------------------------------------------------------

test("tagsContainsName returns null when tag is present", () => {
  const assertion = tagsContainsName("通知");
  const result = {
    type: "tags",
    tags: [
      { name: "通知", confidence: 0.9, source: "ai", tier: "auto" },
      { name: "日报", confidence: 0.5, source: "ai", tier: "suggested" },
    ],
  };
  assert.equal(assertion(result), null);
});

test("tagsContainsName returns violation when tag is missing", () => {
  const assertion = tagsContainsName("通知");
  const result = {
    type: "tags",
    tags: [{ name: "日报", confidence: 0.5, source: "ai", tier: "suggested" }],
  };
  const violation = assertion(result);
  assert.ok(violation !== null);
  assert.ok(violation.startsWith("missing-tag:"));
});

// ---------------------------------------------------------------------------
// tagsClassificationCategoryIs
// ---------------------------------------------------------------------------

test("tagsClassificationCategoryIs returns null when categoryId matches", () => {
  const assertion = tagsClassificationCategoryIs("notification");
  const result = {
    type: "tags",
    tags: [],
    classification: {
      categoryId: "notification",
      reason: "GitHub auto-mail",
      confidence: 0.9,
    },
  };
  assert.equal(assertion(result), null);
});

test("tagsClassificationCategoryIs returns violation when categoryId mismatches", () => {
  const assertion = tagsClassificationCategoryIs("notification");
  const result = {
    type: "tags",
    tags: [],
    classification: {
      categoryId: "marketing",
      reason: "promo blast",
      confidence: 0.6,
    },
  };
  const violation = assertion(result);
  assert.ok(violation !== null);
  assert.ok(violation.startsWith("classification-mismatch:"));
});

// ---------------------------------------------------------------------------
// replyDecisionShouldReplyEquals
// ---------------------------------------------------------------------------

test("replyDecisionShouldReplyEquals returns null when shouldReply matches", () => {
  const assertion = replyDecisionShouldReplyEquals(true);
  const result = {
    type: "replyDecision",
    shouldReply: true,
    reason: "human question",
    confidence: 0.9,
    priorityScore: 0.7,
    level: "high",
    replyRequired: true,
    signals: [],
  };
  assert.equal(assertion(result), null);
});

test("replyDecisionShouldReplyEquals returns violation when shouldReply mismatches", () => {
  const assertion = replyDecisionShouldReplyEquals(true);
  const result = {
    type: "replyDecision",
    shouldReply: false,
    reason: "automated",
    confidence: 0.9,
    priorityScore: 0.1,
    level: "low",
    replyRequired: false,
    signals: [],
  };
  const violation = assertion(result);
  assert.ok(violation !== null);
  assert.ok(violation.startsWith("should-reply-mismatch:"));
});

// ---------------------------------------------------------------------------
// todoCountEquals
// ---------------------------------------------------------------------------

test("todoCountEquals returns null on exact match", () => {
  const assertion = todoCountEquals(2);
  const result = {
    type: "todoExtraction",
    todos: [
      { title: "a", confidence: 0.5, status: "suggested" },
      { title: "b", confidence: 0.5, status: "suggested" },
    ],
  };
  assert.equal(assertion(result), null);
});

test("todoCountEquals returns violation on mismatch", () => {
  const assertion = todoCountEquals(2);
  const result = {
    type: "todoExtraction",
    todos: [{ title: "a", confidence: 0.5, status: "suggested" }],
  };
  const violation = assertion(result);
  assert.ok(violation !== null);
  assert.ok(violation.startsWith("todo-count-mismatch:"));
});

// ---------------------------------------------------------------------------
// todoCountAtLeast
// ---------------------------------------------------------------------------

test("todoCountAtLeast returns null when count meets the minimum", () => {
  const assertion = todoCountAtLeast(2);
  const result = {
    type: "todoExtraction",
    todos: [
      { title: "a", confidence: 0.5, status: "suggested" },
      { title: "b", confidence: 0.5, status: "suggested" },
      { title: "c", confidence: 0.5, status: "suggested" },
    ],
  };
  assert.equal(assertion(result), null);
});

test("todoCountAtLeast returns violation when count is below the minimum", () => {
  const assertion = todoCountAtLeast(3);
  const result = {
    type: "todoExtraction",
    todos: [{ title: "a", confidence: 0.5, status: "suggested" }],
  };
  const violation = assertion(result);
  assert.ok(violation !== null);
  assert.ok(violation.startsWith("todo-count-below-min:"));
});
