import assert from "node:assert/strict";
import test from "node:test";
import { AgentExecutionProgressTracker } from "./AgentExecutionProgress.js";

test("tracks distinct mail ids, cursors, workflow state, artifacts, and pending actions as progress", () => {
  const tracker = new AgentExecutionProgressTracker();
  const outputs = [
    ["search_mail", {}, { messages: [{ id: "mail-1" }], nextCursor: "page-2" }],
    ["read_mail_source", { id: "mail-1" }, { ok: true, message: { id: "mail-1", bodyText: "secret" } }],
    ["create_execution_pipeline", {}, { ok: true, taskId: "task-1", draftId: "draft-1", phase: "preview", revision: 1 }],
    ["review_pipeline_preview", {}, { ok: true, artifactId: "artifact-1", version: 2 }],
    ["propose_action", {}, { ok: true, pendingActionId: "pending-1" }],
  ] as const;

  for (const [tool, input, output] of outputs) {
    assert.equal(tracker.beforeToolCall(tool, input), undefined);
    const assessment = tracker.afterToolCall(tool, input, output, false);
    assert.equal(assessment.progressed, true);
    assert.equal(assessment.consecutiveNoProgress, 0);
  }
});

test("stops exact repeated calls before executing the disallowed call", () => {
  const tracker = new AgentExecutionProgressTracker({
    maxExactRepeatCalls: 2,
  });
  assert.equal(tracker.beforeToolCall("probe", { value: "same" }), undefined);
  assert.equal(tracker.beforeToolCall("probe", { value: "same" }), undefined);
  assert.equal(
    tracker.beforeToolCall("probe", { value: "same" })?.kind,
    "exact_repeat",
  );
  assert.equal(tracker.snapshot().totalToolCalls, 2);
});

test("stops varied calls that repeatedly fail or return equivalent empty results", () => {
  const tracker = new AgentExecutionProgressTracker({
    maxConsecutiveNoProgress: 4,
  });
  const assessments = [
    tracker.afterToolCall("probe", { page: 1 }, { ok: false }, true),
    tracker.afterToolCall("probe", { page: 2 }, { ok: false }, true),
    tracker.afterToolCall("search_mail", { q: "a" }, { count: 0, messages: [] }, false),
    tracker.afterToolCall("search_mail", { q: "b" }, { count: 0, messages: [] }, false),
  ];
  assert.equal(assessments.at(-1)?.guard?.kind, "no_progress");
});

test("argument variation does not count as progress when the result is equivalent", () => {
  const tracker = new AgentExecutionProgressTracker({
    maxConsecutiveNoProgress: 3,
  });
  const first = tracker.afterToolCall(
    "probe",
    { query: "one" },
    { ok: true, value: "same" },
    false,
  );
  const second = tracker.afterToolCall(
    "probe",
    { query: "two" },
    { ok: true, value: "same" },
    false,
  );
  const third = tracker.afterToolCall(
    "probe",
    { query: "three" },
    { ok: true, value: "same" },
    false,
  );
  const fourth = tracker.afterToolCall(
    "probe",
    { query: "four" },
    { ok: true, value: "same" },
    false,
  );

  assert.equal(first.progressed, true);
  assert.equal(second.progressed, false);
  assert.equal(third.progressed, false);
  assert.equal(fourth.guard?.kind, "no_progress");
});

test("uses an emergency ceiling independently from progress", () => {
  const tracker = new AgentExecutionProgressTracker({
    maxEmergencyToolCalls: 2,
  });
  assert.equal(tracker.beforeToolCall("probe", { value: 1 }), undefined);
  tracker.afterToolCall("probe", { value: 1 }, { ok: true, value: 1 }, false);
  assert.equal(tracker.beforeToolCall("probe", { value: 2 }), undefined);
  tracker.afterToolCall("probe", { value: 2 }, { ok: true, value: 2 }, false);
  assert.equal(
    tracker.beforeToolCall("probe", { value: 3 })?.kind,
    "emergency_tool_calls",
  );
});

test("privacy projection ignores mail body changes when assessing fallback progress", () => {
  const tracker = new AgentExecutionProgressTracker({
    maxConsecutiveNoProgress: 2,
  });
  const first = tracker.afterToolCall(
    "probe",
    {},
    { ok: true, bodyText: "FIRST-SECRET" },
    false,
  );
  const second = tracker.afterToolCall(
    "probe",
    {},
    { ok: true, bodyText: "SECOND-SECRET" },
    false,
  );
  assert.equal(first.progressed, true);
  assert.equal(second.progressed, false);
  assert.equal(second.guard?.kind, undefined);
});
