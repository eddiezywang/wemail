import { randomUUID } from "node:crypto";
import {
  BaseStreamSession,
  type StreamFinishResult,
  type StreamSendOutcome,
} from "./streamSessionBase.js";
import { sanitizePresentation, truncateToChars } from "./channelText.js";

/**
 * Transport the Feishu session drives. Structurally satisfied by
 * `BotChannelRuntime` (forwards over bot-core IPC). `profileId` routes to the
 * bot-core channel; `uuid` makes each op idempotent across timeout retries.
 */
export interface FeishuStreamTransport {
  feishuStreamStart(input: {
    profileId: string;
    receiveId: string;
    uuid: string;
  }): Promise<
    | { outcome: "created"; cardId: string; messageId: string }
    | { outcome: "failed" }
  >;
  feishuStreamText(input: {
    profileId: string;
    cardId: string;
    elementId: string;
    text: string;
    sequence: number;
    uuid: string;
  }): Promise<"sent" | "failed">;
  feishuStreamEnd(input: {
    profileId: string;
    cardId: string;
    sequence: number;
    uuid: string;
  }): Promise<"sent" | "failed">;
  feishuStreamAbort(input: { profileId: string; messageId: string }): Promise<void>;
}

/** Per-element char budget (Feishu element limit ~30000; leave headroom). */
const FEISHU_ELEMENT_MAX_CHARS = 28_000;
const PROGRESS_ELEMENT_ID = "progress";
const ANSWER_ELEMENT_ID = "answer";

export interface FeishuStreamSessionOptions {
  /** Reports the first `startCard` outcome so the caller's circuit breaker can
   *  trip on repeated permission/platform failures or reset on success. */
  onStartOutcome?: (ok: boolean) => void;
}

/**
 * Feishu Card Kit streaming session. Lazily creates a streaming-mode card +
 * sends it to `receiveId` (a chat_id), then stream-updates a `progress` and an
 * `answer` markdown element (platform renders the typewriter), and closes
 * streaming mode at the end.
 *
 * Failure semantics (avoid residual cards / duplicate full replies):
 *  - `startCard` never makes the message visible → `abort` + `failed` (worker
 *    one-shots; no residual card).
 *  - message visible but the final answer was NOT written (partial) →
 *    best-effort close + `fallback-required` (worker sends full via queue; the
 *    partial card stays, clearly incomplete — not a duplicate).
 *  - final answer written → `streamed` regardless of whether the close
 *    succeeded (the full answer is already visible; closing is best-effort and
 *    a fallback would duplicate it).
 *
 * Card Kit `sequence` is monotonic across the whole card (owned here); each op
 * carries a fresh stable `uuid`.
 */
export class FeishuStreamSession extends BaseStreamSession {
  private cardId?: string;
  private messageId?: string;
  private messageVisible = false;
  private contentWritten = false;
  private finalWritten = false;
  private sequence = 0;
  private startReported = false;

  constructor(
    private readonly transport: FeishuStreamTransport,
    private readonly profileId: string,
    private readonly receiveId: string,
    private readonly options: FeishuStreamSessionOptions = {},
  ) {
    super();
  }

  protected async sendIntermediate(): Promise<StreamSendOutcome> {
    if (!(await this.ensureCard())) return "failed";
    const progressText = this.progressLines.join("\n");
    if (progressText) {
      const outcome = await this.streamText(
        PROGRESS_ELEMENT_ID,
        truncateToChars(progressText, FEISHU_ELEMENT_MAX_CHARS),
      );
      if (outcome === "failed") return "failed";
      this.contentWritten = true;
    }
    const outcome = await this.streamText(
      ANSWER_ELEMENT_ID,
      truncateToChars(this.answerText, FEISHU_ELEMENT_MAX_CHARS),
    );
    if (outcome === "sent") this.contentWritten = true;
    return outcome;
  }

  protected async sendFinal(finalText: string): Promise<StreamFinishResult> {
    const ok = await this.ensureCard();
    if (!ok) {
      // Message never became visible — clean up any partial card and let the
      // worker send a one-shot (no residual card).
      await this.abort().catch(() => undefined);
      return { outcome: "failed", reason: "start-card-failed" };
    }
    const answer = truncateToChars(
      sanitizePresentation(finalText),
      FEISHU_ELEMENT_MAX_CHARS,
    );
    const wrote = await this.streamText(ANSWER_ELEMENT_ID, answer);
    if (wrote === "sent") {
      this.finalWritten = true;
      this.contentWritten = true;
      // Final answer is visible — close streaming best-effort. Even if the close
      // fails, do NOT fall back: the full answer is already shown and a one-shot
      // would duplicate it. (Feishu auto-closes streaming mode after 10 min.)
      await this.endCardBestEffort();
      return { outcome: "streamed" };
    }
    // Message visible but the final answer did not land cleanly (partial).
    // Best-effort close + signal the worker to send the full text via the queue.
    await this.endCardBestEffort();
    return { outcome: "fallback-required", reason: "final-write-failed" };
  }

  protected async abort(): Promise<void> {
    if (!this.messageVisible) return;
    if (!this.contentWritten && this.messageId) {
      // Card is visible but never got useful content — delete the empty card.
      await this.transport
        .feishuStreamAbort({ profileId: this.profileId, messageId: this.messageId })
        .catch(() => undefined);
      return;
    }
    // Partial content was shown — freeze it by closing streaming mode.
    await this.endCardBestEffort();
  }

  private async ensureCard(): Promise<boolean> {
    if (this.cardId) return true;
    // The transport throws BotChannelTransportError (e.g. bot-core-not-ready)
    // when streaming is unavailable; that must degrade to a one-shot send
    // fallback (same contract as WecomStreamSession.sendFrame), never
    // propagate out of sendFinal — otherwise the user receives no reply at
    // all.
    let result: Awaited<
      ReturnType<typeof this.transport.feishuStreamStart>
    >;
    try {
      result = await this.transport.feishuStreamStart({
        profileId: this.profileId,
        receiveId: this.receiveId,
        uuid: randomUUID(),
      });
    } catch {
      this.reportStart(false);
      return false;
    }
    if (result.outcome === "failed") {
      this.reportStart(false);
      return false;
    }
    this.cardId = result.cardId;
    this.messageId = result.messageId;
    this.messageVisible = true;
    this.reportStart(true);
    return true;
  }

  private async streamText(
    elementId: string,
    text: string,
  ): Promise<"sent" | "failed"> {
    if (!this.cardId) return "failed";
    try {
      return await this.transport.feishuStreamText({
        profileId: this.profileId,
        cardId: this.cardId,
        elementId,
        text,
        sequence: ++this.sequence,
        uuid: randomUUID(),
      });
    } catch {
      return "failed";
    }
  }

  private async endCardBestEffort(): Promise<void> {
    if (!this.cardId) return;
    await this.transport
      .feishuStreamEnd({
        profileId: this.profileId,
        cardId: this.cardId,
        sequence: ++this.sequence,
        uuid: randomUUID(),
      })
      .catch(() => undefined);
  }

  private reportStart(ok: boolean): void {
    if (this.startReported) return;
    this.startReported = true;
    this.options.onStartOutcome?.(ok);
  }
}
