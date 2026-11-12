import type {
  IntelligenceJobType,
  IntelligenceStatus,
} from "./intelligence.js";

/**
 * Legacy job shape used by pre-Package-C QueueRunner and tests.
 * New code should use {@link IntelligenceJob} from `intelligence.js`.
 */
export interface IntelligenceJob {
  id: string;
  accountId: string;
  emailId: string;
  processor: IntelligenceJobType;
  status: IntelligenceStatus;
  attempts: number;
  timeoutCount: number;
  lastError?: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt?: string | null;
}
