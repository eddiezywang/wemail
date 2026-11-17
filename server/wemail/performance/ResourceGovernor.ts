import os from "node:os";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import type {
  ResourceGovernorState,
  ResourceGovernorThresholds,
  ResourceMetrics,
  ResourceThrottleReason,
  WorkloadClass,
} from "../../../shared/wemail/startup.js";
import type { AppLogger } from "../telemetry/AppLogger.js";

const MIB = 1024 * 1024;

export const DEFAULT_RESOURCE_THRESHOLDS: ResourceGovernorThresholds = {
  backgroundCpuTargetPercent: 10,
  syncCpuTargetPercent: 20,
  // Pause background work before the 30% delivery ceiling, leaving headroom
  // for the next sampling interval and for foreground interaction.
  cpuSuspendPercent: 25,
  cpuResumePercent: 15,
  memoryHighWaterBytes: 600 * MIB,
  memoryLowWaterBytes: 500 * MIB,
  firstSyncGrowthBudgetBytes: 200 * MIB,
  firstSyncGrowthResumeBudgetBytes: 150 * MIB,
  eventLoopSuspendMs: 200,
  eventLoopResumeMs: 100,
  cooldownMs: 15_000,
};

export interface ResourceGovernorOptions {
  logger?: AppLogger;
  thresholds?: Partial<ResourceGovernorThresholds>;
  sampleIntervalMs?: number;
  now?: () => Date;
  memoryUsage?: () => NodeJS.MemoryUsage;
  cpuUsage?: () => NodeJS.CpuUsage;
  cpuCount?: number;
  /**
   * Called on every background pause/resume transition, so callers can surface
   * resource throttling to a unified log (e.g. the boot/startup.log) across
   * processes. This complements `logger` (AppLogger) for environments that do
   * not have an AppLogger wired to the same sink.
   */
  onTransition?: (
    transition: "paused" | "resumed",
    reason: ResourceThrottleReason,
    metrics: ResourceMetrics,
  ) => void;
}

export class ResourceGovernor {
  private readonly logger?: AppLogger;
  private readonly onTransition?: NonNullable<ResourceGovernorOptions["onTransition"]>;
  private readonly thresholds: ResourceGovernorThresholds;
  private readonly sampleIntervalMs: number;
  private readonly now: () => Date;
  private readonly memoryUsage: () => NodeJS.MemoryUsage;
  private readonly cpuUsage: () => NodeJS.CpuUsage;
  private readonly cpuCount: number;
  private readonly histogram = monitorEventLoopDelay({ resolution: 20 });
  private readonly waiters = new Set<() => void>();
  private timer: NodeJS.Timeout | null = null;
  private lastCpu: NodeJS.CpuUsage;
  private lastSampleAt: number;
  private pausedAtMs: number | null = null;
  private queueDepth = 0;
  private activeProviderWork = 0;
  private foregroundActiveUntilMs = 0;
  private foregroundResumeTimer: NodeJS.Timeout | null = null;
  private state: ResourceGovernorState;
  private readonly baselineWorkingSetBytes: number;
  private readonly recentCpuPercent: number[] = [];

  constructor(options: ResourceGovernorOptions = {}) {
    this.logger = options.logger;
    this.onTransition = options.onTransition;
    this.thresholds = { ...DEFAULT_RESOURCE_THRESHOLDS, ...options.thresholds };
    this.sampleIntervalMs = Math.max(100, options.sampleIntervalMs ?? 1_000);
    this.now = options.now ?? (() => new Date());
    this.memoryUsage = options.memoryUsage ?? (() => process.memoryUsage());
    this.cpuUsage = options.cpuUsage ?? (() => process.cpuUsage());
    this.cpuCount = Math.max(1, options.cpuCount ?? os.cpus().length);
    this.baselineWorkingSetBytes = this.memoryUsage().rss;
    this.lastCpu = this.cpuUsage();
    this.lastSampleAt = performance.now();
    this.state = {
      backgroundPaused: false,
      throttleReason: null,
      pausedAt: null,
      metrics: this.emptyMetrics(),
      thresholds: this.thresholds,
    };
  }

  start(): void {
    if (this.timer) return;
    this.histogram.enable();
    this.timer = setInterval(() => this.sampleNow(), this.sampleIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.foregroundResumeTimer) clearTimeout(this.foregroundResumeTimer);
    this.timer = null;
    this.foregroundResumeTimer = null;
    this.histogram.disable();
    for (const resolve of this.waiters) resolve();
    this.waiters.clear();
  }

  setQueueDepth(queueDepth: number): void {
    this.queueDepth = Math.max(0, Math.floor(queueDepth));
  }

  markForegroundActivity(durationMs = 1_500): void {
    const delayMs = Math.max(0, Math.floor(durationMs));
    this.foregroundActiveUntilMs = Math.max(
      this.foregroundActiveUntilMs,
      this.now().getTime() + delayMs,
    );
    if (this.foregroundResumeTimer) clearTimeout(this.foregroundResumeTimer);
    this.foregroundResumeTimer = setTimeout(() => {
      this.foregroundResumeTimer = null;
      for (const resolve of this.waiters) resolve();
      this.waiters.clear();
    }, Math.max(0, this.foregroundActiveUntilMs - this.now().getTime()));
    this.foregroundResumeTimer.unref?.();
  }

  beginProviderWork(): () => void {
    this.activeProviderWork += 1;
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      this.activeProviderWork = Math.max(0, this.activeProviderWork - 1);
    };
  }

  getState(): ResourceGovernorState {
    return {
      ...this.state,
      metrics: { ...this.state.metrics },
      thresholds: { ...this.state.thresholds },
    };
  }

  canRun(workload: WorkloadClass): boolean {
    return workload !== "background" || (
      !this.state.backgroundPaused && this.now().getTime() >= this.foregroundActiveUntilMs
    );
  }

  async waitForAdmission(
    workload: WorkloadClass,
    signal?: AbortSignal,
  ): Promise<boolean> {
    while (!this.canRun(workload)) {
      if (signal?.aborted) return false;
      await new Promise<void>((resolve) => {
        const finish = () => {
          this.waiters.delete(finish);
          signal?.removeEventListener("abort", finish);
          resolve();
        };
        this.waiters.add(finish);
        signal?.addEventListener("abort", finish, { once: true });
      });
    }
    return !signal?.aborted;
  }

  sampleNow(overrides: Partial<ResourceMetrics> = {}): ResourceGovernorState {
    const nowDate = this.now();
    const nowMs = performance.now();
    const elapsedMicros = Math.max(1, (nowMs - this.lastSampleAt) * 1_000);
    const currentCpu = this.cpuUsage();
    const usedMicros =
      currentCpu.user - this.lastCpu.user + currentCpu.system - this.lastCpu.system;
    const memory = this.memoryUsage();
    const measured: ResourceMetrics = {
      sampledAt: nowDate.toISOString(),
      cpuPercent: Math.max(0, (usedMicros / elapsedMicros / this.cpuCount) * 100),
      workingSetBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      eventLoopP95Ms: this.histogram.percentile(95) / 1_000_000 || 0,
      queueDepth: this.queueDepth,
      activeProviderWork: this.activeProviderWork,
      ...overrides,
    };
    this.lastCpu = currentCpu;
    this.lastSampleAt = nowMs;
    this.histogram.reset();
    this.recentCpuPercent.push(measured.cpuPercent);
    if (this.recentCpuPercent.length > 10) this.recentCpuPercent.shift();

    const nextReason = this.highReason(measured);
    if (!this.state.backgroundPaused && nextReason) {
      this.pausedAtMs = nowDate.getTime();
      this.state = {
        ...this.state,
        backgroundPaused: true,
        throttleReason: nextReason,
        pausedAt: nowDate.toISOString(),
        metrics: measured,
      };
      this.logTransition("paused", nextReason, measured);
    } else if (
      this.state.backgroundPaused &&
      this.isBelowLowWater(measured) &&
      this.pausedAtMs !== null &&
      nowDate.getTime() - this.pausedAtMs >= this.thresholds.cooldownMs
    ) {
      const previousReason = this.state.throttleReason;
      this.pausedAtMs = null;
      this.state = {
        ...this.state,
        backgroundPaused: false,
        throttleReason: null,
        pausedAt: null,
        metrics: measured,
      };
      this.logTransition("resumed", previousReason, measured);
      for (const resolve of this.waiters) resolve();
      this.waiters.clear();
    } else {
      this.state = { ...this.state, metrics: measured };
    }
    return this.getState();
  }

  private highReason(metrics: ResourceMetrics): ResourceThrottleReason {
    if (
      metrics.workingSetBytes >= this.thresholds.memoryHighWaterBytes ||
      metrics.workingSetBytes - this.baselineWorkingSetBytes >=
        this.thresholds.firstSyncGrowthBudgetBytes
    ) {
      return "memory-high";
    }
    if (metrics.eventLoopP95Ms >= this.thresholds.eventLoopSuspendMs) {
      return "event-loop-high";
    }
    if (this.rollingCpuPercent() >= this.thresholds.cpuSuspendPercent) {
      return "cpu-high";
    }
    return null;
  }

  private isBelowLowWater(metrics: ResourceMetrics): boolean {
    return (
      metrics.workingSetBytes <= this.thresholds.memoryLowWaterBytes &&
      metrics.workingSetBytes - this.baselineWorkingSetBytes <=
        this.thresholds.firstSyncGrowthResumeBudgetBytes &&
      metrics.eventLoopP95Ms <= this.thresholds.eventLoopResumeMs &&
      this.rollingCpuPercent() <= this.thresholds.cpuResumePercent
    );
  }

  private rollingCpuPercent(): number {
    if (this.recentCpuPercent.length === 0) return 0;
    return this.recentCpuPercent.reduce((sum, value) => sum + value, 0) /
      this.recentCpuPercent.length;
  }

  private logTransition(
    transition: "paused" | "resumed",
    reason: ResourceThrottleReason,
    metrics: ResourceMetrics,
  ): void {
    const fields = {
      reason,
      workloadClass: "background",
      cpuPercent: Number(metrics.cpuPercent.toFixed(2)),
      workingSetBytes: metrics.workingSetBytes,
      heapUsedBytes: metrics.heapUsedBytes,
      eventLoopP95Ms: Number(metrics.eventLoopP95Ms.toFixed(2)),
      queueDepth: metrics.queueDepth,
      activeProviderWork: metrics.activeProviderWork,
    };
    // Event-loop pressure is a useful diagnostic, but it is expected during
    // MIME parsing and renderer/database hand-offs. Keep it out of the
    // delivery-facing info stream. A genuine CPU/memory pause remains a warn
    // so a hard resource-boundary event is visible without becoming noisy.
    if (transition === "paused" && (reason === "cpu-high" || reason === "memory-high")) {
      this.logger?.warn(`performance.governor.${transition}`, fields);
    } else {
      this.logger?.debug(`performance.governor.${transition}`, fields);
    }
    this.onTransition?.(transition, reason, metrics);
  }

  private emptyMetrics(): ResourceMetrics {
    const memory = this.memoryUsage();
    return {
      sampledAt: this.now().toISOString(),
      cpuPercent: 0,
      workingSetBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      eventLoopP95Ms: 0,
      queueDepth: 0,
      activeProviderWork: 0,
    };
  }
}
