/**
 * LlmJudge — Phase 3 unit tests for rubric parameter, repeatN, and
 * unstable/judgeError flags.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { LlmClient, LlmRequest, LlmResponse } from "../../../ai/LlmClient.js";
import { mailSamples } from "../../../testing/mailSamples.js";
import { judgeQuality, judgeWithRubric } from "./LlmJudge.js";

function fakeLlm(replies: () => string | string[]): LlmClient {
  let i = 0;
  return {
    async generate(_input: LlmRequest): Promise<LlmResponse> {
      const r = replies();
      const text = Array.isArray(r) ? r[i % r.length]! : r;
      i += 1;
      return { text, finishReason: "stop" };
    },
  };
}

function failingLlm(message: string): LlmClient {
  return {
    async generate(): Promise<LlmResponse> {
      throw new Error(message);
    },
  };
}

const sample = mailSamples[0]!;

test("judgeWithRubric: single-shot returns score + reason + attempts of length 1", async () => {
  const llm = fakeLlm(() => '{"score":2.5,"reason":"close enough"}');
  const r = await judgeWithRubric({
    llm,
    model: "fake",
    rubric: "be helpful",
    feature: "summary",
    emailContext: "Subject: test",
    output: { foo: "bar" },
    repeatN: 1,
  });
  assert.equal(r.score, 2.5);
  assert.equal(r.reason, "close enough");
  assert.equal(r.attempts.length, 1);
  assert.equal(r.unstable, false);
  assert.equal(r.judgeError, false);
});

test("judgeWithRubric: repeatN=3 stable returns median + low stdev + unstable=false", async () => {
  const replies = [
    '{"score":2.0,"reason":"a"}',
    '{"score":2.5,"reason":"b"}',
    '{"score":2.0,"reason":"c"}',
  ];
  const llm = fakeLlm(() => replies);
  const r = await judgeWithRubric({
    llm,
    model: "fake",
    rubric: "tone",
    feature: "composeDraft",
    emailContext: "Subject: tone test",
    output: "draft",
    repeatN: 3,
    maxVariance: 0.8,
  });
  assert.equal(r.attempts.length, 3);
  assert.equal(r.score, 2.0); // median of [2.0, 2.5, 2.0]
  assert.ok(r.stdev < 0.8, `stdev was ${r.stdev}`);
  assert.equal(r.unstable, false);
});

test("judgeWithRubric: repeatN=3 high variance flags unstable", async () => {
  const replies = [
    '{"score":0.0,"reason":"awful"}',
    '{"score":2.5,"reason":"fine"}',
    '{"score":3.0,"reason":"great"}',
  ];
  const llm = fakeLlm(() => replies);
  const r = await judgeWithRubric({
    llm,
    model: "fake",
    rubric: "tone",
    feature: "composeDraft",
    emailContext: "Subject: variance test",
    output: "draft",
    repeatN: 3,
    maxVariance: 0.8,
  });
  assert.equal(r.attempts.length, 3);
  assert.ok(r.stdev > 0.8, `expected stdev > 0.8, got ${r.stdev}`);
  assert.equal(r.unstable, true);
});

test("judgeWithRubric: all attempts fail → judgeError=true, score=1.5 fallback", async () => {
  const llm = failingLlm("network down");
  const r = await judgeWithRubric({
    llm,
    model: "fake",
    rubric: "rubric",
    feature: "summary",
    emailContext: "Subject: x",
    output: {},
    repeatN: 2,
  });
  assert.equal(r.judgeError, true);
  assert.equal(r.score, 1.5);
  assert.match(r.reason, /judge-call-failed/);
  assert.equal(r.attempts.length, 0);
});

test("judgeWithRubric: parse failure on all attempts → judgeError=true", async () => {
  const llm = fakeLlm(() => "not json at all");
  const r = await judgeWithRubric({
    llm,
    model: "fake",
    rubric: "rubric",
    feature: "summary",
    emailContext: "Subject: x",
    output: {},
    repeatN: 1,
  });
  assert.equal(r.judgeError, true);
  assert.match(r.reason, /judge-parse-failed/);
});

test("judgeWithRubric: partial failure (1/2 attempts succeed) → no judgeError, single attempt counted", async () => {
  let call = 0;
  const llm: LlmClient = {
    async generate() {
      call += 1;
      if (call === 1) throw new Error("transient");
      return { text: '{"score":2,"reason":"recovered"}', finishReason: "stop" };
    },
  };
  const r = await judgeWithRubric({
    llm,
    model: "fake",
    rubric: "rubric",
    feature: "summary",
    emailContext: "Subject: x",
    output: {},
    repeatN: 2,
  });
  assert.equal(r.judgeError, false);
  assert.equal(r.attempts.length, 1);
  assert.equal(r.score, 2);
});

test("judgeQuality: legacy entry point still works (no rubric override)", async () => {
  const llm = fakeLlm(() => '{"score":2.7,"reason":"legacy path"}');
  const r = await judgeQuality({
    llm,
    model: "fake",
    feature: "summary",
    sample,
    output: { bullets: ["x"] },
  });
  assert.equal(r.score, 2.7);
  assert.equal(r.reason, "legacy path");
  assert.equal(r.judgeError, false);
});

test("judgeQuality: rubric override takes precedence over per-feature default", async () => {
  // Capture the system prompt sent to the judge.
  let capturedSystem = "";
  const llm: LlmClient = {
    async generate(input) {
      capturedSystem = input.system ?? "";
      return { text: '{"score":3,"reason":"ok"}', finishReason: "stop" };
    },
  };
  await judgeQuality({
    llm,
    model: "fake",
    feature: "summary",
    sample,
    output: {},
    rubric: "MY-CUSTOM-RUBRIC-XYZ",
  });
  assert.match(capturedSystem, /MY-CUSTOM-RUBRIC-XYZ/);
});
