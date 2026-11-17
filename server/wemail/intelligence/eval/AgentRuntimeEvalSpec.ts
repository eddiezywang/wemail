/**
 * Agent-runtime spec — multi-turn + tool-calling features.
 *
 * Used in Phase 6 for piPlanner and curatorSafety. The runner
 * (`AgentRuntimeRunner`, also Phase 6) drives an actual
 * `PiAgentRuntime` / `CuratorAgentRuntime` against scripted scenarios
 * with mocked tool results, then collects the event stream for scoring.
 *
 * Phase 1 only declares the types; no spec implementation exists yet.
 */

import type {
  AxisScore,
  AxisWeights,
  CustomAxisDef,
  PerStratumGates,
} from "./FeatureSpec.js";

/** Minimal chat message shape — kept inline to avoid coupling. */
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolResult {
  ok: boolean;
  output: unknown;
  error?: string;
}

/**
 * One agent-eval scenario: a complete dialog setup with scripted
 * tool returns and the maximum iterations the runtime is allowed.
 */
export interface AgentScenarioEntry {
  id: string;
  description: string;
  /** What the runtime should do — used by accuracy/safety scorers. */
  expected: {
    finalContains?: string[];
    toolsCalledInOrder?: string[];
    mustNotCall?: string[];
    mustTerminate?: boolean;
  };
  /** Optional category tag for stratum bucketing (e.g. "injection"). */
  category?: string;
  /** Initial messages sent to the runtime (user + history). */
  initialMessages: ChatMessage[];
  /** Tools registered with the runtime for this scenario. */
  tools: ToolDef[];
  /** Mock returns for each tool name. */
  scriptedToolResults: Map<string, ToolResult>;
  maxIterations: number;
}

/** Event emitted during one agent run — collected for scoring. */
export type AgentEvent =
  | { type: "planner-decision"; raw: string; parsed: unknown }
  | { type: "tool-call"; tool: string; input: unknown }
  | { type: "tool-result"; tool: string; output: unknown }
  | { type: "repair-attempt"; reason: string }
  | { type: "final"; text: string }
  | { type: "budget-exceeded"; detail: string }
  | { type: "unknown-tool"; detail: string }
  | { type: "error"; detail: string };

export interface AgentRuntimeEvalSpec {
  kind: "agent-runtime";
  id: string;
  description: string;
  promptVersion: string;
  promptHash: string;
  systemPrompt: string;

  buildScenario(sample: AgentScenarioEntry): AgentScenarioEntry;

  scoring: {
    format: (events: AgentEvent[]) => AxisScore;
    accuracy: (events: AgentEvent[], sample: AgentScenarioEntry) => AxisScore;
    safety: (events: AgentEvent[], sample: AgentScenarioEntry) => AxisScore;
    qualityRubric: string;
    customAxes?: CustomAxisDef<AgentEvent[], AgentScenarioEntry>[];
  };

  weights?: Partial<AxisWeights>;
  acceptanceGates?: PerStratumGates;
}
