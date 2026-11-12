import { randomUUID } from "node:crypto";
import type { BotCoreStreamResult } from "../../../shared/wemail/botCoreProtocol.js";
import {
  BaseStreamSession,
  type StreamFinishResult,
  type StreamSendOutcome,
} from "./streamSessionBase.js";
import {
  byteLength,
  sanitizePresentation,
  sanitizeUtf8,
  truncateToBytes,
} from "./channelText.js";

/**
 * Transport the WeCom session pushes frames through. Structurally satisfied by
 * `BotChannelRuntime.streamFrame` (which forwards over bot-core IPC).
 */
export interface WecomStreamTransport {
  streamFrame(input: {
    profileId: string;
    sourceEventId: string;
    streamId: string;
    content: string;
    finish: boolean;
  }): Promise<BotCoreStreamResult>;
}

/** Soft per-frame content cap (WeCom hard cap is 20480 bytes). */
const STREAM_MAX_CONTENT_BYTES = 20_000;

/**
 * Server-side WeCom streaming session. Owns a stable `streamId`, renders the
 * accumulated progress + answer as `<think>…</think>\n\n{answer}`, and pushes
 * coalesced intermediate frames (non-blocking) plus one blocking terminal frame
 * over the transport. The base class owns the lifecycle/coalesce/race-free
 * finish; this class owns the WeCom content shape, the per-frame UTF-8 byte
 * budget, and the `streamFrame` transport mapping.
 */
export class WecomStreamSession extends BaseStreamSession {
  readonly streamId: string;

  constructor(
    private readonly transport: WecomStreamTransport,
    private readonly profileId: string,
    private readonly sourceEventId: string,
  ) {
    super();
    this.streamId = `stream_${Date.now()}_${randomUUID()}`;
  }

  protected async sendIntermediate(): Promise<StreamSendOutcome> {
    // Intermediate: the answer is partial, so truncate it to the frame budget.
    const content = this.buildContent(this.answerText, true);
    return this.sendFrame(content, false);
  }

  protected async sendFinal(finalText: string): Promise<StreamFinishResult> {
    const answer = sanitizePresentation(finalText);
    const minimalThinkBytes =
      this.progressLines.length > 0
        ? byteLength("<think>\n...\n</think>\n\n")
        : 0;
    if (byteLength(answer) + minimalThinkBytes > STREAM_MAX_CONTENT_BYTES) {
      // Full final answer cannot fit one stream frame. Finish the bubble with a
      // short notice and signal the worker to send the full text via the
      // delivery queue — avoids a near-complete bubble plus a duplicate message.
      const outcome = await this.sendFrame(
        "（回复较长，完整内容见下条消息）",
        true,
      );
      return outcome === "sent"
        ? { outcome: "fallback-required", reason: "final-over-budget" }
        : { outcome: "failed", reason: `terminal-${outcome}` };
    }
    // Final: the answer is authoritative — never truncate it; evict progress to
    // fit instead. (The over-budget check above guarantees the answer alone fits.)
    this.answerText = answer;
    const content = this.buildContent(answer, false);
    const outcome = await this.sendFrame(content, true);
    return outcome === "sent"
      ? { outcome: "streamed" }
      : { outcome: "failed", reason: `terminal-${outcome}` };
  }

  protected async abort(): Promise<void> {
    if (this.broken) return;
    await this.sendFrame(this.buildContent(this.answerText, true), true).catch(
      () => undefined,
    );
  }

  private async sendFrame(
    content: string,
    finish: boolean,
  ): Promise<StreamSendOutcome> {
    try {
      const result = await this.transport.streamFrame({
        profileId: this.profileId,
        sourceEventId: this.sourceEventId,
        streamId: this.streamId,
        content,
        finish,
      });
      // `skipped` is benign SDK back pressure (the next frame overwrites the
      // bubble); `failed` / `no-frame` are hard failures.
      return result === "failed" || result === "no-frame" ? "failed" : "sent";
    } catch {
      return "failed";
    }
  }

  /**
   * Assemble `<think>\n{progress}\n</think>\n\n{answer}` under a strict per-frame
   * UTF-8 byte budget.
   *  - `truncateAnswer` (intermediate/abort): the answer is partial → truncate
   *    it to the remaining budget; evict oldest progress lines first.
   *  - `!truncateAnswer` (final): the answer is authoritative → keep it full,
   *    evict progress to fit (down to none). The caller guarantees the answer
   *    alone fits, so the result never exceeds the cap.
   * A single over-long progress line is dropped entirely so the frame always
   * fits. UTF-8-sanitized to drop unpaired surrogates.
   */
  private buildContent(answer: string, truncateAnswer: boolean): string {
    const max = STREAM_MAX_CONTENT_BYTES;
    const joinThink = (marker: string) =>
      this.progressLines.length > 0
        ? `<think>\n${marker}${this.progressLines.join("\n")}\n</think>\n\n`
        : "";
    let think = joinThink("");
    let answerPart = truncateAnswer
      ? truncateToBytes(answer, Math.max(0, max - byteLength(think)))
      : answer;
    let content = sanitizeUtf8(think + answerPart);
    while (byteLength(content) > max && this.progressLines.length > 0) {
      if (this.progressLines.length > 1) {
        this.progressLines.shift();
        think = joinThink("...\n");
      } else {
        this.progressLines.shift();
        think = "";
      }
      answerPart = truncateAnswer
        ? truncateToBytes(answer, Math.max(0, max - byteLength(think)))
        : answer;
      content = sanitizeUtf8(think + answerPart);
    }
    return content;
  }
}
