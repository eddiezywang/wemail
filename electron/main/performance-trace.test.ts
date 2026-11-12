import { describe, expect, it, vi } from "vitest";
import {
  createPerformanceTraceController,
  formatTraceTimestamp,
  resolveDeveloperTraceConfig,
} from "./performance-trace.js";

describe("developer performance trace", () => {
  it("is disabled for packaged or unguarded execution", () => {
    expect(resolveDeveloperTraceConfig({ isPackaged: true, env: { WEMAIL_DEV_TRACE: "1" }, cwd: "C:\\repo" })).toBeNull();
    expect(resolveDeveloperTraceConfig({ isPackaged: false, env: {}, cwd: "C:\\repo" })).toBeNull();
  });

  it("uses bounded defaults for invalid duration", () => {
    const config = resolveDeveloperTraceConfig({
      isPackaged: false,
      env: { WEMAIL_DEV_TRACE: "1", WEMAIL_TRACE_DURATION_MS: "bad" },
      cwd: "C:\\repo",
    });
    expect(config?.durationMs).toBe(30_000);
    expect(config?.warnings).toHaveLength(1);
  });

  it("starts and saves a timestamped trace", async () => {
    const startRecording = vi.fn(async () => undefined);
    const stopRecording = vi.fn(async (outputPath: string) => outputPath);
    const scheduled: Array<() => void> = [];
    const controller = createPerformanceTraceController({
      tracing: { startRecording, stopRecording },
      config: { durationMs: 5_000, outputDir: "C:\\reports", warnings: [] },
      mkdir: vi.fn(async () => undefined),
      log: vi.fn(),
      now: () => new Date("2026-07-28T08:30:15.123Z"),
      setTimer: ((callback: () => void) => {
        scheduled.push(callback);
        return { unref: vi.fn() } as unknown as NodeJS.Timeout;
      }),
      clearTimer: vi.fn(),
    });

    await expect(controller.start()).resolves.toBe(true);
    expect(controller.isRecording()).toBe(true);
    expect(startRecording).toHaveBeenCalledWith(expect.objectContaining({
      traceOptions: "record-continuously,enable-sampling",
    }));
    scheduled[0]?.();
    await vi.waitFor(() => expect(stopRecording).toHaveBeenCalledOnce());
    expect(stopRecording.mock.calls[0]?.[0]).toContain(
      "wemail-electron-trace-2026-07-28T08-30-15-123Z.json",
    );
  });

  it("formats timestamps for Windows filenames", () => {
    expect(formatTraceTimestamp(new Date("2026-07-28T08:30:15.123Z"))).toBe(
      "2026-07-28T08-30-15-123Z",
    );
  });
});
