import assert from "node:assert/strict";
import test from "node:test";
import type { BotCoreStreamResult } from "../../../shared/wemail/botCoreProtocol.js";
import {
  WecomStreamSession,
  type WecomStreamTransport,
} from "./WecomStreamSession.js";

interface FrameCall {
  streamId: string;
  content: string;
  finish: boolean;
}

/** Mock transport: records every frame and returns scripted outcomes. */
class RecordingTransport implements WecomStreamTransport {
  readonly calls: FrameCall[] = [];
  readonly outcomes: BotCoreStreamResult[] = [];
  defaultOutcome: BotCoreStreamResult = "sent";

  queue(...results: BotCoreStreamResult[]): void {
    this.outcomes.push(...results);
  }

  streamFrame(input: {
    streamId: string;
    content: string;
    finish: boolean;
  }): Promise<BotCoreStreamResult> {
    this.calls.push({
      streamId: input.streamId,
      content: input.content,
      finish: input.finish,
    });
    const result =
      this.outcomes.length > 0 ? this.outcomes.shift()! : this.defaultOutcome;
    return Promise.resolve(result);
  }
}

const tick = (ms = 150) => new Promise<void>((r) => setTimeout(r, ms));

function newSession(transport: RecordingTransport): WecomStreamSession {
  return new WecomStreamSession(transport, "profile-1", "msgid-1");
}

test("WecomStreamSession: coalesced intermediate then blocking terminal, streamed", async () => {
  const transport = new RecordingTransport();
  const session = newSession(transport);

  session.update({ type: "text_delta", text: "Hello" });
  session.update({ type: "progress", text: "📧 读取邮件" });
  await tick(); // let the coalesced flush fire

  const result = await session.finish("Hello, world");

  assert.equal(result.outcome, "streamed");
  // one intermediate (finish=false) + one terminal (finish=true)
  assert.equal(transport.calls.length, 2);
  assert.equal(transport.calls[0]!.finish, false);
  assert.equal(transport.calls[1]!.finish, true);
  assert.match(transport.calls[1]!.content, /Hello, world/);
  assert.match(transport.calls[1]!.content, /<think>/);
  assert.match(transport.calls[0]!.content, /Hello/);
});

test("WecomStreamSession: finish called before the coalesce timer fires sends only the terminal frame", async () => {
  const transport = new RecordingTransport();
  const session = newSession(transport);

  session.update({ type: "text_delta", text: "partial" });
  // Do NOT await the coalesce — finish immediately clears the timer.
  const result = await session.finish("final answer");

  assert.equal(result.outcome, "streamed");
  assert.equal(transport.calls.length, 1);
  assert.equal(transport.calls[0]!.finish, true);
  assert.match(transport.calls[0]!.content, /final answer/);
  assert.doesNotMatch(transport.calls[0]!.content, /partial/);
});

test("WecomStreamSession: no intermediate frame is sent after the terminal frame", async () => {
  const transport = new RecordingTransport();
  const session = newSession(transport);

  session.update({ type: "text_delta", text: "x" });
  await session.finish("done");
  const countAfterFinish = transport.calls.length;

  // Updates after finish must be ignored; no stray frame after the terminal.
  session.update({ type: "text_delta", text: "late" });
  session.update({ type: "progress", text: "late progress" });
  await tick();

  assert.equal(transport.calls.length, countAfterFinish);
});

test("WecomStreamSession: skipped intermediate is benign (not broken); finish still streamed", async () => {
  const transport = new RecordingTransport();
  transport.queue("skipped", "sent"); // intermediate skipped, terminal sent
  const session = newSession(transport);

  session.update({ type: "text_delta", text: "hi" });
  await tick();
  const result = await session.finish("hi there");

  assert.equal(result.outcome, "streamed");
});

test("WecomStreamSession: failed intermediate breaks the stream; finish returns failed and sends no terminal", async () => {
  const transport = new RecordingTransport();
  transport.defaultOutcome = "failed";
  const session = newSession(transport);

  session.update({ type: "text_delta", text: "hi" });
  await tick();
  const result = await session.finish("hi there");

  assert.equal(result.outcome, "failed");
  // only the failed intermediate; no terminal frame (broken short-circuits)
  assert.equal(transport.calls.length, 1);
  assert.equal(transport.calls[0]!.finish, false);
});

test("WecomStreamSession: no-frame intermediate breaks the stream; finish returns failed", async () => {
  const transport = new RecordingTransport();
  transport.defaultOutcome = "no-frame";
  const session = newSession(transport);

  session.update({ type: "text_delta", text: "hi" });
  await tick();
  const result = await session.finish("hi there");

  assert.equal(result.outcome, "failed");
});

test("WecomStreamSession: over-budget final finishes with a notice and signals fallback-required", async () => {
  const transport = new RecordingTransport();
  const session = newSession(transport);

  const huge = "x".repeat(21_000);
  const result = await session.finish(huge);

  assert.equal(result.outcome, "fallback-required");
  assert.equal(transport.calls.length, 1);
  assert.equal(transport.calls[0]!.finish, true);
  assert.match(transport.calls[0]!.content, /完整内容见下条消息/);
  // the full answer must NOT be in the bubble (it comes via the delivery queue)
  assert(!transport.calls[0]!.content.includes(huge));
});

test("WecomStreamSession: progress lines are evicted (oldest first) to stay under the byte budget", async () => {
  const transport = new RecordingTransport();
  const session = newSession(transport);

  // ~500B progress lines, far exceeding the 20KB cap once combined.
  const line = "进度".repeat(200); // 600 bytes of CJK
  const first = "FIRST-MARKER-".repeat(10);
  session.update({ type: "progress", text: first });
  for (let i = 0; i < 60; i++) session.update({ type: "progress", text: `${line}-${i}` });
  session.update({ type: "text_delta", text: "answer" });
  await tick();

  const frame = transport.calls.at(-1)!;
  assert.equal(frame.finish, false);
  assert.ok(
    Buffer.byteLength(frame.content, "utf8") <= 20_000,
    `frame under cap, got ${Buffer.byteLength(frame.content, "utf8")}`,
  );
  // oldest progress evicted; the answer is retained
  assert(!frame.content.includes("FIRST-MARKER"));
  assert.match(frame.content, /answer/);
});

test("WecomStreamSession: stable streamId reused across frames", async () => {
  const transport = new RecordingTransport();
  const session = newSession(transport);

  session.update({ type: "text_delta", text: "a" });
  await tick();
  await session.finish("done");

  const ids = new Set(transport.calls.map((c) => c.streamId));
  assert.equal(ids.size, 1);
  assert.ok([...ids][0]!.startsWith("stream_"));
});

test("WecomStreamSession: dispose sends a best-effort terminal frame", async () => {
  const transport = new RecordingTransport();
  const session = newSession(transport);

  session.update({ type: "text_delta", text: "a" });
  await tick();
  await session.dispose();

  const last = transport.calls.at(-1)!;
  assert.equal(last.finish, true);
});
