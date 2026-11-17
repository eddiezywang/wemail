/**
 * Typed error for fatal boot-time failures during {@link composeApp}.
 *
 * The Electron main process catches this and renders an error dialog
 * before exiting; non-fatal failures (e.g. missing LLM config) MUST NOT
 * throw this. Phases:
 *   - "db"      — opening the SQLite file failed (bad path, permission).
 *   - "secrets" — initializing the file-backed secret store failed.
 *   - "logger"  — opening the daily-rotating log file failed.
 */

export type BootPhase = "db" | "logger" | "secrets";

export class BootError extends Error {
  readonly phase: BootPhase;
  readonly cause: unknown;
  constructor(args: { phase: BootPhase; cause: unknown; message?: string }) {
    const causeMessage =
      args.cause instanceof Error ? args.cause.message : String(args.cause);
    super(args.message ?? `WeMail boot failed in phase '${args.phase}': ${causeMessage}`);
    this.name = "BootError";
    this.phase = args.phase;
    this.cause = args.cause;
  }
}
