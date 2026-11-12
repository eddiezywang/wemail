/**
 * Robust error serialization for the DB Service worker boundary.
 *
 * Errors crossing the worker/process boundary can be *anything* — a plain
 * object, a string, an Error built from an object. `String(plainObject)`
 * yields the useless `[object Object]` seen in
 * `mail-database-bootstrap-failed` logs, which hides the real cause
 * (module load, native binding, SQLite failure). This helper extracts the
 * best human-readable description with a JSON fallback so the failure
 * survives into the boot log.
 */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name || "Error";
  }
  if (typeof error === "string") return error;
  if (error !== null && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) return message;
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && code.length > 0) return code;
    try {
      return JSON.stringify(error);
    } catch {
      // non-serializable object — fall through to String()
    }
  }
  return String(error);
}
