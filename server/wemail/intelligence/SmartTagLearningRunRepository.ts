import { randomUUID } from "node:crypto";
import type { MailDatabase } from "../database/Database.js";

export type SmartTagLearningRunStatus =
  | "generating"
  | "evaluating"
  | "activated"
  | "rejected"
  | "failed"
  | "stale";

export type SmartTagLearningSampleSplit = "optimization" | "validation";

export interface SmartTagLearningRun {
  id: string;
  accountId: string;
  tagId: string;
  tagName: string;
  status: SmartTagLearningRunStatus;
  sourcePromptHash: string;
  activePromptHash: string;
  modelGeneration: number;
  model: string;
  candidatePrompt?: string;
  candidateSummary?: Record<string, unknown>;
  sampleCount: number;
  positiveCount: number;
  negativeCount: number;
  optimizationCount: number;
  validationCount: number;
  currentCorrect: number;
  candidateCorrect: number;
  correctedCount: number;
  regressionCount: number;
  reason?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  activatedAt?: string;
}

export interface SmartTagLearningRunSample {
  runId: string;
  actionId: string;
  emailId: string;
  split: SmartTagLearningSampleSplit;
  expectedAction: "apply" | "remove";
  isNewFeedback: boolean;
  currentMatched?: boolean;
  candidateMatched?: boolean;
  confirmationMatched?: boolean;
  currentConfidence?: number;
  candidateConfidence?: number;
  confirmationConfidence?: number;
  errorCode?: string;
  createdAt: string;
  updatedAt: string;
}

interface RunRow {
  id: string;
  account_id: string;
  tag_id: string;
  tag_name: string;
  status: string;
  source_prompt_hash: string;
  active_prompt_hash: string;
  model_generation: number;
  model: string;
  candidate_prompt: string | null;
  candidate_summary_json: string | null;
  sample_count: number;
  positive_count: number;
  negative_count: number;
  optimization_count: number;
  validation_count: number;
  current_correct: number;
  candidate_correct: number;
  corrected_count: number;
  regression_count: number;
  reason: string | null;
  created_at_ms: number;
  started_at_ms: number | null;
  completed_at_ms: number | null;
  activated_at_ms: number | null;
}

interface SampleRow {
  run_id: string;
  action_id: string;
  email_id: string;
  split: string;
  expected_action: string;
  is_new_feedback: number;
  current_matched: number | null;
  candidate_matched: number | null;
  confirmation_matched: number | null;
  current_confidence: number | null;
  candidate_confidence: number | null;
  confirmation_confidence: number | null;
  error_code: string | null;
  created_at_ms: number;
  updated_at_ms: number;
}

const RUN_SELECT = `SELECT runs.public_id AS id,
  accounts.public_id AS account_id, tags.public_id AS tag_id, tags.name AS tag_name,
  runs.state AS status, runs.source_prompt_hash, runs.active_prompt_hash,
  runs.model_generation, runs.model_id AS model, runs.candidate_prompt,
  runs.candidate_summary_json, runs.sample_count, runs.positive_count,
  runs.negative_count, runs.optimization_count, runs.validation_count,
  runs.current_correct, runs.candidate_correct, runs.corrected_count,
  runs.regression_count, runs.reason, runs.created_at_ms, runs.started_at_ms,
  runs.completed_at_ms, runs.activated_at_ms
  FROM mail_smart_tag_learning_runs runs
  JOIN mail_accounts accounts ON accounts.id = runs.account_id
  JOIN mail_user_tags tags ON tags.id = runs.tag_id`;

const SAMPLE_SELECT = `SELECT runs.public_id AS run_id,
  actions.public_id AS action_id, messages.public_id AS email_id,
  samples.split, samples.expected_action, samples.is_new_feedback,
  samples.current_matched, samples.candidate_matched,
  samples.confirmation_matched, samples.current_confidence,
  samples.candidate_confidence, samples.confirmation_confidence,
  samples.error_code, samples.created_at_ms, samples.updated_at_ms
  FROM mail_smart_tag_learning_samples samples
  JOIN mail_smart_tag_learning_runs runs ON runs.id = samples.run_id
  JOIN mail_smart_tag_actions actions ON actions.id = samples.action_id
  JOIN mail_messages messages ON messages.id = samples.message_id`;

function parseJson(value: string | null): Record<string, unknown> | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object"
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function rowToRun(row: RunRow): SmartTagLearningRun {
  return {
    id: row.id,
    accountId: row.account_id,
    tagId: row.tag_id,
    tagName: row.tag_name,
    status: row.status as SmartTagLearningRunStatus,
    sourcePromptHash: row.source_prompt_hash,
    activePromptHash: row.active_prompt_hash,
    modelGeneration: row.model_generation,
    model: row.model,
    candidatePrompt: row.candidate_prompt ?? undefined,
    candidateSummary: parseJson(row.candidate_summary_json),
    sampleCount: row.sample_count,
    positiveCount: row.positive_count,
    negativeCount: row.negative_count,
    optimizationCount: row.optimization_count,
    validationCount: row.validation_count,
    currentCorrect: row.current_correct,
    candidateCorrect: row.candidate_correct,
    correctedCount: row.corrected_count,
    regressionCount: row.regression_count,
    reason: row.reason ?? undefined,
    createdAt: new Date(row.created_at_ms).toISOString(),
    startedAt: row.started_at_ms == null ? undefined : new Date(row.started_at_ms).toISOString(),
    completedAt: row.completed_at_ms == null ? undefined : new Date(row.completed_at_ms).toISOString(),
    activatedAt: row.activated_at_ms == null ? undefined : new Date(row.activated_at_ms).toISOString(),
  };
}

function optionalBoolean(value: number | null): boolean | undefined {
  return value === null ? undefined : value === 1;
}

function rowToSample(row: SampleRow): SmartTagLearningRunSample {
  return {
    runId: row.run_id,
    actionId: row.action_id,
    emailId: row.email_id,
    split: row.split === "validation" ? "validation" : "optimization",
    expectedAction: row.expected_action === "remove" ? "remove" : "apply",
    isNewFeedback: row.is_new_feedback === 1,
    currentMatched: optionalBoolean(row.current_matched),
    candidateMatched: optionalBoolean(row.candidate_matched),
    confirmationMatched: optionalBoolean(row.confirmation_matched),
    currentConfidence: row.current_confidence ?? undefined,
    candidateConfidence: row.candidate_confidence ?? undefined,
    confirmationConfidence: row.confirmation_confidence ?? undefined,
    errorCode: row.error_code ?? undefined,
    createdAt: new Date(row.created_at_ms).toISOString(),
    updatedAt: new Date(row.updated_at_ms).toISOString(),
  };
}

export class SmartTagLearningRunRepository {
  constructor(
    private readonly db: MailDatabase,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  create(input: {
    accountId: string;
    tagId: string;
    tagName: string;
    sourcePromptHash: string;
    activePromptHash: string;
    modelGeneration: number;
    model: string;
    sampleCount: number;
    positiveCount: number;
    negativeCount: number;
    optimizationCount: number;
    validationCount: number;
    leaseOwner?: string;
    leaseUntil?: string;
  }): SmartTagLearningRun {
    const id = `stlr-${randomUUID()}`;
    const now = this.now();
    const nowMs = parseTime(now);
    this.db.prepare(
      `INSERT INTO mail_smart_tag_learning_runs (
         public_id, account_id, tag_id, state, lease_owner, lease_expires_at_ms,
         source_prompt_hash, active_prompt_hash, model_generation, model_id,
         sample_count, positive_count, negative_count,
         optimization_count, validation_count, created_at_ms, started_at_ms
       ) SELECT @id, accounts.id, tags.id, 'generating', @leaseOwner, @leaseUntilMs,
         @sourcePromptHash, @activePromptHash, @modelGeneration, @model,
         @sampleCount, @positiveCount, @negativeCount,
         @optimizationCount, @validationCount, @nowMs, @nowMs
       FROM mail_accounts accounts JOIN mail_user_tags tags ON tags.account_id = accounts.id
       WHERE accounts.public_id = @accountId AND tags.public_id = @tagId`,
    ).run({
      id,
      ...input,
      leaseOwner: input.leaseOwner ?? "smart-tag-learning",
      leaseUntilMs: input.leaseUntil ? parseTime(input.leaseUntil) : nowMs + 24 * 60 * 60 * 1000,
      nowMs,
    });
    return this.getById(id)!;
  }

  expireLeases(accountId: string, at: string): number {
    return this.db.prepare(
      `UPDATE mail_smart_tag_learning_runs
          SET state = 'failed',
              reason = 'lease-expired',
              completed_at_ms = @atMs,
              lease_owner = NULL,
              lease_expires_at_ms = NULL
        WHERE account_id = (SELECT id FROM mail_accounts WHERE public_id = @accountId)
          AND state IN ('generating', 'evaluating')
          AND lease_expires_at_ms IS NOT NULL
          AND lease_expires_at_ms <= @atMs`,
    ).run({ accountId, atMs: parseTime(at) }).changes;
  }

  cancelForTag(accountId: string, tagId: string, reason = "tag-deleted"): number {
    const now = this.now();
    const nowMs = parseTime(now);
    return this.db.prepare(
      `UPDATE mail_smart_tag_learning_runs
          SET state = 'stale',
              reason = @reason,
              completed_at_ms = @nowMs,
              lease_owner = NULL,
              lease_expires_at_ms = NULL
        WHERE account_id = (SELECT id FROM mail_accounts WHERE public_id = @accountId)
          AND tag_id = (SELECT id FROM mail_user_tags WHERE public_id = @tagId)
          AND state IN ('generating', 'evaluating')`,
    ).run({ accountId, tagId, reason, nowMs }).changes;
  }

  addSample(input: {
    runId: string;
    actionId: string;
    emailId: string;
    split: SmartTagLearningSampleSplit;
    expectedAction: "apply" | "remove";
    isNewFeedback: boolean;
  }): void {
    const now = this.now();
    const nowMs = parseTime(now);
    this.db.prepare(
      `INSERT INTO mail_smart_tag_learning_samples (
         run_id, action_id, email_id, split, expected_action,
         is_new_feedback, created_at_ms, updated_at_ms
       ) SELECT runs.id, actions.id, messages.id, @storedSplit, @expectedAction,
         @isNewFeedback, @nowMs, @nowMs
       FROM mail_smart_tag_learning_runs runs
       JOIN mail_smart_tag_actions actions ON actions.public_id = @actionId
       JOIN mail_messages messages ON messages.public_id = @emailId
       WHERE runs.public_id = @runId`,
    ).run({
      ...input,
      storedSplit: input.split === "optimization" ? "train" : "validation",
      isNewFeedback: input.isNewFeedback ? 1 : 0,
      nowMs,
    });
  }

  setCandidate(input: {
    id: string;
    prompt: string;
    summary: Record<string, unknown>;
  }): SmartTagLearningRun | null {
    this.db.prepare(
      `UPDATE mail_smart_tag_learning_runs
          SET state = 'evaluating',
              candidate_prompt = @prompt,
              candidate_summary_json = @summary,
              reason = NULL
        WHERE public_id = @id AND state = 'generating'`,
    ).run({
      id: input.id,
      prompt: input.prompt,
      summary: JSON.stringify(input.summary),
    });
    return this.getById(input.id);
  }

  recordSampleResult(input: {
    runId: string;
    emailId: string;
    currentMatched?: boolean;
    candidateMatched?: boolean;
    confirmationMatched?: boolean;
    currentConfidence?: number;
    candidateConfidence?: number;
    confirmationConfidence?: number;
    errorCode?: string;
  }): void {
    const current = this.db.prepare(
      `${SAMPLE_SELECT}
        WHERE runs.public_id = @runId AND messages.public_id = @emailId`,
    ).get(input) as SampleRow | undefined;
    if (!current) return;
    const now = this.now();
    const nowMs = parseTime(now);
    this.db.prepare(
      `UPDATE mail_smart_tag_learning_samples
          SET current_matched = @currentMatched,
              candidate_matched = @candidateMatched,
              confirmation_matched = @confirmationMatched,
              current_confidence = @currentConfidence,
              candidate_confidence = @candidateConfidence,
              confirmation_confidence = @confirmationConfidence,
              error_code = @errorCode,
              updated_at_ms = @nowMs
        WHERE run_id = (SELECT id FROM mail_smart_tag_learning_runs WHERE public_id = @runId)
          AND message_id = (SELECT id FROM mail_messages WHERE public_id = @emailId)`,
    ).run({
      ...input,
      currentMatched: input.currentMatched === undefined
        ? current.current_matched
        : input.currentMatched ? 1 : 0,
      candidateMatched: input.candidateMatched === undefined
        ? current.candidate_matched
        : input.candidateMatched ? 1 : 0,
      confirmationMatched: input.confirmationMatched === undefined
        ? current.confirmation_matched
        : input.confirmationMatched ? 1 : 0,
      currentConfidence: input.currentConfidence ?? current.current_confidence,
      candidateConfidence: input.candidateConfidence ?? current.candidate_confidence,
      confirmationConfidence:
        input.confirmationConfidence ?? current.confirmation_confidence,
      errorCode: input.errorCode ?? current.error_code,
      nowMs,
    });
  }

  finish(input: {
    id: string;
    status: "activated" | "rejected" | "failed" | "stale";
    reason: string;
    currentCorrect?: number;
    candidateCorrect?: number;
    correctedCount?: number;
    regressionCount?: number;
  }): SmartTagLearningRun | null {
    const now = this.now();
    const nowMs = parseTime(now);
    this.db.prepare(
      `UPDATE mail_smart_tag_learning_runs
          SET state = @status,
              reason = @reason,
              current_correct = @currentCorrect,
              candidate_correct = @candidateCorrect,
              corrected_count = @correctedCount,
              regression_count = @regressionCount,
              completed_at_ms = @nowMs,
              activated_at_ms = CASE WHEN @status = 'activated' THEN @nowMs ELSE activated_at_ms END,
              lease_owner = NULL,
              lease_expires_at_ms = NULL
        WHERE public_id = @id`,
    ).run({
      ...input,
      currentCorrect: input.currentCorrect ?? 0,
      candidateCorrect: input.candidateCorrect ?? 0,
      correctedCount: input.correctedCount ?? 0,
      regressionCount: input.regressionCount ?? 0,
      nowMs,
    });
    return this.getById(input.id);
  }

  getById(id: string): SmartTagLearningRun | null {
    const row = this.db.prepare(
      `${RUN_SELECT} WHERE runs.public_id = ?`,
    ).get(id) as RunRow | undefined;
    return row ? rowToRun(row) : null;
  }

  getLatestForTag(accountId: string, tagId: string): SmartTagLearningRun | null {
    const row = this.db.prepare(
      `${RUN_SELECT}
        WHERE accounts.public_id = @accountId AND tags.public_id = @tagId
        ORDER BY runs.created_at_ms DESC, runs.id DESC
        LIMIT 1`,
    ).get({ accountId, tagId }) as RunRow | undefined;
    return row ? rowToRun(row) : null;
  }

  listByAccount(accountId: string, limit = 20): SmartTagLearningRun[] {
    const rows = this.db.prepare(
      `${RUN_SELECT}
        WHERE accounts.public_id = @accountId
        ORDER BY runs.created_at_ms DESC, runs.id DESC
        LIMIT @limit`,
    ).all({ accountId, limit: Math.max(1, Math.min(100, limit)) }) as RunRow[];
    return rows.map(rowToRun);
  }

  listSamples(runId: string): SmartTagLearningRunSample[] {
    const rows = this.db.prepare(
      `${SAMPLE_SELECT}
        WHERE runs.public_id = ?
        ORDER BY samples.split DESC, samples.created_at_ms ASC, messages.public_id ASC`,
    ).all(runId) as SampleRow[];
    return rows.map(rowToSample);
  }
}

function parseTime(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error("invalid-smart-tag-learning-time");
  return parsed;
}
