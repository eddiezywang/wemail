/**
 * Reusable assertion helpers for {@link EvalFixture.assertions}.
 *
 * Each exported factory returns a `(result: unknown) => string | null`
 * function. The runtime-style signature is required because eval fixtures
 * receive whatever the processor returned and must not assume a specific
 * shape — a malformed processor result must surface as a violation code,
 * not as a TypeError.
 *
 * Conventions:
 *   - On success the assertion returns `null`.
 *   - On failure it returns a short kebab-case violation code such as
 *     `"bullets-out-of-range:got-7-expected-1-to-5"`.
 *   - Unknown shapes return shape-level codes such as
 *     `"not-a-summary-result"` — callers can distinguish a real
 *     mismatch from a structurally-broken processor output.
 *
 * These helpers do NOT throw. The eval runner already wraps assertions
 * in a try/catch, but keeping them total simplifies callers that want
 * to compose them outside the runner (for example in unit tests).
 */

/**
 * Assertion function signature shared by all helpers in this module.
 * Compatible with the {@link EvalFixture.assertions} record value type.
 */
export type QualityAssertion = (result: unknown) => string | null;

function asObj(r: unknown): Record<string, unknown> | null {
  return typeof r === "object" && r !== null
    ? (r as Record<string, unknown>)
    : null;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

/**
 * Assert that a summary result has between `min` and `max` bullets
 * (inclusive). Returns a violation code when the result is not a
 * summary, when bullets is not an array, or when the count is outside
 * the requested range.
 */
export function summaryHasBulletsInRange(
  min: number,
  max: number,
): QualityAssertion {
  return (r: unknown): string | null => {
    const o = asObj(r);
    if (!o) return "not-an-object";
    if (o.type !== "summary") return "not-a-summary-result";
    const bullets = o.bullets;
    if (!Array.isArray(bullets)) return "bullets-not-array";
    if (bullets.length < min || bullets.length > max) {
      return `bullets-out-of-range:got-${bullets.length}-expected-${min}-to-${max}`;
    }
    return null;
  };
}

/**
 * Assert that a summary result has the expected urgency level.
 */
export function summaryUrgencyIs(
  expected: "low" | "medium" | "high",
): QualityAssertion {
  return (r: unknown): string | null => {
    const o = asObj(r);
    if (!o) return "not-an-object";
    if (o.type !== "summary") return "not-a-summary-result";
    const urgency = o.urgency;
    if (urgency !== expected) {
      return `urgency-mismatch:got-${String(urgency)}-expected-${expected}`;
    }
    return null;
  };
}

/**
 * Assert that a summary result's actionItems list has at most `max`
 * entries.
 */
export function summaryActionItemCountAtMost(max: number): QualityAssertion {
  return (r: unknown): string | null => {
    const o = asObj(r);
    if (!o) return "not-an-object";
    if (o.type !== "summary") return "not-a-summary-result";
    const items = o.actionItems;
    if (!isStringArray(items)) return "actionItems-not-string-array";
    if (items.length > max) {
      return `action-items-over-cap:got-${items.length}-max-${max}`;
    }
    return null;
  };
}

/**
 * Assert that a tag result includes at least one tag whose `name`
 * matches `expected` exactly.
 */
export function tagsContainsName(expected: string): QualityAssertion {
  return (r: unknown): string | null => {
    const o = asObj(r);
    if (!o) return "not-an-object";
    if (o.type !== "tags") return "not-a-tag-result";
    const tags = o.tags;
    if (!Array.isArray(tags)) return "tags-not-array";
    const found = tags.some((t) => {
      const tag = asObj(t);
      return tag !== null && tag.name === expected;
    });
    if (!found) {
      return `missing-tag:expected-${expected}`;
    }
    return null;
  };
}

/**
 * Assert that a tag result's `classification.categoryId` equals
 * `expected`. Treats a missing classification as a violation.
 */
export function tagsClassificationCategoryIs(
  expected: string,
): QualityAssertion {
  return (r: unknown): string | null => {
    const o = asObj(r);
    if (!o) return "not-an-object";
    if (o.type !== "tags") return "not-a-tag-result";
    const classification = asObj(o.classification);
    if (!classification) return "classification-missing";
    const got = classification.categoryId;
    if (got !== expected) {
      return `classification-mismatch:got-${String(got)}-expected-${expected}`;
    }
    return null;
  };
}

/**
 * Assert that a reply-decision result's `shouldReply` matches the
 * expected boolean.
 */
export function replyDecisionShouldReplyEquals(
  expected: boolean,
): QualityAssertion {
  return (r: unknown): string | null => {
    const o = asObj(r);
    if (!o) return "not-an-object";
    if (o.type !== "replyDecision") return "not-a-reply-decision-result";
    if (typeof o.shouldReply !== "boolean") {
      return "shouldReply-not-boolean";
    }
    if (o.shouldReply !== expected) {
      return `should-reply-mismatch:got-${o.shouldReply}-expected-${expected}`;
    }
    return null;
  };
}

/**
 * Assert that a todoExtraction result has exactly `expected` todos.
 */
export function todoCountEquals(expected: number): QualityAssertion {
  return (r: unknown): string | null => {
    const o = asObj(r);
    if (!o) return "not-an-object";
    if (o.type !== "todoExtraction") return "not-a-todo-extraction-result";
    const todos = o.todos;
    if (!Array.isArray(todos)) return "todos-not-array";
    if (todos.length !== expected) {
      return `todo-count-mismatch:got-${todos.length}-expected-${expected}`;
    }
    return null;
  };
}

/**
 * Assert that a todoExtraction result has at least `min` todos.
 */
export function todoCountAtLeast(min: number): QualityAssertion {
  return (r: unknown): string | null => {
    const o = asObj(r);
    if (!o) return "not-an-object";
    if (o.type !== "todoExtraction") return "not-a-todo-extraction-result";
    const todos = o.todos;
    if (!Array.isArray(todos)) return "todos-not-array";
    if (todos.length < min) {
      return `todo-count-below-min:got-${todos.length}-min-${min}`;
    }
    return null;
  };
}
