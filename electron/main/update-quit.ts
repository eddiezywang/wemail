export function createUpdateQuitCoordinator(options: {
  stop(): Promise<void> | void;
  quit(): void;
  quitAndInstall(): void;
  stopTimeoutMs?: number;
  onStopTimeout?(timeoutMs: number): void;
}) {
  let stopping = false;
  let installAfterShutdown = false;

  async function stopWithinDeadline(): Promise<void> {
    const timeoutMs = options.stopTimeoutMs;
    if (!timeoutMs || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      await options.stop();
      return;
    }

    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        Promise.resolve().then(() => options.stop()),
        new Promise<void>((resolve) => {
          timeout = setTimeout(() => {
            try {
              options.onStopTimeout?.(timeoutMs);
            } catch {
              // Diagnostics must not prevent the selected quit path.
            }
            resolve();
          }, timeoutMs);
          timeout.unref();
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  return {
    armInstallNow() {
      installAfterShutdown = true;
    },
    armInstallOnExit() {
      installAfterShutdown = true;
    },
    isStopping() {
      return stopping;
    },
    async handleBeforeQuit(event: { preventDefault(): void }) {
      if (stopping) {
        return;
      }
      stopping = true;
      event.preventDefault();
      try {
        await stopWithinDeadline();
      } catch {
        // Shutdown is best-effort, but the selected quit path must still run.
      } finally {
        if (installAfterShutdown) {
          try {
            options.quitAndInstall();
          } catch {
            options.quit();
          }
        } else {
          options.quit();
        }
      }
    },
  };
}
