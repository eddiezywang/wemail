/**
 * Self-describing intelligence capability. Each capability (summary, tags,
 * replyDecision, replyDraft, todoExtraction, linkExtraction, translation,
 * composeMail) registers one descriptor with the CapabilityRegistry. The
 * orchestrator uses this to build fan-out plans and dispatch jobs without
 * hardcoding capability metadata.
 *
 * Route C / Batch 1A extends the descriptor with curated metadata
 * (`id`, `displayName`, `promptVersion`, `modelPolicy`, `qualityGate`,
 * `safeToAutoRun`, `workspaceInputs`) so observability, settings UI,
 * and the future curator runtime can describe a capability without a
 * second source of truth.
 */

import type { IntelligenceJobType } from "../../../shared/wemail/intelligence.js";
import type { MailIntelligenceProcessor } from "./MailIntelligenceProcessor.js";

/** Shared dependencies available to all processor factories. */
export interface ProcessorDeps {
  /** LLM client — undefined when not configured (capabilities that require LLM will skip) */
  llmClient?: import("../ai/LlmClient.js").LlmClient;
  mailRepo: import("../mail/CanonicalMailRepository.js").CanonicalMailRepository;
  resultRepo: import("./IntelligenceResultRepository.js").IntelligenceResultRepository;
  jobRepo: import("../queue/JobRepository.js").JobRepository;
  feedbackRepo?: import("../feedback/TagFeedbackRuleRepository.js").TagFeedbackRuleRepository;
  logger: import("../telemetry/AppLogger.js").AppLogger;
}

/**
 * Model selection policy for a capability. `deterministic` capabilities
 * never call the LLM; `lane` capabilities are routed to one of the three
 * configured model lanes (summary / draft / agent) at dispatch time.
 */
export type CapabilityModelPolicy =
  | { kind: "lane"; lane: "summary" | "draft" | "agent" }
  | { kind: "deterministic" };

export interface CapabilityDescriptor {
  /** Unique capability identifier matching an IntelligenceJobType */
  type: IntelligenceJobType;

  /** Factory that creates the processor for this capability */
  createProcessor(deps: ProcessorDeps): MailIntelligenceProcessor;

  /** Per-capability queue lane configuration */
  lane: {
    maxAttempts: number;
    timeoutMs: number;
  };

  /** Whether this capability requires an LLM client */
  requiresLlm: boolean;

  /** Whether local pre-screening can suppress this capability */
  prescreenable: boolean;

  /**
   * Stable human-readable identifier; equals `type` for now but kept
   * distinct so a future rename of `type` doesn't break observability/UX.
   */
  id: string;

  /** Display name shown in settings/insights UIs. */
  displayName: string;

  /** Prompt-template version. Bump when prompt text or contract changes. */
  promptVersion: number;

  /** Model selection policy. "deterministic" means no LLM. */
  modelPolicy: CapabilityModelPolicy;

  /**
   * Identifier of the quality eval suite that gates this capability.
   * Capabilities without quality eval pass `null`.
   */
  qualityGate: string | null;

  /**
   * Whether this capability can run without explicit user confirmation
   * on a new email. Today every capability is `true`; reserved for
   * future high-risk capabilities.
   */
  safeToAutoRun: boolean;

  /**
   * Workspace files this capability reads (relative to
   * `<workspace>/<account>/`). Empty array today (Route C populates later).
   */
  workspaceInputs: string[];
}
