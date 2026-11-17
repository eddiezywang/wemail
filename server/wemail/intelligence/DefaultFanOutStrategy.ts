/**
 * Default fan-out strategy for phase one.
 *
 * Received mail: summary(2) + tags(3) + todo(2) + replyDecision(3)
 * Sent mail:     tags(3), without summary or reply-waiting decisions
 * Pre-screened: summary(2) + tags(3) + replyDecision(1, will skip)
 *
 * replyDraft is NEVER pre-enqueued — ReplyDecisionProcessor
 * conditionally enqueues it when shouldReply=true.
 *
 * `replyDecisionEnabled` (default true) is the enqueue-side half of the
 * reply-decision master switch. The drain-side half lives in CanonicalAiWorker,
 * which skips `ai.reply-decision` claims when the switch is off. Both read the
 * same `WEMAIL_REPLY_DECISION_ENABLED` flag so a disabled capability produces
 * no new jobs AND stops draining pending ones.
 */

import type { FanOutStrategy, IntelligenceJobPlan } from "./FanOutStrategy.js";
import type { PrescreenResult } from "./LocalPrescreener.js";
import { isSentFolder } from "../../../shared/folders.js";

export class DefaultFanOutStrategy implements FanOutStrategy {
  private readonly replyDecisionEnabled: boolean;

  constructor(options: { replyDecisionEnabled?: boolean } = {}) {
    this.replyDecisionEnabled = options.replyDecisionEnabled ?? true;
  }

  plan(
    mail: { folder: string; from: { email: string }; headers?: Record<string, string> },
    prescreen: PrescreenResult,
  ): IntelligenceJobPlan[] {
    const jobs: IntelligenceJobPlan[] = [];
    if (!isSentFolder(mail.folder)) {
      jobs.push({ type: "summary", maxAttempts: 2 });
    }
    jobs.push({ type: "tags", maxAttempts: 3 });

    if (isSentFolder(mail.folder)) {
      return jobs;
    }

    jobs.push({ type: "todoExtraction", maxAttempts: 2 });

    if (this.replyDecisionEnabled) {
      if (prescreen.skipReply) {
        // Pre-screened mail: enqueue replyDecision with maxAttempts=1
        // so it gets a lightweight skip path without LLM call
        jobs.push({ type: "replyDecision", maxAttempts: 1 });
      } else {
        jobs.push({ type: "replyDecision", maxAttempts: 3 });
      }
    }

    return jobs;
  }
}
