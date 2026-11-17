import type { IntelligenceJob } from "../../../shared/wemail/queue.js";

export type QueueJobHandler = (job: IntelligenceJob) => Promise<void>;

export interface QueueRunnerOptions {
  pollIntervalMs: number;
  jobTimeoutMs: number;
  maxConcurrentJobs?: number;
}
