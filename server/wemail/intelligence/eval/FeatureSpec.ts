/**
 * Shared types for the prompt-eval framework v2.
 *
 * Two kinds of spec live in `features/`:
 *   - `SingleTurnPromptSpec` — one LLM call per sample (summary, tags, etc.)
 *   - `AgentRuntimeEvalSpec` — multi-turn + tool-calling (piPlanner, curator)
 *
 * Both share the axis-score / weight / acceptance-gate vocabulary
 * defined here. Phase 1 only wires SingleTurn through the harness;
 * AgentRuntime types are reserved for Phase 6.
 */

import { createHash } from "node:crypto";

export interface AxisScore {
  score: number; // 0..3 (fractional allowed)
  notes: string[];
}

export interface AxisWeights {
  format: number;
  accuracy: number;
  quality: number;
  safety: number;
  /** Custom-axis weights live here keyed by `CustomAxisDef.id`. */
  custom?: Record<string, number>;
}

/** Default 4-axis weights — sum to 1.0. */
export const DEFAULT_AXIS_WEIGHTS: AxisWeights = {
  format: 0.3,
  accuracy: 0.35,
  quality: 0.25,
  safety: 0.1,
} as const;

/**
 * Acceptance gates split by sample stratum (Phase 2 wires the
 * per-stratum check; Phase 1 keeps the legacy single-bucket gate
 * working via the `legacy` field for backward compatibility).
 */
export interface PerStratumGates {
  fixtures?: {
    minDelta?: number; // default +1.0
    maxRegression?: number; // default 1.5
    formatPassRate?: number; // default 0.95
  };
  injection?: {
    safetyMin?: 3; // hard requirement
    minCount?: number;
  };
  corpus?: {
    minDelta?: number;
    maxRegression?: number;
    formatPassRate?: number;
  };
  judge?: {
    maxErrorRate?: number; // default 0.02
    maxUnstableSamples?: number; // default 0.05
  };
  /** Phase 1 fallback — single-bucket gates used by the existing diff renderer. */
  legacy?: {
    minDelta?: number;
    maxRegression?: number;
    formatPassRate?: number;
    injectionSafetyMin?: number;
  };
}

/**
 * A custom (extra) scoring axis declared by a feature spec.
 *
 * Custom axes either run a deterministic scorer or a judge call. When
 * `judge` is set the LlmJudge runs the rubric `repeatN` times (default
 * 3 for subjective axes) and takes the median; if stdev exceeds
 * `maxVariance` the sample is flagged `unstable` and counted against
 * the judge stratum gate.
 */
export interface CustomAxisDef<TParsed = unknown, TSample = unknown> {
  id: string;
  weight: number;
  scorer?: (parsed: TParsed, sample: TSample) => AxisScore;
  judge?: {
    rubric: string;
    repeatN?: number; // default 3 for subjective axes
    maxVariance?: number; // default 0.8
  };
}

/** Discriminator-tagged union of all spec kinds — used by the registry. */
export type AnyEvalSpec =
  | import("./SingleTurnPromptSpec.js").SingleTurnPromptSpec
  | import("./AgentRuntimeEvalSpec.js").AgentRuntimeEvalSpec;

/**
 * Shared JSON parser with markdown-fence and first-brace fallbacks —
 * used by every single-turn spec's `parseOutput`. Returns null on
 * unrecoverable failure so callers can return their own diagnostic.
 */
export function parseJsonWithFallbacks(raw: string): unknown {
  if (!raw) return null;
  const text = raw.trim();
  try {
    return JSON.parse(text);
  } catch {
    /* fall through */
  }
  const fenced = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/i);
  if (fenced && fenced[1]) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
      /* fall through */
    }
  }
  const a = text.indexOf("{");
  const b = text.lastIndexOf("}");
  if (a >= 0 && b > a) {
    try {
      return JSON.parse(text.slice(a, b + 1));
    } catch {
      /* fall through */
    }
  }
  return null;
}

/** Plugin metadata recorded in eval-reports/<feature>/<version>/manifest.json */
export interface PluginMeta {
  packageName: string;
  packageVersion: string;
  specHash: string;
  loadedFrom: string;
  allowOverride: boolean;
}

/**
 * Compute a stable 12-char sha256 prefix over the prompt + version + schema.
 * Spec files call this when they're declared; the registry recomputes and
 * verifies the advertised hash matches.
 */
export function computePromptHash(args: {
  systemPrompt: string;
  promptVersion: string;
  jsonSchema?: Record<string, unknown>;
}): string {
  const sources: string[] = [args.systemPrompt, args.promptVersion];
  if (args.jsonSchema) sources.push(JSON.stringify(args.jsonSchema));
  return createHash("sha256").update(sources.join("\n")).digest("hex").slice(0, 12);
}

/**
 * Validate that a weight set sums to 1.0 ± epsilon. Custom axes count
 * toward the total; the four built-in axes are always included.
 */
export function validateWeights(
  weights: AxisWeights,
  customAxes: ReadonlyArray<{ weight: number }> | undefined,
  epsilon = 1e-3,
): { ok: true } | { ok: false; reason: string } {
  let sum = weights.format + weights.accuracy + weights.quality + weights.safety;
  for (const axis of customAxes ?? []) {
    sum += axis.weight;
  }
  if (Math.abs(sum - 1.0) > epsilon) {
    return {
      ok: false,
      reason: `axis weights must sum to 1.0 (got ${sum.toFixed(4)})`,
    };
  }
  return { ok: true };
}
