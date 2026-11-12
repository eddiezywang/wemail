import type {
  IntelligenceJob,
  IntelligenceJobType,
  IntelligenceResult,
  ProcessorWorkspaceContext,
} from "../../../shared/wemail/intelligence.js";
import type { MailMessage } from "../../../shared/wemail/mail.js";

/**
 * Context passed to every processor invocation. Includes just enough for
 * the processor to fetch the source message; the bus intentionally does
 * NOT carry the body through the payload, keeping job rows small and
 * logs body-free (Handoff §2).
 */
export interface ProcessorContext {
  /**
   * Re-fetches the normalized message for this job. Returns null if the
   * row was deleted between enqueue and dispatch — processors MUST treat
   * that as a soft failure and skip rather than throw.
   */
  getMessage(emailId: string): MailMessage | null;

  /**
   * Optional compiled workspace context derived from
   * `CapabilityDescriptor.workspaceInputs`. Empty/missing means the
   * user has no relevant workspace notes yet — processors fall back
   * to their default prompt behavior. The orchestrator wires this in
   * a later Route C batch; today this field is undefined for every
   * dispatch and prompt builders are byte-identical to before.
   */
  workspace?: ProcessorWorkspaceContext;
}

/**
 * Contract implemented by Packages E (summary), F (tags), and G
 * (replyDraft). Each processor owns exactly one `type`. The bus
 * looks up processors by `type` and invokes `handle` with a `ctx`
 * that lets them re-read the source message. Thrown errors are
 * caught by the QueueRunner and recorded as `last_error`.
 *
 * **Retryable classification (Package E contract).** A thrown error
 * MAY carry a boolean `retryable` field (e.g. `LlmClientError`,
 * `SummaryProcessorError`). When `retryable === false`, the
 * QueueRunner short-circuits the job to terminal `status='failed'`
 * without consuming further attempts. When `retryable === true` or
 * the field is absent, the runner follows the normal attempt-budget
 * retry loop.
 */
export type RetryableError = Error & { retryable?: boolean };

export interface MailIntelligenceProcessor {
  readonly type: IntelligenceJobType;
  handle(job: IntelligenceJob, ctx: ProcessorContext): Promise<IntelligenceResult>;
}
