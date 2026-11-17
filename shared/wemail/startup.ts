export type StartupPhase =
  | "local-ready"
  | "recent-metadata"
  | "interactive"
  | "historical-metadata"
  | "bodies"
  | "intelligence"
  | "settled"
  | "paused"
  | "recoverable-failure"
  | "stopped";

export type StartupRunStatus =
  | "idle"
  | "running"
  | "paused"
  | "settled"
  | "failed"
  | "stopped";

export type MailSyncOrigin =
  | "bootstrap"
  | "historical"
  | "manual"
  | "live-idle"
  | "live-poll";

export type MailProviderRole =
  | "foreground-realtime"
  | "interactive-transfer"
  | "background-transfer";

export interface MailRefreshIntent {
  accountId: string;
  origin: "manual";
}

export interface MailRefreshResult {
  accountId: string;
  runId: string;
  disposition: "accepted" | "joined";
  status: "completed";
  changed: boolean;
  completedAt: string;
}

export type MailDiscoveryOrigin =
  | "bootstrap"
  | "historical"
  | "manual"
  | "live-idle"
  | "live-poll";

export interface MailDiscoveryPolicy {
  refreshRenderer: boolean;
  automationEligible: boolean;
  desktopNotificationEligible: boolean;
}

export interface MailDiscoveryResult {
  accountId: string;
  origin: MailDiscoveryOrigin;
  messageIds: string[];
  firstDiscoveryCount: number;
  policy: MailDiscoveryPolicy;
}

export interface MailSynchronizationHealth {
  state: "healthy" | "reconnecting" | "credential-required" | "stale";
  realtime: boolean;
  lastSuccessfulAt: string | null;
  reconnectAttempts: number;
}

export type WorkloadClass = "interactive" | "live" | "background";

export type ResourceThrottleReason =
  | "cpu-high"
  | "memory-high"
  | "event-loop-high"
  | null;

export interface StartupProgress {
  inserted: number;
  updated: number;
  processed: number;
  pendingBodies: number;
  pendingIntelligence: number;
}

export interface ResourceMetrics {
  sampledAt: string;
  cpuPercent: number;
  workingSetBytes: number;
  heapUsedBytes: number;
  eventLoopP95Ms: number;
  queueDepth: number;
  activeProviderWork: number;
}

export interface ResourceGovernorThresholds {
  backgroundCpuTargetPercent: number;
  syncCpuTargetPercent: number;
  cpuSuspendPercent: number;
  cpuResumePercent: number;
  memoryHighWaterBytes: number;
  memoryLowWaterBytes: number;
  firstSyncGrowthBudgetBytes: number;
  firstSyncGrowthResumeBudgetBytes: number;
  eventLoopSuspendMs: number;
  eventLoopResumeMs: number;
  cooldownMs: number;
}

export interface ResourceGovernorState {
  backgroundPaused: boolean;
  throttleReason: ResourceThrottleReason;
  pausedAt: string | null;
  metrics: ResourceMetrics;
  thresholds: ResourceGovernorThresholds;
}

export interface StartupSyncStatus {
  accountId: string;
  runId: string | null;
  phase: StartupPhase;
  status: StartupRunStatus;
  origin: MailSyncOrigin;
  startedAt: string | null;
  updatedAt: string;
  interactiveAt: string | null;
  settledAt: string | null;
  progress: StartupProgress;
  pausedReason: ResourceThrottleReason;
  errorCode: string | null;
  resource: ResourceGovernorState;
}

export interface AggregatedMailChangeEvent {
  accountId: string;
  origin: MailSyncOrigin;
  insertedIds: string[];
  insertedCount: number;
}

export interface PerformanceDiagnosticEvent {
  kind: "renderer-long-task" | "renderer-unresponsive";
  observedAt: string;
  durationMs: number;
  /**
   * performance.now()-epoch start of the long task / unresponsive window.
   * Shares the same clock as React Profiler `startTime`, so a long-task can be
   * matched to the [render-trace] boundary that rendered during it.
   */
  startMs?: number;
  phase?: StartupPhase;
}
