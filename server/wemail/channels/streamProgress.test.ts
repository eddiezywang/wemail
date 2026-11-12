import assert from "node:assert/strict";
import test from "node:test";
import type { AgentEvent } from "../../../shared/wemail/agent.js";
import { mapAgentEventToProgress } from "./streamProgress.js";

test("progress whitelist: text_delta is forwarded as body", () => {
  const e: AgentEvent = { type: "text_delta", contentIndex: 0, text: "chunk" };
  assert.deepEqual(mapAgentEventToProgress(e), {
    type: "text_delta",
    text: "chunk",
  });
});

test("progress whitelist: text_end and assistant_text are NOT forwarded (avoid body duplication)", () => {
  assert.equal(
    mapAgentEventToProgress({ type: "text_end", contentIndex: 0, text: "full" }),
    null,
  );
  assert.equal(
    mapAgentEventToProgress({ type: "assistant_text", text: "full" }),
    null,
  );
});

test("progress whitelist: reasoning_* and thinking are never forwarded (no model-reasoning leak)", () => {
  assert.equal(
    mapAgentEventToProgress({
      type: "reasoning_start",
      contentIndex: 0,
    }),
    null,
  );
  assert.equal(
    mapAgentEventToProgress({
      type: "reasoning_delta",
      contentIndex: 0,
      text: "internal chain of thought",
    }),
    null,
  );
  assert.equal(
    mapAgentEventToProgress({
      type: "reasoning_end",
      contentIndex: 0,
      text: "internal",
    }),
    null,
  );
  assert.equal(mapAgentEventToProgress({ type: "thinking", text: "hidden" }), null);
});

test("progress whitelist: tool_call produces a fixed summary from the tool NAME only", () => {
  const e: AgentEvent = {
    type: "tool_call",
    tool: "search_mail",
    input: { query: "super secret query that must not appear" },
  };
  const mapped = mapAgentEventToProgress(e);
  assert.equal(mapped?.type, "progress");
  assert.match(mapped!.text, /搜索邮件/);
  // raw input must never leak
  assert(!mapped!.text.includes("super secret"));
});

test("progress whitelist: tool_result shows only 成功/失败, never the observation/output", () => {
  const ok = mapAgentEventToProgress({
    type: "tool_result",
    tool: "read_mail",
    output: { body: "entire mail body that must not leak" },
    observation: "contact@secret.com",
  });
  assert.equal(ok?.type, "progress");
  assert.match(ok!.text, /完成/);
  assert(!ok!.text.includes("secret"));
  assert(!ok!.text.includes("contact"));

  const bad = mapAgentEventToProgress({
    type: "tool_result",
    tool: "read_mail",
    output: {},
    isError: true,
  });
  assert.match(bad!.text, /失败/);
});

test("progress whitelist: progress_update (user-visible copy) is forwarded", () => {
  const e: AgentEvent = { type: "progress_update", text: "正在处理你的请求" };
  assert.deepEqual(mapAgentEventToProgress(e), {
    type: "progress",
    text: "正在处理你的请求",
  });
});

test("progress whitelist: retry_* produce fixed status lines", () => {
  assert.match(
    mapAgentEventToProgress({
      type: "retry_started",
      attempt: 2,
      maxAttempts: 3,
    })!.text,
    /重试/,
  );
  assert.match(
    mapAgentEventToProgress({
      type: "retry_failed",
      attempt: 2,
      message: "boom",
    })!.text,
    /重试失败/,
  );
});

test("progress whitelist: conclusion / pending_action / done are not progress events", () => {
  assert.equal(
    mapAgentEventToProgress({
      type: "conclusion",
      status: "succeeded",
      summary: "done",
    }),
    null,
  );
  assert.equal(mapAgentEventToProgress({ type: "done" }), null);
});

test("tool summary covers known tool prefixes", () => {
  const sum = (tool: string) =>
    mapAgentEventToProgress({ type: "tool_call", tool, input: {} })!.text;
  assert.match(sum("read_mail"), /读取/);
  assert.match(sum("summarize_thread"), /摘要/);
  assert.match(sum("draft_reply"), /撰写/);
  assert.match(sum("publish_design_artifact"), /报告/);
  // unknown tools get a generic label, never raw input
  assert.match(sum("some_unknown_tool"), /处理中/);
});
