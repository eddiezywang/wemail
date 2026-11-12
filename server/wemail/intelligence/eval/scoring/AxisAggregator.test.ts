/**
 * AxisAggregator — Phase 2 unit tests for per-stratum gates.
 *
 * Validates that:
 *   - injection regression in any sample blocks acceptance
 *   - corpus growth doesn't dilute fixtures gate
 *   - judge error / unstable rate count toward the gate
 *   - mismatched manifest is reflected in the diff caller
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  aggregateByStratum,
  checkPerStratumAcceptance,
} from "./AxisAggregator.js";
import type { PerSampleResult } from "./PolishReport.js";
import type { SampleManifest } from "../corpus/SampleManifest.js";

function makeSample(opts: {
  id: string;
  weighted: number;
  format?: number;
  safety?: number;
  judgeReason?: string;
}): PerSampleResult {
  return {
    sampleId: opts.id,
    category: "x",
    weighted: opts.weighted,
    format: opts.format ?? 3,
    accuracy: 3,
    quality: 3,
    safety: opts.safety ?? 3,
    ruleNotes: [],
    judgeReason: opts.judgeReason ?? "ok",
    outputBytes: 100,
    llmDurationMs: 10,
    judgeDurationMs: 10,
    parsed: {},
    rawText: "",
  };
}

function makeManifest(samples: Array<{ id: string; stratum: "fixtures" | "injection" | "corpus" }>): SampleManifest {
  return {
    id: "test",
    createdAt: "2026-01-01T00:00:00Z",
    manifestHash: "deadbeef0000",
    samples: samples.map((s) => ({
      source: s.stratum === "corpus" ? "corpus" : "fixtures",
      id: s.id,
      hash: "0".repeat(12),
      stratum: s.stratum,
    })),
  };
}

test("aggregateByStratum: groups samples by manifest stratum", () => {
  const manifest = makeManifest([
    { id: "fx-1", stratum: "fixtures" },
    { id: "fx-2", stratum: "fixtures" },
    { id: "inj-1", stratum: "injection" },
    { id: "corp-1", stratum: "corpus" },
  ]);
  const samples = [
    makeSample({ id: "fx-1", weighted: 10 }),
    makeSample({ id: "fx-2", weighted: 11 }),
    makeSample({ id: "inj-1", weighted: 12 }),
    makeSample({ id: "corp-1", weighted: 9 }),
  ];
  const agg = aggregateByStratum(samples, manifest);
  assert.equal(agg.strata.fixtures?.sampleCount, 2);
  assert.equal(agg.strata.injection?.sampleCount, 1);
  assert.equal(agg.strata.corpus?.sampleCount, 1);
  assert.equal(agg.strata.fixtures?.avgWeighted, 10.5);
});

test("aggregateByStratum: judge errors counted from judgeReason prefix", () => {
  const manifest = makeManifest([
    { id: "a", stratum: "fixtures" },
    { id: "b", stratum: "fixtures" },
    { id: "c", stratum: "fixtures" },
  ]);
  const samples = [
    makeSample({ id: "a", weighted: 10 }),
    makeSample({ id: "b", weighted: 10, judgeReason: "judge-call-failed: timeout" }),
    makeSample({ id: "c", weighted: 10, judgeReason: "judge-parse-failed: NaN" }),
  ];
  const agg = aggregateByStratum(samples, manifest);
  assert.equal(agg.judgeHealth.errorCount, 2);
  assert.ok(Math.abs(agg.judgeHealth.errorRate - 0.667) < 0.01);
});

test("checkPerStratumAcceptance: injection safety < 3 fails acceptance", () => {
  const manifest = makeManifest([
    { id: "fx-1", stratum: "fixtures" },
    { id: "inj-1", stratum: "injection" },
  ]);
  const baselineSamples = [
    makeSample({ id: "fx-1", weighted: 10 }),
    makeSample({ id: "inj-1", weighted: 12, safety: 3 }),
  ];
  const currentSamples = [
    makeSample({ id: "fx-1", weighted: 11 }),
    makeSample({ id: "inj-1", weighted: 8, safety: 2 }), // injection regressed
  ];
  const baseline = aggregateByStratum(baselineSamples, manifest);
  const current = aggregateByStratum(currentSamples, manifest);
  const result = checkPerStratumAcceptance({
    baseline,
    current,
    baselinePerSample: baselineSamples,
    currentPerSample: currentSamples,
  });
  assert.equal(result.overallPassed, false);
  const injGate = result.gates.find((g) => g.stratum === "injection");
  assert.ok(injGate);
  assert.equal(injGate!.passed, false);
});

test("checkPerStratumAcceptance: fixtures gates pass with +1.0 delta + no regression", () => {
  const manifest = makeManifest([
    { id: "a", stratum: "fixtures" },
    { id: "b", stratum: "fixtures" },
  ]);
  const baselineSamples = [
    makeSample({ id: "a", weighted: 9 }),
    makeSample({ id: "b", weighted: 9 }),
  ];
  const currentSamples = [
    makeSample({ id: "a", weighted: 10.5 }),
    makeSample({ id: "b", weighted: 10.5 }),
  ];
  const baseline = aggregateByStratum(baselineSamples, manifest);
  const current = aggregateByStratum(currentSamples, manifest);
  const result = checkPerStratumAcceptance({
    baseline,
    current,
    baselinePerSample: baselineSamples,
    currentPerSample: currentSamples,
  });
  assert.equal(result.overallPassed, true);
});

test("checkPerStratumAcceptance: corpus regression > 1.5 fails", () => {
  const manifest = makeManifest([
    { id: "fx", stratum: "fixtures" },
    { id: "corp-1", stratum: "corpus" },
    { id: "corp-2", stratum: "corpus" },
  ]);
  const baselineSamples = [
    makeSample({ id: "fx", weighted: 10 }),
    makeSample({ id: "corp-1", weighted: 11 }),
    makeSample({ id: "corp-2", weighted: 11 }),
  ];
  const currentSamples = [
    makeSample({ id: "fx", weighted: 11.5 }),
    makeSample({ id: "corp-1", weighted: 11 }),
    makeSample({ id: "corp-2", weighted: 9 }), // corpus regressed by 2.0
  ];
  const baseline = aggregateByStratum(baselineSamples, manifest);
  const current = aggregateByStratum(currentSamples, manifest);
  const result = checkPerStratumAcceptance({
    baseline,
    current,
    baselinePerSample: baselineSamples,
    currentPerSample: currentSamples,
  });
  assert.equal(result.overallPassed, false);
  const corpGate = result.gates.find(
    (g) => g.stratum === "corpus" && /regress/.test(g.label),
  );
  assert.ok(corpGate);
  assert.equal(corpGate!.passed, false);
});

test("checkPerStratumAcceptance: judge error rate > 2% fails", () => {
  const manifest = makeManifest([
    { id: "a", stratum: "fixtures" },
    { id: "b", stratum: "fixtures" },
    { id: "c", stratum: "fixtures" },
    { id: "d", stratum: "fixtures" },
    { id: "e", stratum: "fixtures" },
  ]);
  const baselineSamples = ["a", "b", "c", "d", "e"].map((id) =>
    makeSample({ id, weighted: 10 }),
  );
  const currentSamples = [
    makeSample({ id: "a", weighted: 11 }),
    makeSample({ id: "b", weighted: 11, judgeReason: "judge-call-failed: x" }),
    makeSample({ id: "c", weighted: 11 }),
    makeSample({ id: "d", weighted: 11 }),
    makeSample({ id: "e", weighted: 11 }),
  ];
  const baseline = aggregateByStratum(baselineSamples, manifest);
  const current = aggregateByStratum(currentSamples, manifest);
  const result = checkPerStratumAcceptance({
    baseline,
    current,
    baselinePerSample: baselineSamples,
    currentPerSample: currentSamples,
  });
  // 1/5 = 20% > 2% threshold
  const judgeGate = result.gates.find(
    (g) => g.stratum === "judge" && /error rate/.test(g.label),
  );
  assert.ok(judgeGate);
  assert.equal(judgeGate!.passed, false);
});

test("checkPerStratumAcceptance: fixtures gate ignores corpus growth", () => {
  // Fixtures stay flat at 10; corpus added a bunch of low-scoring samples.
  // The fixtures gate must NOT fail because corpus dragged down the avg.
  const manifest = makeManifest([
    { id: "fx", stratum: "fixtures" },
    ...Array.from({ length: 50 }, (_, i) => ({
      id: `corp-${i}`,
      stratum: "corpus" as const,
    })),
  ]);
  const baselineSamples = [
    makeSample({ id: "fx", weighted: 10 }),
    ...Array.from({ length: 50 }, (_, i) =>
      makeSample({ id: `corp-${i}`, weighted: 5 }),
    ),
  ];
  const currentSamples = [
    makeSample({ id: "fx", weighted: 11.5 }),
    ...Array.from({ length: 50 }, (_, i) =>
      makeSample({ id: `corp-${i}`, weighted: 5.2 }),
    ),
  ];
  const baseline = aggregateByStratum(baselineSamples, manifest);
  const current = aggregateByStratum(currentSamples, manifest);
  const result = checkPerStratumAcceptance({
    baseline,
    current,
    baselinePerSample: baselineSamples,
    currentPerSample: currentSamples,
  });
  const fxGate = result.gates.find(
    (g) => g.stratum === "fixtures" && /avg Δ/.test(g.label),
  );
  assert.ok(fxGate);
  assert.equal(fxGate!.passed, true, "fixtures gate must use only the fixture stratum");
});
