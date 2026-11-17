import { randomUUID } from "node:crypto";
import type {
  IntelligenceJob as NewIntelligenceJob,
  IntelligenceJobType,
  IntelligenceStatus,
} from "../../../shared/wemail/intelligence.js";
import type { IntelligenceJob } from "../../../shared/wemail/queue.js";
import type { MailDatabase } from "../database/Database.js";

interface JobRow {
  id: string;
  account_id: string;
  email_id: string;
  processor: IntelligenceJobType;
  status: string;
  payload_json: string;
  attempts: number;
  max_attempts: number;
  error: string | null;
  lease_until_ms: number | null;
  created_at_ms: number;
  updated_at_ms: number;
  available_at_ms: number;
}

interface RecoveryMetadata {
  failureClass?: SummaryFailureClass;
  recoveryAttempts?: number;
  nextRetryAt?: string;
  reason?: string;
  processorVersion?: string;
}

const JOB_SELECT = `SELECT jobs.public_id AS id,
  accounts.public_id AS account_id, jobs.subject_public_id AS email_id,
  jobs.job_kind AS processor, jobs.state AS status, jobs.payload_json,
  jobs.attempt_count AS attempts, jobs.max_attempts,
  jobs.last_error_code AS error, jobs.lease_expires_at_ms AS lease_until_ms,
  jobs.created_at_ms, jobs.updated_at_ms, jobs.available_at_ms
  FROM mail_jobs jobs JOIN mail_accounts accounts ON accounts.id = jobs.account_id`;

export type SummaryFailureClass =
  | "transient"
  | "content-recoverable"
  | "configuration"
  | "parked";

export interface SummaryRecoveryJob {
  id: string;
  accountId: string;
  emailId: string;
  error?: string;
  failureClass?: SummaryFailureClass;
  recoveryAttempts: number;
  nextRetryAt?: string;
}

export interface EnqueueJobInput {
  emailId: string;
  type: IntelligenceJobType;
  accountId: string;
  maxAttempts?: number;
  payload?: Record<string, unknown>;
  createdAt?: string;
}

export type IntelligenceJobLookup = Pick<
  NewIntelligenceJob,
  "id" | "status" | "attempts" | "maxAttempts"
> & Partial<NewIntelligenceJob>;

export class JobRepository {
  private readonly workAvailableListeners = new Set<() => void>();

  constructor(
    private readonly db: MailDatabase,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  onWorkAvailable(listener: () => void): () => void {
    this.workAvailableListeners.add(listener);
    return () => this.workAvailableListeners.delete(listener);
  }

  private notifyWorkAvailable(): void {
    for (const listener of this.workAvailableListeners) listener();
  }

  insert(job: IntelligenceJob): void {
    const createdAtMs = parseTime(job.createdAt);
    const updatedAtMs = parseTime(job.updatedAt);
    this.db.prepare(`INSERT INTO mail_jobs (
      public_id, account_id, job_kind, subject_kind, subject_public_id,
      dedupe_key, payload_json, priority, state, attempt_count, max_attempts,
      available_at_ms, input_version, last_error_code,
      created_at_ms, updated_at_ms, row_version
    ) SELECT @id, accounts.id, @processor, 'message', @emailId,
      @dedupeKey, '{}', 0, @state, @attempts, 3,
      @updatedAtMs, 1, @error, @createdAtMs, @updatedAtMs, 1
      FROM mail_accounts accounts WHERE accounts.public_id = @accountId`).run({
      ...job,
      dedupeKey: job.emailId,
      state: stateFromStatus(job.status),
      error: job.lastError ?? null,
      createdAtMs,
      updatedAtMs,
    });
    if (job.status === "pending") this.notifyWorkAvailable();
  }

  enqueueJob(input: EnqueueJobInput): { id: string; inserted: boolean } {
    const existing = this.findByEmailAndType(input.emailId, input.type);
    if (existing) return { id: existing.id, inserted: false };
    const id = `job-${randomUUID()}`;
    const nowMs = parseTime(input.createdAt ?? this.now());
    const info = this.db.prepare(`INSERT INTO mail_jobs (
      public_id, account_id, job_kind, subject_kind, subject_public_id,
      dedupe_key, payload_json, priority, state, attempt_count, max_attempts,
      available_at_ms, input_version, created_at_ms, updated_at_ms, row_version
    ) SELECT @id, accounts.id, @type, 'message', @emailId, @emailId,
      @payloadJson, 0, 'pending', 0, @maxAttempts, @nowMs, 1, @nowMs, @nowMs, 1
      FROM mail_accounts accounts WHERE accounts.public_id = @accountId
      ON CONFLICT(job_kind, dedupe_key, input_version) DO NOTHING`).run({
      id,
      accountId: input.accountId,
      emailId: input.emailId,
      type: input.type,
      payloadJson: JSON.stringify(input.payload ?? {}),
      maxAttempts: input.maxAttempts ?? 3,
      nowMs,
    });
    if (info.changes === 0) {
      const raced = this.findByEmailAndType(input.emailId, input.type);
      if (raced) return { id: raced.id, inserted: false };
      throw new Error("canonical-job-account-missing");
    }
    this.notifyWorkAvailable();
    return { id, inserted: true };
  }

  enqueueOrResetJob(input: EnqueueJobInput): { id: string; inserted: boolean; reset: boolean } {
    const existing = this.findByEmailAndType(input.emailId, input.type);
    if (!existing) return { ...this.enqueueJob(input), reset: false };
    const nowMs = parseTime(input.createdAt ?? this.now());
    this.db.prepare(`UPDATE mail_jobs SET
      account_id = (SELECT id FROM mail_accounts WHERE public_id = @accountId),
      state = 'pending', attempt_count = 0, last_error_code = NULL,
      lease_owner = NULL, lease_expires_at_ms = NULL,
      payload_json = @payloadJson, max_attempts = @maxAttempts,
      available_at_ms = @nowMs, created_at_ms = @nowMs,
      updated_at_ms = @nowMs, row_version = row_version + 1
      WHERE public_id = @id`).run({
      id: existing.id,
      accountId: input.accountId,
      payloadJson: JSON.stringify(input.payload ?? {}),
      maxAttempts: input.maxAttempts ?? existing.maxAttempts ?? 3,
      nowMs,
    });
    this.notifyWorkAvailable();
    return { id: existing.id, inserted: false, reset: true };
  }

  findByEmailAndType(emailId: string, type: IntelligenceJobType): IntelligenceJobLookup | null {
    const row = this.db.prepare(`${JOB_SELECT}
      WHERE jobs.subject_kind = 'message' AND jobs.subject_public_id = ?
        AND jobs.job_kind = ? ORDER BY jobs.input_version DESC LIMIT 1`).get(emailId, type) as JobRow | undefined;
    return row ? toNewJob(row) : null;
  }

  findPendingByEmailAndType(emailId: string, type: IntelligenceJobType): { id: string; status: IntelligenceStatus } | null {
    return this.findByEmailAndType(emailId, type);
  }

  listPendingJobs(limit = 10): NewIntelligenceJob[] {
    const rows = this.db.prepare(`${JOB_SELECT}
      WHERE jobs.state = 'pending' AND jobs.attempt_count < jobs.max_attempts
        AND jobs.available_at_ms <= ?
      ORDER BY jobs.created_at_ms DESC, jobs.id DESC LIMIT ?`).all(parseTime(this.now()), limit) as JobRow[];
    return rows.map(toNewJob);
  }

  nextPendingAt(): number | null {
    const row = this.db.prepare(`SELECT MIN(available_at_ms) AS due_at
      FROM mail_jobs WHERE state = 'pending' AND attempt_count < max_attempts`).get() as { due_at: number | null };
    return row.due_at ?? null;
  }

  getJobById(id: string): NewIntelligenceJob | null {
    const row = this.db.prepare(`${JOB_SELECT} WHERE jobs.public_id = ?`).get(id) as JobRow | undefined;
    return row ? toNewJob(row) : null;
  }

  listDueSummaryRecoveryJobs(accountId: string, limit = 50): SummaryRecoveryJob[] {
    const nowMs = parseTime(this.now());
    const rows = this.db.prepare(`${JOB_SELECT}
      WHERE accounts.public_id = @accountId AND jobs.job_kind = 'summary'
        AND jobs.state = 'failed' AND jobs.available_at_ms <= @nowMs
      ORDER BY jobs.available_at_ms ASC, jobs.created_at_ms DESC LIMIT @limit`).all({
      accountId,
      nowMs,
      limit: Math.max(1, limit),
    }) as JobRow[];
    return rows.map((row) => {
      const recovery = recoveryFromPayload(row.payload_json);
      return {
        id: row.id,
        accountId: row.account_id,
        emailId: row.email_id,
        ...(row.error ? { error: row.error } : {}),
        ...(recovery.failureClass ? { failureClass: recovery.failureClass } : {}),
        recoveryAttempts: recovery.recoveryAttempts ?? 0,
        ...(recovery.nextRetryAt ? { nextRetryAt: recovery.nextRetryAt } : {}),
      };
    }).filter((job) => job.failureClass !== "configuration");
  }

  scheduleSummaryRecovery(input: {
    id: string;
    failureClass: SummaryFailureClass;
    nextRetryAt: string | null;
    reason?: string;
    processorVersion?: string;
  }): void {
    const row = this.rawById(input.id);
    if (!row || row.processor !== "summary") return;
    const current = recoveryFromPayload(row.payload_json);
    const recovery: RecoveryMetadata = {
      failureClass: input.failureClass,
      recoveryAttempts: (current.recoveryAttempts ?? 0) + 1,
      ...(input.nextRetryAt ? { nextRetryAt: input.nextRetryAt } : {}),
      ...(input.reason ? { reason: input.reason } : {}),
      ...(input.processorVersion ? { processorVersion: input.processorVersion } : {}),
    };
    this.updatePayloadAndAvailability(row, recovery, input.nextRetryAt ? parseTime(input.nextRetryAt) : parseTime(this.now()));
  }

  resetForAutomaticRecovery(id: string, payload?: Record<string, unknown>): void {
    this.reset(id, payload ?? {}, false);
  }

  nextPending(): IntelligenceJob | null {
    const row = this.db.prepare(`${JOB_SELECT}
      WHERE jobs.state = 'pending' AND jobs.attempt_count < jobs.max_attempts
        AND jobs.available_at_ms <= ?
      ORDER BY jobs.created_at_ms DESC, jobs.id DESC LIMIT 1`).get(parseTime(this.now())) as JobRow | undefined;
    return row ? toLegacyJob(row) : null;
  }

  markRunning(id: string): void { this.markJobRunning(id); }

  markJobRunning(id: string, jobTimeoutMs = 60_000): void {
    const nowMs = parseTime(this.now());
    this.db.prepare(`UPDATE mail_jobs SET state = 'leased', attempt_count = attempt_count + 1,
      lease_owner = 'local-intelligence', lease_expires_at_ms = @leaseUntilMs,
      updated_at_ms = @nowMs, row_version = row_version + 1 WHERE public_id = @id`).run({
      id,
      nowMs,
      leaseUntilMs: nowMs + jobTimeoutMs,
    });
  }

  reclaimExpired(now: string): number {
    const nowMs = parseTime(now);
    return this.db.prepare(`UPDATE mail_jobs SET state = 'pending', lease_owner = NULL,
      lease_expires_at_ms = NULL, available_at_ms = @nowMs,
      updated_at_ms = @nowMs, row_version = row_version + 1
      WHERE state = 'leased' AND lease_expires_at_ms IS NOT NULL AND lease_expires_at_ms < @nowMs`).run({ nowMs }).changes;
  }

  markSucceeded(id: string): void { this.markJobSucceeded(id); }

  markJobSucceeded(id: string): void {
    this.setTerminalState(id, "succeeded", null);
  }

  markFailed(id: string, error: string): void { this.markJobFailed(id, error); }

  markJobFailed(id: string, error: string): void {
    this.setTerminalState(id, "failed", error);
  }

  markJobSkipped(id: string, reason: string): void {
    this.setTerminalState(id, "terminal", reason);
  }

  requeuePending(id: string): void {
    const nowMs = parseTime(this.now());
    this.db.prepare(`UPDATE mail_jobs SET state = 'pending', available_at_ms = @nowMs,
      lease_owner = NULL, lease_expires_at_ms = NULL, updated_at_ms = @nowMs,
      row_version = row_version + 1 WHERE public_id = @id`).run({ id, nowMs });
    this.notifyWorkAvailable();
  }

  resetForManualRetry(id: string): void {
    this.reset(id, undefined, true);
  }

  recordAttemptError(id: string, error: string, opts?: { delayMs?: number; preserveAttempt?: boolean }): void {
    const nowMs = parseTime(this.now());
    this.db.prepare(`UPDATE mail_jobs SET state = 'pending', last_error_code = @error,
      lease_owner = NULL, lease_expires_at_ms = NULL,
      attempt_count = CASE WHEN @preserveAttempt = 1 AND attempt_count > 0
        THEN attempt_count - 1 ELSE attempt_count END,
      available_at_ms = @availableAtMs, updated_at_ms = @nowMs,
      row_version = row_version + 1 WHERE public_id = @id`).run({
      id,
      error: boundedError(error),
      preserveAttempt: opts?.preserveAttempt ? 1 : 0,
      availableAtMs: nowMs + Math.max(0, opts?.delayMs ?? 0),
      nowMs,
    });
    this.notifyWorkAvailable();
  }

  private rawById(id: string): JobRow | null {
    return this.db.prepare(`${JOB_SELECT} WHERE jobs.public_id = ?`).get(id) as JobRow | undefined ?? null;
  }

  private updatePayloadAndAvailability(row: JobRow, recovery: RecoveryMetadata, availableAtMs: number): void {
    const payload = parsePayloadObject(row.payload_json);
    payload.__wemailQueue = recovery;
    const nowMs = parseTime(this.now());
    this.db.prepare(`UPDATE mail_jobs SET payload_json = @payloadJson,
      available_at_ms = @availableAtMs, updated_at_ms = @nowMs,
      row_version = row_version + 1 WHERE public_id = @id`).run({
      id: row.id,
      payloadJson: JSON.stringify(payload),
      availableAtMs,
      nowMs,
    });
  }

  private reset(id: string, payload: Record<string, unknown> | undefined, clearRecovery: boolean): void {
    const row = this.rawById(id);
    if (!row) return;
    const nextPayload = payload ?? parsePayloadObject(row.payload_json);
    if (clearRecovery) delete nextPayload.__wemailQueue;
    const nowMs = parseTime(this.now());
    this.db.prepare(`UPDATE mail_jobs SET state = 'pending', attempt_count = 0,
      last_error_code = NULL, lease_owner = NULL, lease_expires_at_ms = NULL,
      payload_json = @payloadJson, available_at_ms = @nowMs,
      updated_at_ms = @nowMs, row_version = row_version + 1
      WHERE public_id = @id`).run({ id, payloadJson: JSON.stringify(nextPayload), nowMs });
    this.notifyWorkAvailable();
  }

  private setTerminalState(id: string, state: "succeeded" | "failed" | "terminal", error: string | null): void {
    const nowMs = parseTime(this.now());
    this.db.prepare(`UPDATE mail_jobs SET state = @state, last_error_code = @error,
      lease_owner = NULL, lease_expires_at_ms = NULL,
      updated_at_ms = @nowMs, row_version = row_version + 1 WHERE public_id = @id`).run({
      id,
      state,
      error: error ? boundedError(error) : null,
      nowMs,
    });
  }
}

function stateFromStatus(status: IntelligenceStatus): string {
  if (status === "running") return "leased";
  if (status === "skipped") return "terminal";
  return status;
}

function statusFromState(state: string): IntelligenceStatus {
  if (state === "leased") return "running";
  if (state === "terminal" || state === "cancelled") return "skipped";
  if (state === "pending" || state === "succeeded" || state === "failed") return state;
  return "failed";
}

function toNewJob(row: JobRow): NewIntelligenceJob {
  const job: NewIntelligenceJob = {
    id: row.id,
    emailId: row.email_id,
    type: row.processor,
    status: statusFromState(row.status),
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    createdAt: new Date(row.created_at_ms).toISOString(),
    updatedAt: new Date(row.updated_at_ms).toISOString(),
  };
  const payload = parsePayloadObject(row.payload_json);
  delete payload.__wemailQueue;
  if (Object.keys(payload).length > 0) job.payload = payload;
  if (row.status === "leased") job.startedAt = new Date(row.updated_at_ms).toISOString();
  if (["succeeded", "failed", "terminal", "cancelled"].includes(row.status)) {
    job.finishedAt = new Date(row.updated_at_ms).toISOString();
  }
  if (row.error) job.error = row.error;
  return job;
}

function toLegacyJob(row: JobRow): IntelligenceJob {
  const current = toNewJob(row);
  return {
    id: current.id,
    accountId: row.account_id,
    emailId: current.emailId,
    processor: current.type,
    status: current.status,
    attempts: current.attempts,
    timeoutCount: 0,
    ...(current.error ? { lastError: current.error } : {}),
    createdAt: current.createdAt,
    updatedAt: current.updatedAt,
    ...(current.finishedAt ? { completedAt: current.finishedAt } : {}),
  };
}

function parsePayloadObject(json: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(json) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? { ...(parsed as Record<string, unknown>) }
      : {};
  } catch {
    return {};
  }
}

function recoveryFromPayload(json: string): RecoveryMetadata {
  const value = parsePayloadObject(json).__wemailQueue;
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as RecoveryMetadata
    : {};
}

function parseTime(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error("invalid-job-time");
  return parsed;
}

function boundedError(error: string): string {
  return error.trim().slice(0, 512) || "job-failed";
}

export { toNewJob };
