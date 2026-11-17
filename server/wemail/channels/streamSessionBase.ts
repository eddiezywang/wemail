import type { StreamProgressEvent } from "./streamProgress.js";

/**
 * Outcome of finalizing a stream. Drives the worker's fallback choice.
 *  - `streamed`: the final answer reached the user via the stream — no
 *    one-shot delivery needed.
 *  - `fallback-required`: the stream could not carry the full answer cleanly;
 *    the worker should send the full text via the delivery queue.
 *  - `failed`: the stream never delivered a usable final answer; the worker
 *    should send the full text via the delivery queue (one-shot).
 */
export type StreamFinishResult =
  | { outcome: "streamed" }
  | { outcome: "fallback-required"; reason: string }
  | { outcome: "failed"; reason: string };

/** Result of one intermediate (finish=false) send. `failed` marks the stream broken. */
export type StreamSendOutcome = "sent" | "failed";

/** Coalesce interval for intermediate frames (avoids a frame per token). */
const STREAM_UPDATE_COALESCE_MS = 80;
/** Defensive single-stream lifetime (agent runs are capped at 120s, so this is
 *  near-unreachable). WeCom auto-ends at 10 min; Feishu auto-closes streaming
 *  mode at 10 min. */
const STREAM_LIFETIME_MS = 10 * 60_000;
const STREAM_SAFETY_MARGIN_MS = 30_000;

/**
 * Platform-agnostic streaming-session lifecycle: accumulates a safe progress
 * block and an answer body, coalesces intermediate sends, and guarantees a
 * race-free terminal send (cancel pending coalesce → await in-flight →
 * finalize; no intermediate after the terminal). Subclasses own the content
 * shape, per-platform byte/char budget, and the transport.
 *
 * Subclass contract:
 *  - `sendIntermediate()`: push one coalesced intermediate frame.
 *  - `sendFinal(finalText)`: push the terminal frame using the agent's
 *    authoritative final text; decide streamed / fallback-required / failed.
 *  - `abort()`: best-effort cleanup on dispose (run aborted) so the bubble /
 *    card does not dangle.
 */
export abstract class BaseStreamSession {
  protected readonly startedAt = Date.now();
  protected readonly progressLines: string[] = [];
  protected answerText = "";
  protected finished = false;
  protected broken = false;
  protected brokenReason?: string;
  private flushTimer?: NodeJS.Timeout;
  private inFlight: Promise<void> = Promise.resolve();

  /** Feed one progress event. Synchronous; frames are coalesced asynchronously. */
  update(event: StreamProgressEvent): void {
    if (this.finished || this.broken) return;
    if (this.approachingLifetimeCutoff()) {
      this.markBroken("lifetime-cutoff");
      return;
    }
    this.accumulate(event);
    this.scheduleFlush();
  }

  /**
   * Finalize the stream with the agent's authoritative final text. Cancels any
   * pending coalesced frame, awaits any in-flight intermediate send, then
   * delegates to the subclass terminal send. Returns the outcome so the worker
   * can decide whether to also enqueue a one-shot delivery.
   */
  async finish(finalText: string): Promise<StreamFinishResult> {
    if (this.finished) return { outcome: "streamed" };
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    this.finished = true;
    // Wait for any in-flight intermediate frame so the terminal send is ordered
    // strictly after it. Queued flush() calls no-op now (finished guard).
    await this.inFlight.catch(() => undefined);
    if (this.broken) {
      return { outcome: "failed", reason: this.brokenReason ?? "stream-broken" };
    }
    return this.sendFinal(finalText);
  }

  /**
   * Best-effort cleanup if the run is aborted (worker stop) so the bubble /
   * card does not dangle. No-op once finished.
   */
  async dispose(): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    await this.inFlight.catch(() => undefined);
    await this.abort().catch(() => undefined);
  }

  protected abstract sendIntermediate(): Promise<StreamSendOutcome>;
  protected abstract sendFinal(finalText: string): Promise<StreamFinishResult>;
  protected abstract abort(): Promise<void>;

  private accumulate(event: StreamProgressEvent): void {
    if (event.type === "text_delta") {
      // Only text_delta accumulates the streamed body (text_end/assistant_text
      // drive finalText instead, preventing duplicated body content). The body
      // is left uncapped here; the subclass enforces its platform budget when
      // building content (a single large delta must not jump past the cap).
      this.answerText += event.text;
      return;
    }
    const line = event.text.trim();
    if (line) this.progressLines.push(line);
  }

  private scheduleFlush(): void {
    if (this.flushTimer || this.finished) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      this.inFlight = this.inFlight
        .then(() => this.flush())
        .catch(() => undefined);
    }, STREAM_UPDATE_COALESCE_MS);
    this.flushTimer.unref?.();
  }

  /** Send one intermediate frame; mark broken on hard failure. */
  private async flush(): Promise<void> {
    if (this.finished || this.broken) return;
    const outcome = await this.sendIntermediate();
    if (outcome === "failed") this.markBroken("intermediate-failed");
  }

  protected approachingLifetimeCutoff(): boolean {
    return Date.now() - this.startedAt >= STREAM_LIFETIME_MS - STREAM_SAFETY_MARGIN_MS;
  }

  protected markBroken(reason: string): void {
    if (this.broken) return;
    this.broken = true;
    this.brokenReason = reason;
  }
}
