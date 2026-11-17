/**
 * LLM-judge for the Quality axis (and Phase 3 custom axes).
 *
 * Two entry points:
 *   • `judgeWithRubric` — generic, takes an explicit rubric. Used by
 *     spec-driven custom axes. Supports repeated judging (`repeatN`)
 *     for subjective axes; returns median + variance + `unstable` flag.
 *   • `judgeQuality` — legacy single-shot wrapper kept for the existing
 *     harness path. Looks up the per-feature rubric from a Map but
 *     prefers an explicit rubric override when supplied.
 *
 * The judge prompt itself is intentionally short and feature-agnostic:
 * "score 0..3, reply JSON". The rubric lives in the system prompt.
 *
 * Failure modes are surfaced via `judgeError` so per-stratum acceptance
 * (Phase 2) can fail the run when the error rate exceeds the gate.
 */

import type { LlmClient } from "../../../ai/LlmClient.js";
import type { MailSampleEntry } from "../../../testing/mailSamples.js";
import type { PolishableFeature } from "./RuleScorer.js";

const JUDGE_TIMEOUT_MS = 60_000;
const JUDGE_TEMPERATURE = 0;
const DEFAULT_REPEAT_N = 1;
const DEFAULT_SUBJECTIVE_REPEAT_N = 3;
const DEFAULT_MAX_VARIANCE = 0.8;

const JUDGE_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["score", "reason"],
  properties: {
    score: { type: "number", minimum: 0, maximum: 3 },
    reason: { type: "string", minLength: 1, maxLength: 200 },
  },
} as const;

/* ----------------------- Per-feature rubrics (legacy + default) ----------------------- */

const FEATURE_QUALITY_RUBRIC: Record<PolishableFeature, string> = {
  summary:
    "Quality means: bullets capture the email's actual asks/decisions (not background); urgency reflects what the email actually demands; nothing is fabricated; numbers/dates are preserved verbatim from the source. Does NOT mean: JSON validity (already scored elsewhere).",
  tags:
    "Quality means: the chosen categoryId genuinely fits the email; the tags pick the most descriptive labels from the allowed list; reason is brief and grounded in observable signals. Does NOT mean: schema compliance.",
  replyDraft:
    "Quality means: the medium variant is a fluent, business-direct reply that addresses what the email actually asks; tone variants meaningfully differ; nothing is auto-sent; nothing fabricates commitments. Does NOT mean: JSON shape.",
  replyDecision:
    "Quality means: shouldReply matches the email's actual conversational pull (a direct ask → reply; a notification → no reply); the reason is observable (\"asks for confirmation\" vs vague \"important email\").",
  linkExtraction:
    "Quality means: the surfaced links are genuine actions (RSVP, approve, view ticket); actionText reads like a button label; categories match (meeting/approval/document/other); marketing/unsubscribe links are not promoted to prime spots.",
};

/* ----------------------- Public types ----------------------- */

export interface LlmJudgeResult {
  score: number; // 0.0..3.0 (median across attempts)
  reason: string; // representative reason from the median attempt
  /** All raw attempt scores (length = repeatN). */
  attempts: number[];
  /** Std dev across attempts (0 when repeatN=1). */
  stdev: number;
  /** True iff stdev > maxVariance — sample flagged for the judge gate. */
  unstable: boolean;
  /** True iff at least one attempt failed to get a usable response. */
  judgeError: boolean;
  errorReason?: string;
}

/* ----------------------- Generic rubric judge ----------------------- */

/**
 * Score one output against an explicit rubric. Repeats the judge call
 * `repeatN` times for subjective axes; returns the median + variance.
 *
 * The rubric is exposed in the system prompt verbatim — spec authors
 * own its phrasing. The judge is told strictly to return JSON with
 * `score` and `reason`; parse failures fall back to score=1.5 + flag.
 */
export async function judgeWithRubric(args: {
  llm: LlmClient;
  model: string;
  /** Free-form rubric — what "good" means for this axis. */
  rubric: string;
  /** Feature id used in the system-prompt header. */
  feature: string;
  /** Pre-rendered email-context block (already redacted). */
  emailContext: string;
  /** Output to grade — JSON-stringified before sending. */
  output: unknown;
  repeatN?: number;
  maxVariance?: number;
  /** Optional axis name for logging context (defaults to "quality"). */
  axisName?: string;
}): Promise<LlmJudgeResult> {
  const repeatN = Math.max(1, args.repeatN ?? DEFAULT_REPEAT_N);
  const maxVariance = args.maxVariance ?? DEFAULT_MAX_VARIANCE;

  const system = [
    "You are a strict but fair quality grader for an AI email assistant.",
    `Feature under evaluation: ${args.feature}`,
    `Axis: ${args.axisName ?? "quality"}`,
    `Rubric: ${args.rubric}`,
    "",
    "Score the OUTPUT on this axis only, on a 0..3 scale (fractional allowed):",
    "  0 = irrelevant, fabricated, or harmful",
    "  1 = present but misses the email's actual point",
    "  2 = relevant and largely faithful, with minor gaps",
    "  3 = exactly what a careful human would produce",
    "",
    'Reply ONLY with JSON: {"score": <0..3>, "reason": "<one short sentence, no quotes>"}.',
    "Reason must cite a concrete observation about the OUTPUT, not generic praise.",
  ].join("\n");

  const userMessage = [
    "EMAIL:",
    args.emailContext,
    "",
    "OUTPUT to grade:",
    compactOutput(args.output),
  ].join("\n");

  const attemptScores: number[] = [];
  const attemptReasons: string[] = [];
  let lastError: string | undefined;

  for (let i = 0; i < repeatN; i++) {
    let res;
    try {
      res = await args.llm.generate({
        model: args.model,
        system,
        jsonSchema: JUDGE_JSON_SCHEMA as Record<string, unknown>,
        temperature: JUDGE_TEMPERATURE,
        timeoutMs: JUDGE_TIMEOUT_MS,
        messages: [{ role: "user", content: userMessage }],
      });
    } catch (err) {
      lastError = `judge-call-failed: ${(err as Error).message}`;
      continue;
    }
    const parsed = tryParseJudgeOutput(res.text);
    if (!parsed) {
      lastError = `judge-parse-failed: ${res.text.slice(0, 80)}`;
      continue;
    }
    attemptScores.push(clamp03(parsed.score));
    attemptReasons.push(
      String(parsed.reason ?? "").slice(0, 200) || "(empty)",
    );
  }

  if (attemptScores.length === 0) {
    return {
      score: 1.5,
      reason: lastError ?? "judge-empty-attempts",
      attempts: [],
      stdev: 0,
      unstable: false,
      judgeError: true,
      errorReason: lastError,
    };
  }

  const score = round1(median(attemptScores));
  const stdev = round2(stddev(attemptScores));
  const reason = attemptReasons[indexOfMedian(attemptScores)] ?? attemptReasons[0]!;
  // Variance only matters when we actually repeated.
  const unstable = repeatN >= 2 && stdev > maxVariance;
  return {
    score,
    reason,
    attempts: attemptScores,
    stdev,
    unstable,
    judgeError: false,
  };
}

/* ----------------------- Legacy per-feature judge (compat) ----------------------- */

/**
 * Backward-compatible wrapper used by the existing PromptEvalHarness
 * code path. Looks up the per-feature rubric and runs a single judge
 * call (no repeats) — same behavior as Phase 1.
 *
 * New callers should prefer `judgeWithRubric` so they can pass the
 * spec's own rubric and opt into repeatN.
 */
export async function judgeQuality(args: {
  llm: LlmClient;
  model: string;
  feature: PolishableFeature;
  sample: MailSampleEntry;
  output: unknown;
  /** Optional override: if supplied, used instead of the per-feature rubric map. */
  rubric?: string;
  repeatN?: number;
  maxVariance?: number;
}): Promise<LlmJudgeResult> {
  const rubric = args.rubric ?? FEATURE_QUALITY_RUBRIC[args.feature];
  const subjectiveDefault = (args.repeatN ?? DEFAULT_REPEAT_N) >= 2
    ? args.repeatN!
    : DEFAULT_REPEAT_N;
  return judgeWithRubric({
    llm: args.llm,
    model: args.model,
    rubric,
    feature: args.feature,
    emailContext: summarizeMail(args.sample),
    output: args.output,
    repeatN: subjectiveDefault,
    maxVariance: args.maxVariance,
  });
}

/* ----------------------- Helpers ----------------------- */

export const SUBJECTIVE_REPEAT_N = DEFAULT_SUBJECTIVE_REPEAT_N;

function summarizeMail(sample: MailSampleEntry): string {
  const subject = sample.mail.subject ?? "(no subject)";
  const from =
    typeof sample.mail.from === "object" && sample.mail.from !== null
      ? sample.mail.from.name
        ? `${sample.mail.from.name} <${sample.mail.from.email}>`
        : sample.mail.from.email
      : String(sample.mail.from ?? "(unknown)");
  const body =
    sample.mail.bodyText && sample.mail.bodyText.trim().length > 0
      ? sample.mail.bodyText.slice(0, 1500)
      : sample.mail.snippet ?? "(no body)";
  return [
    `Subject: ${subject}`,
    `From: ${from}`,
    `Body (truncated):`,
    body,
  ].join("\n");
}

function compactOutput(output: unknown): string {
  if (typeof output === "string") return output.slice(0, 1500);
  try {
    const text = JSON.stringify(output, null, 2);
    return text.length > 2000 ? `${text.slice(0, 2000)}\n[...truncated]` : text;
  } catch {
    return String(output).slice(0, 1500);
  }
}

function tryParseJudgeOutput(raw: string): { score: number; reason: string } | null {
  if (!raw) return null;
  const text = raw.trim();
  const candidates: string[] = [text];
  const fenced = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/i);
  if (fenced && fenced[1]) candidates.push(fenced[1].trim());
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(text.slice(firstBrace, lastBrace + 1));
  }
  for (const candidate of candidates) {
    try {
      const obj = JSON.parse(candidate) as { score?: unknown; reason?: unknown };
      if (typeof obj.score === "number" && Number.isFinite(obj.score)) {
        return {
          score: obj.score as number,
          reason: typeof obj.reason === "string" ? obj.reason : "",
        };
      }
    } catch {
      /* try next candidate */
    }
  }
  return null;
}

function clamp03(n: number): number {
  if (!Number.isFinite(n)) return 1.5;
  if (n < 0) return 0;
  if (n > 3) return 3;
  return Math.round(n * 10) / 10;
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!;
}

function indexOfMedian(xs: number[]): number {
  if (xs.length === 0) return 0;
  const med = median(xs);
  let bestIdx = 0;
  let bestDiff = Math.abs(xs[0]! - med);
  for (let i = 1; i < xs.length; i++) {
    const d = Math.abs(xs[i]! - med);
    if (d < bestDiff) {
      bestDiff = d;
      bestIdx = i;
    }
  }
  return bestIdx;
}

function stddev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const variance =
    xs.reduce((acc, x) => acc + (x - mean) ** 2, 0) / xs.length;
  return Math.sqrt(variance);
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
