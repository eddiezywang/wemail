import path from "node:path";

const DEFAULT_DURATION_MS = 30_000;
const DEFAULT_OUTPUT_DIR = "workspace/reports/performance";
const TRACE_CATEGORY_FILTER = [
  "electron",
  "node",
  "v8",
  "blink",
  "cc",
  "gpu",
  "toplevel",
  "disabled-by-default-v8.cpu_profiler",
].join(",");

export interface DeveloperTraceConfig {
  durationMs: number;
  outputDir: string;
  warnings: string[];
}
export interface ContentTracingAdapter {
  startRecording(options: {
    categoryFilter: string;
    traceOptions: string;
  }): Promise<void>;
  stopRecording(resultFilePath?: string): Promise<string>;
}

export interface PerformanceTraceController {
  start(): Promise<boolean>;
  stop(reason?: string): Promise<string | null>;
  isRecording(): boolean;
}

export function resolveDeveloperTraceConfig(input: {
  isPackaged: boolean;
  env: NodeJS.ProcessEnv;
  cwd: string;
}): DeveloperTraceConfig | null {
  if (input.isPackaged || input.env.WEMAIL_DEV_TRACE !== "1") return null;
  const warnings: string[] = [];
  const parsedDuration = Number(input.env.WEMAIL_TRACE_DURATION_MS ?? DEFAULT_DURATION_MS);
  const durationMs = Number.isFinite(parsedDuration) && parsedDuration >= 1_000
    ? Math.floor(parsedDuration)
    : DEFAULT_DURATION_MS;
  if (durationMs !== parsedDuration) {
    warnings.push(
      `invalid WEMAIL_TRACE_DURATION_MS=${input.env.WEMAIL_TRACE_DURATION_MS ?? ""}; using ${DEFAULT_DURATION_MS}`,
    );
  }
  return {
    durationMs,
    outputDir: path.resolve(
      input.cwd,
      input.env.WEMAIL_TRACE_OUTPUT_DIR ?? DEFAULT_OUTPUT_DIR,
    ),
    warnings,
  };
}

export function createPerformanceTraceController(input: {
  tracing: ContentTracingAdapter;
  config: DeveloperTraceConfig;
  mkdir: (path: string) => Promise<unknown>;
  log?: (message: string) => void;
  now?: () => Date;
  setTimer?: (callback: () => void, delayMs: number) => NodeJS.Timeout;
  clearTimer?: (timer: NodeJS.Timeout) => void;
}): PerformanceTraceController {
  const log = input.log ?? ((message) => process.stderr.write(`${message}\n`));
  const now = input.now ?? (() => new Date());
  const setTimer = input.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const clearTimer = input.clearTimer ?? ((timer) => clearTimeout(timer));
  let recording = false;
  let timer: NodeJS.Timeout | null = null;
  let stopPromise: Promise<string | null> | null = null;

  const stop = async (reason = "manual"): Promise<string | null> => {
    if (stopPromise) return stopPromise;
    if (!recording) return null;
    stopPromise = (async () => {
      if (timer) clearTimer(timer);
      timer = null;
      const outputPath = path.join(
        input.config.outputDir,
        `wemail-electron-trace-${formatTraceTimestamp(now())}.json`,
      );
      try {
        const writtenPath = await input.tracing.stopRecording(outputPath);
        recording = false;
        log(`[performance-trace] saved reason=${reason} path=${writtenPath || outputPath}`);
        return writtenPath || outputPath;
      } catch (error) {
        recording = false;
        log(`[performance-trace] stop failed: ${errorMessage(error)}`);
        return null;
      } finally {
        stopPromise = null;
      }
    })();
    return stopPromise;
  };

  return {
    async start() {
      if (recording) {
        log("[performance-trace] recording already active");
        return false;
      }
      try {
        await input.mkdir(input.config.outputDir);
        await input.tracing.startRecording({
          categoryFilter: TRACE_CATEGORY_FILTER,
          traceOptions: "record-continuously,enable-sampling",
        });
        recording = true;
        timer = setTimer(() => void stop("duration"), input.config.durationMs);
        timer.unref?.();
        log(
          `[performance-trace] started durationMs=${input.config.durationMs} outputDir=${input.config.outputDir}`,
        );
        return true;
      } catch (error) {
        log(`[performance-trace] start failed: ${errorMessage(error)}`);
        return false;
      }
    },
    stop,
    isRecording: () => recording,
  };
}

export function formatTraceTimestamp(value: Date): string {
  return value.toISOString().replace(/[:.]/g, "-");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
