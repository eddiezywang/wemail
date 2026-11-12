export interface WorkerMemoryMetrics {
  rssBytes: number;
  heapUsedBytes: number;
  heapTotalBytes: number;
  externalBytes: number;
  arrayBuffersBytes: number;
}

export interface WorkerHeartbeatMetrics extends WorkerMemoryMetrics {
  queueDepth: number;
  activeJobKind: string | null;
  activeJobAgeMs: number | null;
}

export interface WorkerRuntimeMetrics extends WorkerHeartbeatMetrics {
  threadId: number | null;
  restartCount: number;
  restartBackoffMs: number;
  lastHeartbeatAt: number | null;
}

export function readWorkerHeartbeatMetrics(input: {
  queueDepth?: number;
  activeJobKind?: string | null;
  activeJobStartedAt?: number | null;
} = {}): WorkerHeartbeatMetrics {
  const memory = process.memoryUsage();
  const now = Date.now();
  return {
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    heapTotalBytes: memory.heapTotal,
    externalBytes: memory.external,
    arrayBuffersBytes: memory.arrayBuffers,
    queueDepth: Math.max(0, Math.floor(input.queueDepth ?? 0)),
    activeJobKind: input.activeJobKind ?? null,
    activeJobAgeMs: input.activeJobStartedAt
      ? Math.max(0, now - input.activeJobStartedAt)
      : null,
  };
}
