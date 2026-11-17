/**
 * Mail Curator agent runtime (Route C / WP J.5).
 *
 * Wraps a {@link PiAgentRuntime} with the Curator-specific tool set,
 * system prompt, and per-run accounting (iterations, tokens, files
 * written, learnings audit header). The Curator never sends mail and
 * never reads received-mail body — see CuratorTools for the enforced
 * surface.
 *
 * Per-run budgets (see brief §安全预算 / §安全模型):
 *   - 90s wall clock          (CURATOR_RUN_TIMEOUT_MS)
 *   - 6 iterations            (CURATOR_MAX_ITERATIONS)
 *   - 50K tokens HARD CAP     (CURATOR_TOKEN_BUDGET — abort mid-run)
 *   - 256 KiB total writes    (RunBudget enforced inside tools)
 *
 * Token enforcement: the runtime accumulates a 4-chars-per-token
 * estimate of every tool result. When the running total crosses
 * {@link CURATOR_TOKEN_BUDGET} we stop pulling events from the inner
 * runtime, which terminates the run with the budget-exceeded error in
 * the summary. This is an external cap — the inner PI loop keeps its
 * own iteration/timeout caps independently.
 */

import { createHash } from "node:crypto";
import { estimateTokens } from "../ai/context/ContextBuilder.js";
import type { AgentEvent, AgentRuntime } from "./AgentRuntime.js";
import {
  PiAgentRuntime,
  type AgentPlanner,
  type PiAgentRuntimeOptions,
} from "./PiAgentRuntime.js";
import {
  createCuratorTools,
  RunBudget,
  type CuratorToolDeps,
} from "./CuratorTools.js";
import {
  CURATOR_PROMPT_VERSION,
  CURATOR_SYSTEM_PROMPT,
} from "../ai/prompts/curatorSystemPrompt.js";
import type { LlmClient } from "../ai/LlmClient.js";
import type { WorkspaceFileSystem } from "../workspace/WorkspaceFileSystem.js";
import type { IntelligenceResultRepository } from "../intelligence/IntelligenceResultRepository.js";
import type { CanonicalMailRepository } from "../mail/CanonicalMailRepository.js";
import {
  noopCuratorAuditLogger,
  type CuratorAuditLogger,
} from "./CuratorAuditLogger.js";

export const CURATOR_MAX_ITERATIONS = 6;
export const CURATOR_RUN_TIMEOUT_MS = 90_000;
export const CURATOR_TOOL_TIMEOUT_MS = 30_000;
export const CURATOR_TOKEN_BUDGET = 50_000;

export type CuratorRunReason = "time" | "count" | "manual";

export interface CuratorRunSummary {
  durationMs: number;
  iterations: number;
  tokensUsed: number;
  filesWritten: string[];
  errors: string[];
}

export interface CuratorAgentRuntimeOptions {
  accountId: string;
  fs: WorkspaceFileSystem;
  intelligenceResults: IntelligenceResultRepository;
  mailRepo: CanonicalMailRepository;
  /** Override the system prompt (tests). */
  systemPrompt?: string;
  /**
   * Override the inner runtime. When omitted, the constructor builds a
   * `PiAgentRuntime` from `llmClient`/`model`/`planner`. Tests typically
   * pass a `planner` directly.
   */
  runtime?: AgentRuntime;
  llmClient?: LlmClient;
  model?: string;
  planner?: AgentPlanner;
  /**
   * Append-only audit channel (one JSONL line per run). Defaults to a
   * no-op logger so legacy/test callers keep working; production wires
   * a {@link FileCuratorAuditLogger} pointed at `<dataDir>/audit.log`.
   */
  auditLogger?: CuratorAuditLogger;
  now?: () => number;
}

export interface CuratorRunInput {
  reason: CuratorRunReason;
  /** Optional cursor that changes between runs (e.g. last-run timestamp). Mixed into inputs_hash. */
  sinceCursor?: string;
}

function sha1Hex(input: string): string {
  return createHash("sha1").update(input).digest("hex");
}

export class CuratorAgentRuntime {
  readonly accountId: string;
  private readonly fs: WorkspaceFileSystem;
  private readonly runtime: AgentRuntime;
  private readonly now: () => number;
  private readonly auditLogger: CuratorAuditLogger;
  private readonly runBudget: RunBudget;

  constructor(options: CuratorAgentRuntimeOptions) {
    this.accountId = options.accountId;
    this.fs = options.fs;
    this.now = options.now ?? (() => Date.now());
    this.auditLogger = options.auditLogger ?? noopCuratorAuditLogger;
    this.runBudget = new RunBudget();

    if (options.runtime) {
      this.runtime = options.runtime;
    } else {
      const piOptions: PiAgentRuntimeOptions = {
        maxEmergencyToolCalls: CURATOR_MAX_ITERATIONS,
        runTimeoutMs: CURATOR_RUN_TIMEOUT_MS,
        toolTimeoutMs: CURATOR_TOOL_TIMEOUT_MS,
        now: this.now,
        systemPrompt: options.systemPrompt ?? CURATOR_SYSTEM_PROMPT,
      };
      if (options.planner) {
        piOptions.planner = options.planner;
      } else if (options.llmClient) {
        piOptions.llm = options.llmClient;
        if (options.model) piOptions.model = options.model;
      } else {
        throw new Error(
          "CuratorAgentRuntime requires `runtime`, `planner`, or `llmClient` in options",
        );
      }
      this.runtime = new PiAgentRuntime(piOptions);
    }

    const toolDeps: CuratorToolDeps = {
      fs: options.fs,
      intelligenceResults: options.intelligenceResults,
      mail: options.mailRepo,
      accountId: options.accountId,
      runBudget: this.runBudget,
      now: () => new Date(this.now()),
    };
    for (const tool of createCuratorTools(toolDeps)) {
      this.runtime.registerTool(tool);
    }
  }

  /**
   * Drive one full Curator pass and return a summary. The system prompt
   * is forwarded as the user-text seed; the inner PiAgentRuntime runs
   * its own planner/loop until either `final` or budget exhaustion.
   */
  async run(input: CuratorRunInput): Promise<CuratorRunSummary> {
    const startMs = this.now();
    const startedAt = new Date(startMs);
    let iterations = 0;
    let tokensUsed = 0;
    const filesWritten: string[] = [];
    const errors: string[] = [];
    // RunBudget is per-run state. We reuse the instance handed to the
    // tools at construction time so each run starts at zero bytes.
    this.runBudget.reset();

    const userText = [
      `Curator run reason=${input.reason}`,
      input.sinceCursor ? `cursor=${input.sinceCursor}` : "",
      `Refine the workspace based on recent feedback, sent metadata, and intelligence results.`,
      `End by writing learnings/<YYYY-MM-DD>.md.`,
    ]
      .filter(Boolean)
      .join("\n");

    let abortedForTokenBudget = false;
    try {
      const iterator = this.runtime.run({
        userText,
        accountId: this.accountId,
        context: {
          curatorReason: input.reason,
          curatorPromptVersion: CURATOR_PROMPT_VERSION,
        },
      });
      for await (const event of iterator) {
        if (event.type === "tool_call") {
          iterations += 1;
        } else if (event.type === "tool_result") {
          tokensUsed += this.estimateTokens(event.output);
          if (event.tool === "write_workspace_file" || event.tool === "append_workspace_file") {
            const path = (event.output as { path?: string })?.path;
            const ok = (event.output as { ok?: boolean })?.ok;
            if (ok && path) filesWritten.push(path);
          }
        } else if (event.type === "error") {
          if (!errors.includes(event.message)) errors.push(event.message);
        } else if (
          event.type === "conclusion" &&
          event.status !== "succeeded"
        ) {
          const reason = event.reason ?? event.summary;
          const plannerFailurePrefix = "规划阶段未能生成有效决策：";
          const message = reason.startsWith(plannerFailurePrefix)
            ? reason.slice(plannerFailurePrefix.length)
            : reason;
          if (message && !errors.includes(message)) errors.push(message);
        }

        if (tokensUsed > CURATOR_TOKEN_BUDGET) {
          abortedForTokenBudget = true;
          // Best-effort early abort: stop pulling events. The inner
          // runtime's withTimeout / iteration cap will collect any
          // already-in-flight tool call. We don't await iterator.return
          // because some PiAgentRuntime paths skip it; abandoning the
          // generator is sufficient — the for-await ends and the inner
          // run loop terminates on its own.
          if (typeof iterator.return === "function") {
            try {
              await iterator.return();
            } catch {
              // ignore — generator may already be done
            }
          }
          break;
        }
      }
    } catch (err) {
      errors.push((err as Error).message);
    }

    const endMs = this.now();
    const durationMs = endMs - startMs;

    if (abortedForTokenBudget) {
      errors.push(
        `token budget exceeded: ${tokensUsed} > ${CURATOR_TOKEN_BUDGET} (run aborted)`,
      );
    }

    const summary: CuratorRunSummary = {
      durationMs,
      iterations,
      tokensUsed,
      filesWritten,
      errors,
    };

    await this.appendLearningsHeader({
      startedAt,
      input,
      summary,
      filesWritten,
    });

    await this.auditLogger.append({
      ts: startedAt.toISOString(),
      kind: "curator.run",
      account_id: this.accountId,
      reason: input.reason,
      duration_ms: durationMs,
      tokens_used: tokensUsed,
      iterations,
      bytes_written: this.runBudget.bytesWrittenThisRun,
      files_written: filesWritten,
      errors,
    });

    return summary;
  }

  private estimateTokens(output: unknown): number {
    if (output === undefined || output === null) return 0;
    const text = typeof output === "string" ? output : safeJson(output);
    return estimateTokens(text);
  }

  private async appendLearningsHeader(args: {
    startedAt: Date;
    input: CuratorRunInput;
    summary: CuratorRunSummary;
    filesWritten: string[];
  }): Promise<void> {
    const { startedAt, input, summary, filesWritten } = args;
    const dateKey = startedAt.toISOString().slice(0, 10);
    const path = `learnings/${dateKey}.md`;
    const inputsHash = sha1Hex(
      JSON.stringify({
        accountId: this.accountId,
        reason: input.reason,
        cursor: input.sinceCursor ?? null,
        startedAt: startedAt.toISOString(),
        promptVersion: CURATOR_PROMPT_VERSION,
        filesWritten,
      }),
    );
    const header = [
      "",
      `<<<HEADER>>>`,
      `runId=${startedAt.toISOString()}`,
      `inputs_hash=${inputsHash}`,
      `prompt_version=${CURATOR_PROMPT_VERSION}`,
      `reason=${input.reason}`,
      `duration_ms=${summary.durationMs}`,
      `tokens_used=${summary.tokensUsed}`,
      `iterations=${summary.iterations}`,
      `files_written=${filesWritten.join(",")}`,
      `<<<END_HEADER>>>`,
      "",
    ].join("\n");
    try {
      await this.fs.appendFile(path, header);
    } catch (err) {
      summary.errors.push(`learnings_append_failed: ${(err as Error).message}`);
    }
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
