export type MailJobPriority = number;

export interface EnqueueMailJob {
  kind: string;
  accountId?: string;
  payload: unknown;
  priority: MailJobPriority;
  availableAt?: Date;
  maxAttempts?: number;
  idempotencyKey?: string;
  terminalPolicy?: "reuse" | "revive";
}

export interface MailJob {
  id: number;
  kind: string;
  accountId: string | null;
  payload: unknown;
  priority: MailJobPriority;
  attempts: number;
  maxAttempts: number;
  availableAt: string;
  leaseOwner: string | null;
  leaseUntil: string | null;
  idempotencyKey: string | null;
}

export interface ClaimMailJobFilter {
  accountId?: string;
  kinds?: readonly string[];
  priorities?: readonly MailJobPriority[];
  /** Claim only jobs whose priority is >= this value (lower = higher precedence). */
  minPriority?: number;
  subjectPublicId?: string;
  /** Claim newest received message first within one priority tier. */
  order?: "fifo" | "lifo";
}
