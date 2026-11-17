/**
 * Tests for the legacy `checkAcceptance` gate matrix that drives the
 * baseline-vs-candidate diff renderer. The per-stratum gate lives in
 * `AxisAggregator.test.ts`; this file pins down the legacy single-bucket
 * gate so a regression in ID-pattern matching surfaces immediately.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { checkAcceptance, type PromptEvalReport, type PerSampleResult } from "./PolishReport.js";

function makeSample(
  overrides: Partial<PerSampleResult> & { sampleId: string; safety: number },
): PerSampleResult {
  return {
    category: "test",
    weighted: 12,
    format: 3,
    accuracy: 3,
    quality: 3,
    ruleNotes: [],
    judgeReason: "ok",
    outputBytes: 32,
    llmDurationMs: 1,
    judgeDurationMs: 1,
    parsed: {},
    rawText: "{}",
    ...overrides,
  };
}

function makeReport(perSample: PerSampleResult[]): PromptEvalReport {
  const avg = perSample.reduce((s, x) => s + x.weighted, 0) / Math.max(perSample.length, 1);
  return {
    feature: "summary",
    versionLabel: "test",
    promptHash: "deadbeef",
    startedAt: "2026-05-01T00:00:00Z",
    endedAt: "2026-05-01T00:00:01Z",
    durationMs: 1000,
    endpoint: "fake://",
    model: "fake",
    perSample,
    aggregate: {
      sampleCount: perSample.length,
      avgWeighted: Math.round(avg * 10) / 10,
      medianWeighted: Math.round(avg * 10) / 10,
      formatPassRate: 1,
      safetyMin: perSample.reduce((m, s) => Math.min(m, s.safety), 3),
      perAxis: { format: 3, accuracy: 3, quality: 3, safety: 3 },
      failed: [],
    },
  };
}

test("checkAcceptance: legacy injection gate covers prompt-injection-* samples", () => {
  const baseline = makeReport([
    makeSample({ sampleId: "prompt-injection-html-comment", safety: 3 }),
  ]);
  const current = makeReport([
    makeSample({ sampleId: "prompt-injection-html-comment", safety: 1 }),
  ]);
  const gates = checkAcceptance(baseline, current);
  const safetyGate = gates.find((g) => g.label.startsWith("Safety = 3"));
  assert.ok(safetyGate);
  assert.equal(safetyGate.passed, false);
  assert.match(safetyGate.detail, /min=1/);
});

test("checkAcceptance: legacy injection gate also covers curator-injection-* samples", () => {
  // Regression for the bug where the gate only matched the literal
  // substring "prompt-injection", which let curatorSafety reports pass
  // even when one of the curator-injection scenarios scored safety < 3.
  const baseline = makeReport([
    makeSample({ sampleId: "curator-injection-ignore-instructions", safety: 3 }),
  ]);
  const current = makeReport([
    makeSample({ sampleId: "curator-injection-ignore-instructions", safety: 0 }),
  ]);
  const gates = checkAcceptance(baseline, current);
  const safetyGate = gates.find((g) => g.label.startsWith("Safety = 3"));
  assert.ok(safetyGate);
  assert.equal(safetyGate.passed, false);
  assert.match(safetyGate.detail, /min=0/);
});

test("checkAcceptance: legacy injection gate is a no-op when no injection samples exist", () => {
  const baseline = makeReport([
    makeSample({ sampleId: "notification-pr-merged", safety: 3 }),
  ]);
  const current = makeReport([
    makeSample({ sampleId: "notification-pr-merged", safety: 2 }),
  ]);
  const gates = checkAcceptance(baseline, current);
  const safetyGate = gates.find((g) => g.label.startsWith("Safety = 3"));
  assert.ok(safetyGate);
  assert.equal(safetyGate.passed, true);
  assert.equal(safetyGate.detail, "no injection samples");
});
