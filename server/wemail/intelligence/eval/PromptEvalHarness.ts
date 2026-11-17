/**
 * PromptEvalHarness — drives one polish round for one feature.
 *
 *   for each sample in <corpus>:
 *     prompt = spec.buildUserMessage(sample)
 *     output = LLM.generate({ system: spec.systemPrompt, jsonSchema, ... })
 *     parsed = spec.parseOutput(raw)
 *     ruleScores  = spec.scoring.format/accuracy/safety
 *     judgeScore  = LlmJudge.judgeQuality(...)
 *     weighted    = AXIS_WEIGHTS · scores
 *
 *   aggregate per-sample → PromptEvalReport (PolishReport)
 *
 * Phase 1: dispatches via FeatureRegistry instead of an internal
 * switch. Per-stratum acceptance, judge upgrades, and AgentRuntime
 * support land in Phase 2/3/6.
 */

import type { LlmClient } from "../../ai/LlmClient.js";
import type { MailSampleEntry } from "../../testing/mailSamples.js";

import type { AnyEvalSpec } from "./FeatureSpec.js";
import { FeatureRegistry } from "./FeatureRegistry.js";
import type { SingleTurnPromptSpec } from "./SingleTurnPromptSpec.js";
import type { SampleManifest } from "./corpus/SampleManifest.js";

import {
  weightedTotal,
  type PolishableFeature,
} from "./scoring/RuleScorer.js";
import { judgeQuality } from "./scoring/LlmJudge.js";
import {
  aggregate,
  type PerSampleResult,
  type PromptEvalReport,
} from "./scoring/PolishReport.js";

const LLM_TIMEOUT_MS = 60_000;
const LLM_TEMPERATURE = 0;
const DEFAULT_CONCURRENCY = 4;

export interface PromptEvalOptions {
  /** Spec id (e.g. "summary"); resolved through the registry. */
  feature: string;
  versionLabel: string;
  llm: LlmClient;
  judge: LlmClient;
  model: string;
  judgeModel: string;
  endpoint: string;
  samples: ReadonlyArray<MailSampleEntry>;
  concurrency?: number;
  /** Optional progress callback (per-sample completion). */
  onProgress?: (info: {
    done: number;
    total: number;
    sampleId: string;
    weighted: number;
  }) => void;
  /** Optional total run cap (ms) — wall-clock guard so a runaway eval can't stall. */
  totalTimeoutMs?: number;
  /**
   * Optional pre-built registry (lets callers register extra plugins
   * before the run). Defaults to a fresh `FeatureRegistry.loadDefault`
   * with the plugin loader disabled — tests don't depend on disk state.
   */
  registry?: FeatureRegistry;
  /**
   * Optional immutable sample manifest. When supplied, the harness
   * tags the report with the manifest id+hash and produces per-stratum
   * aggregation. Comparison reports require matching manifests.
   */
  manifest?: SampleManifest;
  /**
   * Optional judge identity stamp recorded into the report. Phase 3
   * fills this from the judge LlmClient config; Phase 2 callers may
   * pass it explicitly to support manifest-aware diff gating.
   */
  judgeIdentity?: { model: string; baseUrl: string; selfJudge: boolean };
  corpusSafety?: {
    externalEndpoint: boolean;
    externalCorpusWaived: boolean;
    residualScanRequired: boolean;
  };
}

export async function runPromptEval(
  opts: PromptEvalOptions,
): Promise<PromptEvalReport> {
  // Default to a registry with plugins loaded so allowlisted external
  // specs resolve correctly. Tests that need an isolated registry
  // pass one in explicitly via `opts.registry`.
  const registry = opts.registry ?? (await FeatureRegistry.loadDefault());
  const spec = registry.get(opts.feature);
  if (spec.kind !== "single-turn") {
    throw new Error(
      `runPromptEval(): feature '${opts.feature}' is kind=${spec.kind}; agent-runtime specs go through AgentRuntimeRunner (Phase 6)`,
    );
  }

  const startedAt = new Date().toISOString();
  const startMs = Date.now();
  const totalCap = opts.totalTimeoutMs ?? 5 * 60 * 1000;

  const inputSampleCount = opts.samples.length;
  const filteredSamples = spec.sampleFilter
    ? opts.samples.filter(spec.sampleFilter)
    : opts.samples;
  const excludedSampleCount = inputSampleCount - filteredSamples.length;
  const queue = [...filteredSamples];
  const results: PerSampleResult[] = new Array(queue.length);
  const concurrency = Math.max(1, opts.concurrency ?? DEFAULT_CONCURRENCY);
  let cursor = 0;
  let done = 0;

  const workers = Array.from(
    { length: Math.min(concurrency, queue.length) },
    () =>
      (async () => {
        while (true) {
          if (Date.now() - startMs > totalCap) return;
          const i = cursor;
          if (i >= queue.length) return;
          cursor += 1;
          const sample = queue[i]!;
          const result = await evaluateOne(opts, spec, sample);
          results[i] = result;
          done += 1;
          opts.onProgress?.({
            done,
            total: queue.length,
            sampleId: sample.id,
            weighted: result.weighted,
          });
        }
      })(),
  );
  await Promise.all(workers);

  // Fill any holes from the timeout-truncated tail with zero scores.
  for (let i = 0; i < queue.length; i++) {
    if (!results[i]) {
      const sample = queue[i]!;
      results[i] = {
        sampleId: sample.id,
        category: sample.category,
        weighted: 0,
        format: 0,
        accuracy: 0,
        quality: 0,
        safety: 0,
        ruleNotes: ["run-timeout-truncated"],
        judgeReason: "(timed out)",
        outputBytes: 0,
        llmDurationMs: 0,
        judgeDurationMs: 0,
        parsed: null,
        rawText: "",
      };
    }
  }

  const endedAt = new Date().toISOString();
  return aggregate({
    feature: spec.id as PolishableFeature,
    versionLabel: opts.versionLabel,
    promptHash: spec.promptHash,
    startedAt,
    endedAt,
    endpoint: opts.endpoint,
    model: opts.model,
    perSample: results,
    manifest: opts.manifest,
    judgeIdentity: opts.judgeIdentity,
    sampleSelection: {
      inputSampleCount,
      excludedSampleCount,
    },
    corpusSafety: opts.corpusSafety,
  });
}

/* ----------------------- per-sample evaluation ----------------------- */

async function evaluateOne(
  opts: PromptEvalOptions,
  spec: SingleTurnPromptSpec,
  sample: MailSampleEntry,
): Promise<PerSampleResult> {
  const userMessage = spec.buildUserMessage(sample);

  const llmStart = Date.now();
  let rawText = "";
  let parsed: unknown = null;
  try {
    const res = await opts.llm.generate({
      model: opts.model,
      system: spec.systemPrompt,
      jsonSchema: spec.jsonSchema,
      temperature: LLM_TEMPERATURE,
      timeoutMs: LLM_TIMEOUT_MS,
      messages: [{ role: "user", content: userMessage }],
    });
    rawText = res.text ?? "";
    const parseResult = spec.parseOutput(rawText);
    parsed = parseResult.ok ? parseResult.data : null;
  } catch (err) {
    rawText = `[LLM ERROR] ${(err as Error).message}`;
    parsed = null;
  }
  const llmDurationMs = Date.now() - llmStart;

  const fmt = spec.scoring.format(parsed, rawText);
  const acc = parsed !== null
    ? spec.scoring.accuracy(parsed, sample)
    : { score: 0, notes: ["parsed-null-cannot-compare"] };
  const safety = spec.scoring.safety
    ? spec.scoring.safety(parsed, rawText, sample)
    : { score: 3, notes: [] };

  const judgeStart = Date.now();
  let judgeScore = 1.5;
  let judgeReason = "(skipped)";
  let judgeError = false;
  let judgeUnstable = false;
  let judgeAttempts: number[] | undefined;
  // Skip the judge call when format=0 (parse failed) — saves a round trip.
  if (fmt.score === 0) {
    judgeScore = 0;
    judgeReason = "auto-0: output unparseable";
  } else {
    const r = await judgeQuality({
      llm: opts.judge,
      model: opts.judgeModel,
      feature: spec.id as PolishableFeature,
      sample,
      output: parsed,
      rubric: spec.scoring.qualityRubric,
    });
    judgeScore = r.score;
    judgeReason = r.reason;
    judgeError = r.judgeError;
    judgeUnstable = r.unstable;
    judgeAttempts = r.attempts;
  }
  const judgeDurationMs = Date.now() - judgeStart;

  const ruleNotes = [
    ...fmt.notes.map((n) => `fmt:${n}`),
    ...acc.notes.map((n) => `acc:${n}`),
    ...safety.notes.map((n) => `saf:${n}`),
  ];

  const weighted = weightedTotal(
    {
      format: fmt.score,
      accuracy: acc.score,
      quality: judgeScore,
      safety: safety.score,
    },
    spec.weights,
  );

  return {
    sampleId: sample.id,
    category: String(sample.category),
    weighted,
    format: fmt.score,
    accuracy: acc.score,
    quality: judgeScore,
    safety: safety.score,
    ruleNotes,
    judgeReason,
    judgeError,
    judgeUnstable,
    judgeAttempts,
    outputBytes: rawText.length,
    llmDurationMs,
    judgeDurationMs,
    parsed,
    rawText,
  };
}

/** Re-export for callers that want to inspect the registry directly. */
export { FeatureRegistry };
export type { AnyEvalSpec };
