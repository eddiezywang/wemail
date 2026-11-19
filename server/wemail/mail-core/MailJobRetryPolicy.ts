export const MAIL_JOB_MAX_ATTEMPTS = {
  bodyEnsure: 5,
  metadataSync: 6,
  remoteMutation: 8,
  send: 3,
  summary: 2,
  tags: 2,
  replyDecision: 3,
  attachmentFetch: 3,
  searchIndex: 3,
  automation: 3,
  notification: 3,
  maintenance: 1,
} as const;

export function maxAttemptsForMailJob(kind: string): number {
  if (kind === "mail.sent.archive") return 1;
  if (kind === "mail.body.ensure") return MAIL_JOB_MAX_ATTEMPTS.bodyEnsure;
  if (kind === "mail.metadata.sync") return MAIL_JOB_MAX_ATTEMPTS.metadataSync;
  if (kind === "mail.remote.mutation") return MAIL_JOB_MAX_ATTEMPTS.remoteMutation;
  if (kind === "mail.send") return MAIL_JOB_MAX_ATTEMPTS.send;
  if (kind === "ai.summary") return MAIL_JOB_MAX_ATTEMPTS.summary;
  if (kind === "ai.tags") return MAIL_JOB_MAX_ATTEMPTS.tags;
  if (kind === "ai.reply-decision") return MAIL_JOB_MAX_ATTEMPTS.replyDecision;
  if (kind === "ai.todo") return 2;
  if (kind === "mail.attachment.fetch") return MAIL_JOB_MAX_ATTEMPTS.attachmentFetch;
  if (kind.startsWith("search.index")) return MAIL_JOB_MAX_ATTEMPTS.searchIndex;
  if (kind.startsWith("automation.")) return MAIL_JOB_MAX_ATTEMPTS.automation;
  if (kind.startsWith("notification.")) return MAIL_JOB_MAX_ATTEMPTS.notification;
  if (kind.startsWith("maintenance.")) return MAIL_JOB_MAX_ATTEMPTS.maintenance;
  throw new Error(`mail-job-retry-policy-missing:${kind}`);
}

/**
 * Stable body-fetch error codes. The renderer/DB store these on the terminal
 * job (`last_error_code`) and on the content row; background reconcile uses
 * them to decide whether a missing body should be retried.
 *
 *   mail-body-too-large      — RFC822 source exceeds the fetch cap. Permanent:
 *                              re-fetching will never succeed, so never revive.
 *   mail-body-item-missing   — provider could not find the message (UIDVALIDITY
 *                              drift / UID expunged / empty fetch). Permanent
 *                              for periodic-revive purposes; self-corrects when
 *                              the next metadata sync re-establishes the UID or
 *                              removes the stale row.
 *   mail-body-uid-invalid    — reserved (UIDVALIDITY mismatch reported as item
 *                              above until the provider distinguishes it).
 *   mail-body-credential     — auth failure. Recoverable only after re-login,
 *                              so do not revive periodically.
 *   mail-body-fetch-failed   — connection/throttling/protocol. Recoverable.
 */
const PERMANENT_BODY_ERROR_CODES = new Set([
  "mail-body-too-large",
  "mail-body-item-missing",
  "mail-body-uid-invalid",
]);

export function isPermanentBodyError(code: string | null | undefined): boolean {
  return !!code && PERMANENT_BODY_ERROR_CODES.has(code);
}

/**
 * Whether background body reconcile must NOT periodically revive a terminal
 * body job with this code. Permanent failures never revive; credential
 * failures wait for an explicit re-login instead of periodic retry.
 */
export function shouldSkipPeriodicBodyRevive(code: string | null | undefined): boolean {
  return isPermanentBodyError(code) || code === "mail-body-credential";
}
