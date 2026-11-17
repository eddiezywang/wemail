import type { LlmClient } from "../../../ai/LlmClient.js";
import type { AgentRuntimeEvalSpec, AgentScenarioEntry } from "../AgentRuntimeEvalSpec.js";
import { FeatureRegistry } from "../FeatureRegistry.js";
import { piPlannerScenarios, curatorSafetyScenarios } from "../corpus/plannerScenarios.js";
import { DEFAULT_AXIS_WEIGHTS, type AxisWeights } from "../FeatureSpec.js";
import { judgeWithRubric } from "../scoring/LlmJudge.js";
import {
  aggregate,
  type PerSampleResult,
  type PromptEvalReport,
} from "../scoring/PolishReport.js";
import type { PolishableFeature } from "../scoring/RuleScorer.js";
import {
  runAgentScenario,
  type RunAgentOptions,
} from "./AgentRuntimeRunner.js";

const DEFAULT_CONCURRENCY = 2;

export interface AgentRuntimeEvalOptions {
  feature: string;
  versionLabel: string;
  llm: LlmClient;
  judge: LlmClient;
  model: string;
  judgeModel: string;
  endpoint: string;
  scenarios?: ReadonlyArray<AgentScenarioEntry>;
  concurrency?: number;
  registry?: FeatureRegistry;
  plannerFactory?: RunAgentOptions["plannerFactory"];
  judgeIdentity?: { model: string; baseUrl: string; selfJudge: boolean };
  corpusSafety?: {
    externalEndpoint: boolean;
    externalCorpusWaived: boolean;
    residualScanRequired: boolean;
  };
  onProgress?: (info: {
    done: number;
    total: number;
    sampleId: string;
    weighted: number;
  }) => void;
}

export async function runAgentRuntimeEval(
  opts: AgentRuntimeEvalOptions,
): Promise<PromptEvalReport> {
  const registry = opts.registry ?? (await FeatureRegistry.loadDefault());
  const spec = registry.get(opts.feature);
  if (spec.kind !== "agent-runtime") {
    throw new Error(
      `runAgentRuntimeEval(): feature '${opts.feature}' is kind=${spec.kind}; single-turn specs go through PromptEvalHarness`,
    );
  }

  const scenarios = [
    ...(opts.scenarios ?? defaultScenariosForFeature(spec.id)),
  ];
  const startedAt = new Date().toISOString();
  const results: PerSampleResult[] = new Array(scenarios.length);
  const concurrency = Math.max(1, opts.concurrency ?? DEFAULT_CONCURRENCY);
  let cursor = 0;
  let done = 0;

  const workers = Array.from(
    { length: Math.min(concurrency, scenarios.length) },
    () =>
      (async () => {
        while (true) {
          const i = cursor;
          if (i >= scenarios.length) return;
          cursor += 1;
          const scenario = scenarios[i]!;
          const result = await evaluateAgentScenario(opts, spec, scenario);
          results[i] = result;
          done += 1;
          opts.onProgress?.({
            done,
            total: scenarios.length,
            sampleId: scenario.id,
            weighted: result.weighted,
          });
        }
      })(),
  );
  await Promise.all(workers);

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
    judgeIdentity: opts.judgeIdentity,
    corpusSafety: opts.corpusSafety,
  });
}

async function evaluateAgentScenario(
  opts: AgentRuntimeEvalOptions,
  spec: AgentRuntimeEvalSpec,
  inputScenario: AgentScenarioEntry,
): Promise<PerSampleResult> {
  const scenario = spec.buildScenario(inputScenario);
  const runStart = Date.now();
  const run = await runAgentScenario({
    llm: opts.llm,
    model: opts.model,
    systemPrompt: spec.systemPrompt,
    scenario,
    plannerFactory: opts.plannerFactory,
  });
  const llmDurationMs = Date.now() - runStart;

  const fmt = spec.scoring.format(run.events);
  const acc = spec.scoring.accuracy(run.events, scenario);
  const safety = spec.scoring.safety(run.events, scenario);

  const judgeStart = Date.now();
  const quality = await judgeWithRubric({
    llm: opts.judge,
    model: opts.judgeModel,
    rubric: spec.scoring.qualityRubric,
    feature: spec.id,
    emailContext: renderScenarioContext(scenario),
    output: run.events,
  });
  const judgeDurationMs = Date.now() - judgeStart;

  const weighted = weightedAgentTotal(
    {
      format: fmt.score,
      accuracy: acc.score,
      quality: quality.score,
      safety: safety.score,
    },
    spec.weights,
  );
  const rawText = JSON.stringify(run.events);
  return {
    sampleId: scenario.id,
    category: scenario.category ?? "agent-runtime",
    weighted,
    format: fmt.score,
    accuracy: acc.score,
    quality: quality.score,
    safety: safety.score,
    ruleNotes: [
      ...fmt.notes.map((n) => `fmt:${n}`),
      ...acc.notes.map((n) => `acc:${n}`),
      ...safety.notes.map((n) => `saf:${n}`),
    ],
    judgeReason: quality.reason,
    judgeError: quality.judgeError,
    judgeUnstable: quality.unstable,
    judgeAttempts: quality.attempts,
    outputBytes: rawText.length,
    llmDurationMs,
    judgeDurationMs,
    parsed: run.events,
    rawText,
  };
}

function defaultScenariosForFeature(feature: string): ReadonlyArray<AgentScenarioEntry> {
  if (feature === "piPlanner") return piPlannerScenarios;
  if (feature === "curatorSafety") return curatorSafetyScenarios;
  throw new Error(`runAgentRuntimeEval(): no default scenarios for '${feature}'`);
}

function renderScenarioContext(scenario: AgentScenarioEntry): string {
  const messages = scenario.initialMessages
    .map((message) => `${message.role}: ${message.content}`)
    .join("\n");
  const expected = JSON.stringify(scenario.expected);
  return [
    `Scenario: ${scenario.id}`,
    scenario.description,
    "",
    "Messages:",
    messages || "(none)",
    "",
    `Expected: ${expected}`,
  ].join("\n");
}

function weightedAgentTotal(
  scores: { format: number; accuracy: number; quality: number; safety: number },
  customWeights?: Partial<AxisWeights>,
): number {
  const weights = { ...DEFAULT_AXIS_WEIGHTS, ...(customWeights ?? {}) };
  const raw =
    scores.format * weights.format +
    scores.accuracy * weights.accuracy +
    scores.quality * weights.quality +
    scores.safety * weights.safety;
  return Math.round(raw * 40) / 10;
}
