/**
 * Fan-out strategy determines which intelligence jobs to enqueue for a
 * new mail message. The default strategy enqueues summary + tags +
 * replyDecision in parallel; replyDraft is conditionally enqueued later
 * by ReplyDecisionProcessor when shouldReply=true.
 */

import type { IntelligenceJobType } from "../../../shared/wemail/intelligence.js";
import type { PrescreenResult } from "./LocalPrescreener.js";

export interface IntelligenceJobPlan {
  type: IntelligenceJobType;
  maxAttempts: number;
  /** If set, only enqueue after this job type succeeds */
  dependsOn?: IntelligenceJobType;
}

export interface FanOutStrategy {
  plan(
    mail: { folder: string; from: { email: string }; headers?: Record<string, string> },
    prescreenResult: PrescreenResult,
  ): IntelligenceJobPlan[];
}
