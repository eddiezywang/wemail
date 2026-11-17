import assert from "node:assert/strict";
import test from "node:test";
import { FeishuStreamSession } from "./FeishuStreamSession.js";
import type { FeishuStreamTransport } from "./FeishuStreamSession.js";

interface TextCall {
  elementId: string;
  text: string;
  sequence: number;
  uuid: string;
}

/** Mock transport implementing the FeishuStreamTransport contract. */
class MockTransport implements FeishuStreamTransport {
  starts = 0;
  lastReceiveId?: string;
  texts: TextCall[] = [];
  ends = 0;
  aborts = 0;
  startOutcome: "created" | "failed" = "created";
  /** When set, feishuStreamStart rejects (transport throw, not a failed result). */
  startError?: Error;
  /** Queue of text outcomes; falls back to textOutcomeDefault. */
  textOutcomes: Array<"sent" | "failed"> = [];
  textOutcomeDefault: "sent" | "failed" = "sent";
  /** When set, feishuStreamText rejects (transport throw, not a failed result). */
  textError?: Error;
  endOutcome: "sent" | "failed" = "sent";
  /** Texts that actually landed on the card (resolved "sent" writes). */
  delivered: string[] = [];
  private n = 0;

  feishuStreamStart(input: {
    profileId: string;
    receiveId: string;
    uuid: string;
  }): Promise<
    | { outcome: "created"; cardId: string; messageId: string }
    | { outcome: "failed" }
  > {
    this.starts += 1;
    this.lastReceiveId = input.receiveId;
    if (this.startError) return Promise.reject(this.startError);
    if (this.startOutcome === "failed") return Promise.resolve({ outcome: "failed" });
    this.n += 1;
    return Promise.resolve({
      outcome: "created",
      cardId: `card-${this.n}`,
      messageId: `msg-${this.n}`,
    });
  }

  feishuStreamText(input: {
    profileId: string;
    cardId: string;
    elementId: string;
    text: string;
    sequence: number;
    uuid: string;
  }): Promise<"sent" | "failed"> {
    this.texts.push({
      elementId: input.elementId,
      text: input.text,
      sequence: input.sequence,
      uuid: input.uuid,
    });
    if (this.textError) return Promise.reject(this.textError);
    const outcome =
      this.textOutcomes.length > 0 ? this.textOutcomes.shift()! : this.textOutcomeDefault;
    if (outcome === "sent") this.delivered.push(input.text);
    return Promise.resolve(outcome);
  }

  feishuStreamEnd(input: {
    profileId: string;
    cardId: string;
    sequence: number;
    uuid: string;
  }): Promise<"sent" | "failed"> {
    this.ends += 1;
    return Promise.resolve(this.endOutcome);
  }

  feishuStreamAbort(input: {
    profileId: string;
    messageId: string;
  }): Promise<void> {
    this.aborts += 1;
    return Promise.resolve();
  }
}

const tick = (ms = 150) => new Promise<void>((r) => setTimeout(r, ms));

test("FeishuStreamSession: happy path — startCard once, stream progress+answer, close, streamed", async () => {
  const t = new MockTransport();
  const s = new FeishuStreamSession(t, "profile-1", "chat-xyz");

  s.update({ type: "progress", text: "📧 读取邮件" });
  s.update({ type: "text_delta", text: "Hello" });
  await tick();

  const result = await s.finish("Hello, world");

  assert.equal(result.outcome, "streamed");
  assert.equal(t.starts, 1, "startCard called exactly once");
  assert.equal(t.lastReceiveId, "chat-xyz", "receiveId is the chat_id");
  assert.equal(t.ends, 1, "streaming mode closed on finish");
  // intermediate: progress + answer; final: answer. Answer written at least twice.
  const answers = t.texts.filter((c) => c.elementId === "answer");
  assert.ok(answers.length >= 2);
  assert.ok(t.texts.some((c) => c.elementId === "progress"));
});

test("FeishuStreamSession: sequence is monotonic across the whole card; uuid per op", async () => {
  const t = new MockTransport();
  const s = new FeishuStreamSession(t, "profile-1", "chat-1");

  s.update({ type: "progress", text: "step 1" });
  s.update({ type: "text_delta", text: "a" });
  await tick();
  await s.finish("done");

  const seqs = t.texts.map((c) => c.sequence);
  for (let i = 1; i < seqs.length; i++) {
    assert.ok(seqs[i]! > seqs[i - 1]!, "text sequence strictly increasing");
  }
  // every op (texts + the end) carries a unique uuid
  const uuids = [...t.texts.map((c) => c.uuid)];
  assert.equal(new Set(uuids).size, uuids.length, "unique uuids across text ops");
});

test("FeishuStreamSession: startCard fails → broken → finish returns failed, no text/end", async () => {
  const t = new MockTransport();
  t.startOutcome = "failed";
  const s = new FeishuStreamSession(t, "profile-1", "chat-1");

  s.update({ type: "text_delta", text: "hi" });
  await tick();
  const result = await s.finish("hi there");

  assert.equal(result.outcome, "failed");
  assert.equal(t.starts, 1);
  assert.equal(t.texts.length, 0, "no content writes when startCard failed");
  assert.equal(t.ends, 0, "no close when nothing was created");
});

test("FeishuStreamSession: final answer written → streamed even if endCard fails (no duplicate)", async () => {
  const t = new MockTransport();
  t.endOutcome = "failed";
  const s = new FeishuStreamSession(t, "profile-1", "chat-1");

  s.update({ type: "text_delta", text: "partial" });
  await tick();
  const result = await s.finish("final answer");

  assert.equal(result.outcome, "streamed", "final written → streamed despite close failure");
  assert.equal(t.ends, 1, "close attempted best-effort");
});

test("FeishuStreamSession: final write fails after message visible → fallback-required", async () => {
  const t = new MockTransport();
  const s = new FeishuStreamSession(t, "profile-1", "chat-1");

  s.update({ type: "text_delta", text: "partial" });
  await tick(); // intermediate writes succeed (default 'sent')
  // now make the FINAL answer write fail
  t.textOutcomeDefault = "failed";
  const result = await s.finish("full final");

  assert.equal(result.outcome, "fallback-required");
  assert.equal(t.ends, 1, "best-effort close on partial");
});

test("FeishuStreamSession: circuit-breaker hook reports startCard outcome once", async () => {
  const reported: boolean[] = [];
  const t = new MockTransport();
  const s = new FeishuStreamSession(t, "profile-1", "chat-1", {
    onStartOutcome: (ok) => reported.push(ok),
  });
  s.update({ type: "text_delta", text: "hi" });
  await tick();
  await s.finish("done");
  assert.deepEqual(reported, [true], "success reported exactly once");

  // failure case
  const reported2: boolean[] = [];
  const t2 = new MockTransport();
  t2.startOutcome = "failed";
  const s2 = new FeishuStreamSession(t2, "profile-1", "chat-1", {
    onStartOutcome: (ok) => reported2.push(ok),
  });
  s2.update({ type: "text_delta", text: "hi" });
  await tick();
  await s2.finish("done");
  assert.deepEqual(reported2, [false], "failure reported exactly once");
});

test("FeishuStreamSession: dispose after content closes streaming (freeze partial)", async () => {
  const t = new MockTransport();
  const s = new FeishuStreamSession(t, "profile-1", "chat-1");
  s.update({ type: "text_delta", text: "partial" });
  await tick();
  await s.dispose();
  assert.equal(t.ends, 1, "dispose froze the partial card via close");
});

test("FeishuStreamSession: dispose before any card does nothing", async () => {
  const t = new MockTransport();
  const s = new FeishuStreamSession(t, "profile-1", "chat-1");
  await s.dispose();
  assert.equal(t.starts, 0);
  assert.equal(t.aborts, 0);
  assert.equal(t.ends, 0);
});

// Round-8 suggestion 6: the transport may THROW (BotChannelTransportError,
// e.g. bot-core IPC not ready) instead of resolving a failed outcome. That
// must degrade under the same contract as WecomStreamSession.sendFrame: the
// session reports a non-streamed outcome, so ChannelWorker one-shot-enqueues
// the complete answer exactly once and the card never ends up showing the
// full final content too (no duplicate delivery).

test("FeishuStreamSession: startCard rejects (transport throw) → failed, one-shot once", async () => {
  const t = new MockTransport();
  t.startError = new Error("bot-core-not-ready");
  const reported: boolean[] = [];
  const s = new FeishuStreamSession(t, "profile-1", "chat-1", {
    onStartOutcome: (ok) => reported.push(ok),
  });

  const result = await s.finish("the complete answer");

  assert.equal(result.outcome, "failed", "worker one-shot path");
  assert.equal(result.reason, "start-card-failed");
  assert.equal(t.starts, 1, "startCard attempted exactly once");
  assert.equal(t.texts.length, 0, "no content writes after the start throw");
  assert.equal(t.ends, 0, "no close when nothing was created");
  assert.equal(t.aborts, 0, "nothing became visible, so nothing to clean up");
  assert.deepEqual(reported, [false], "circuit breaker sees the failure once");
  assert.equal(t.delivered.length, 0, "final content never streamed — the worker's one-shot is the only delivery");
});

test("FeishuStreamSession: intermediate streamText rejects → stream broken, finish failed", async () => {
  const t = new MockTransport();
  t.textError = new Error("card-api-error");
  const s = new FeishuStreamSession(t, "profile-1", "chat-1");

  s.update({ type: "text_delta", text: "partial" });
  await tick();
  const result = await s.finish("the complete answer");

  assert.equal(result.outcome, "failed", "broken stream → worker one-shot path");
  assert.equal(t.starts, 1);
  assert.equal(t.ends, 0, "broken stream skips sendFinal (no best-effort close needed)");
  assert.equal(t.delivered.length, 0, "no content landed on the card");
  assert.ok(!t.texts.some((c) => c.text.includes("the complete answer")), "full answer never attempted onto the card");
});

test("FeishuStreamSession: final streamText rejects after visible card → fallback-required exactly once", async () => {
  const t = new MockTransport();
  const s = new FeishuStreamSession(t, "profile-1", "chat-1");

  s.update({ type: "text_delta", text: "partial" });
  await tick(); // intermediate writes resolve "sent"
  t.textError = new Error("card-api-error");
  const result = await s.finish("the complete answer");

  assert.equal(result.outcome, "fallback-required", "worker sends the full text via the delivery queue");
  assert.equal(t.ends, 1, "partial card closed best-effort (frozen, clearly incomplete)");
  assert.deepEqual(t.delivered, ["partial"], "final answer never landed on the card — no duplicate with the one-shot send");
});
