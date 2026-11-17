import assert from "node:assert/strict";
import { test } from "node:test";

import type { LlmClient, LlmRequest, LlmResponse } from "../../../ai/LlmClient.js";
import type {
  AgentPlanner,
  PlannerDecision,
  PlannerStepInput,
} from "../../../agent/PiAgentRuntime.js";
import { runAgentRuntimeEval } from "./AgentRuntimeHarness.js";
import { piPlannerScenarios } from "../corpus/plannerScenarios.js";

const dummyLlm: LlmClient = {
  async generate(_input: LlmRequest): Promise<LlmResponse> {
    throw new Error("planner LLM should be replaced by fake planner");
  },
};

function judgeLlm(score: number): LlmClient {
  return {
    async generate(_input: LlmRequest): Promise<LlmResponse> {
      return {
        text: JSON.stringify({ score, reason: "good transcript" }),
        finishReason: "stop",
      };
    },
  };
}

function scriptedPlanner(decisions: PlannerDecision[]): AgentPlanner {
  let i = 0;
  return {
    async step(_input: PlannerStepInput): Promise<PlannerDecision> {
      const d = decisions[i] ?? { kind: "error", message: "exhausted" };
      i += 1;
      return d;
    },
  };
}

test("runAgentRuntimeEval evaluates agent-runtime scenarios into PromptEvalReport", async () => {
  const scenario = piPlannerScenarios[1]!;
  const report = await runAgentRuntimeEval({
    feature: "piPlanner",
    versionLabel: "test-agent",
    llm: dummyLlm,
    judge: judgeLlm(3),
    model: "fake",
    judgeModel: "fake-judge",
    endpoint: "fake://executor",
    scenarios: [scenario],
    concurrency: 1,
    plannerFactory: () =>
      scriptedPlanner([{ kind: "final", text: "I can search and summarize mail." }]),
  });

  assert.equal(report.feature, "piPlanner");
  assert.equal(report.aggregate.sampleCount, 1);
  assert.equal(report.perSample[0]!.sampleId, scenario.id);
  assert.equal(report.perSample[0]!.format, 3);
  assert.equal(report.perSample[0]!.quality, 3);
});

