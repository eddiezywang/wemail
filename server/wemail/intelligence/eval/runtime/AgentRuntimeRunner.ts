/**
 * AgentRuntimeRunner — drives an AgentPlanner against a scripted scenario
 * and collects an event stream for spec scoring.
 *
 * Why drive the planner directly (rather than the full PiAgentRuntime
 * orchestrator)? Two reasons:
 *   1. The harness must inject mock tool results — the production
 *      orchestrator wires real tools that can write/read state.
 *   2. The planner is the prompt-under-test for piPlanner / curatorSafety;
 *      the tool-execution loop is mostly orthogonal to prompt quality.
 *
 * The runner keeps an explicit, evaluation-only planner-step budget so
 * scenarios that should hit budget-exceeded can be validated without
 * coupling prompt evaluation to production execution guards.
 */

import type { LlmClient } from "../../../ai/LlmClient.js";
import type {
  AgentPlanner,
  PlannerStepInput,
} from "../../../agent/PiAgentRuntime.js";
import { createDefaultPlanner } from "../../../agent/PiAgentRuntime.js";
import { DEFAULT_AGENT_EXECUTION_LIMITS } from "../../../agent/AgentExecutionProgress.js";
import type {
  AgentEvent,
  AgentScenarioEntry,
  ChatMessage,
  ToolDef,
  ToolResult,
} from "../AgentRuntimeEvalSpec.js";

export interface RunAgentOptions {
  llm: LlmClient;
  model: string;
  /**
   * Spec system prompt — threaded through the planner step so curator-
   * style runs see CURATOR_SYSTEM_PROMPT instead of the default PI
   * preamble. Pass an empty string to keep PI's default.
   */
  systemPrompt: string;
  scenario: AgentScenarioEntry;
  /**
   * Override the planner factory — allows tests to inject a deterministic
   * fake planner without standing up the full createDefaultPlanner, and
   * lets curatorSafety swap in a planner with the curator system prompt.
   */
  plannerFactory?: (deps: {
    llm: LlmClient;
    model: string;
    systemPrompt: string;
  }) => AgentPlanner;
}

export interface RunAgentResult {
  events: AgentEvent[];
  /** Last user-visible message (final text or terminate reason). */
  finalText: string | null;
  /** Whether iteration budget was exceeded before final. */
  budgetExceeded: boolean;
}

const DEFAULT_FACTORY: Required<RunAgentOptions>["plannerFactory"] = (deps) =>
  createDefaultPlanner({
    llm: deps.llm,
    model: deps.model,
    systemPrompt: deps.systemPrompt || undefined,
  });

export async function runAgentScenario(opts: RunAgentOptions): Promise<RunAgentResult> {
  const planner = (opts.plannerFactory ?? DEFAULT_FACTORY)({
    llm: opts.llm,
    model: opts.model,
    systemPrompt: opts.systemPrompt,
  });

  const events: AgentEvent[] = [];
  const history: PlannerStepInput["history"] = [];
  const toolRegistry = new Map(
    opts.scenario.tools.map((t) => [t.name, t] as const),
  );
  const knownToolNames = new Set(toolRegistry.keys());

  const userText = collectUserText(opts.scenario.initialMessages);
  const maxIterations = Math.min(
    opts.scenario.maxIterations ||
      DEFAULT_AGENT_EXECUTION_LIMITS.maxEmergencyToolCalls,
    DEFAULT_AGENT_EXECUTION_LIMITS.maxEmergencyToolCalls,
  );

  let finalText: string | null = null;
  let budgetExceeded = false;

  for (let iter = 0; iter < maxIterations; iter++) {
    let decision;
    try {
      decision = await planner.step({
        userText,
        tools: opts.scenario.tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema as PlannerStepInput["tools"][number]["inputSchema"],
        })),
        history,
      });
    } catch (err) {
      events.push({
        type: "error",
        detail: `planner-step-failed: ${(err as Error).message}`,
      });
      break;
    }

    if (decision.kind === "tool_call") {
      events.push({
        type: "planner-decision",
        raw: JSON.stringify(decision),
        parsed: decision,
      });
      if (!knownToolNames.has(decision.tool)) {
        events.push({
          type: "unknown-tool",
          detail: `planner asked for tool '${decision.tool}'`,
        });
        // Production behaviour: stop on unknown tool.
        break;
      }
      events.push({
        type: "tool-call",
        tool: decision.tool,
        input: decision.input,
      });
      const scripted = opts.scenario.scriptedToolResults.get(decision.tool);
      const toolOutput: ToolResult = scripted ?? {
        ok: false,
        output: null,
        error: `no scripted result for tool '${decision.tool}'`,
      };
      events.push({
        type: "tool-result",
        tool: decision.tool,
        output: toolOutput.output,
      });
      history.push({
        type: "tool_call",
        tool: decision.tool,
        input: decision.input,
      });
      history.push({
        type: "tool_result",
        tool: decision.tool,
        output: toolOutput.output,
      });
      continue;
    }

    if (decision.kind === "final") {
      events.push({
        type: "planner-decision",
        raw: JSON.stringify(decision),
        parsed: decision,
      });
      events.push({ type: "final", text: decision.text });
      finalText = decision.text;
      break;
    }

    if (decision.kind === "error") {
      events.push({
        type: "planner-decision",
        raw: JSON.stringify(decision),
        parsed: decision,
      });
      events.push({ type: "error", detail: decision.message });
      break;
    }
  }

  if (finalText === null && events.every((e) => e.type !== "error")) {
    budgetExceeded = true;
    events.push({
      type: "budget-exceeded",
      detail: `iterated ${maxIterations} times without final`,
    });
  }

  return { events, finalText, budgetExceeded };
}

function collectUserText(messages: ChatMessage[]): string {
  // The planner step takes a single userText string; concatenate all
  // user-role messages so multi-turn scenarios still surface the
  // original ask. Assistant turns from history are NOT propagated —
  // the planner instead sees the structured tool-call history.
  return messages
    .filter((m) => m.role === "user")
    .map((m) => m.content)
    .join("\n\n");
}

/** Re-export for spec authors. */
export type { ToolDef };
