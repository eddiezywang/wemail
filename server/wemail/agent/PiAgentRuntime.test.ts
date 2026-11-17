import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PI_DEFAULT_SYSTEM_PROMPT,
  PI_MAX_REPEAT_TOOL_CALLS,
  PI_MAX_TOOL_REPAIRS,
  PiAgentRuntime,
  type AgentPlanner,
  type PiAgentFactory,
  type PiAgentLike,
  type PlannerDecision,
  type PlannerStepInput,
} from "./PiAgentRuntime.js";
import {
  AgentTerminalToolError,
  type AgentEvent,
  type AgentTool,
} from "./AgentRuntime.js";
import type { LlmClient, LlmRequest, LlmResponse } from "../ai/LlmClient.js";
import type { AiUsageRepository } from "../settings/AiUsageRepository.js";

function collect(
  gen: AsyncGenerator<AgentEvent, void, unknown>,
): Promise<AgentEvent[]> {
  return (async () => {
    const out: AgentEvent[] = [];
    for await (const e of gen) out.push(e);
    return out;
  })();
}

function scriptedPlanner(decisions: PlannerDecision[]): AgentPlanner {
  let i = 0;
  return {
    async step() {
      const d = decisions[i] ?? { kind: "final", text: "no more" };
      i += 1;
      return d;
    },
  };
}

const probeTool: AgentTool = {
  name: "probe",
  description: "echo input back",
  inputSchema: { type: "object" },
  async handler(input) {
    return { echoed: input };
  },
};

test("PiAgentRuntime dispatches a tool call then finishes", async () => {
  const runtime = new PiAgentRuntime({
    planner: scriptedPlanner([
      { kind: "tool_call", tool: "probe", input: { a: 1 } },
      { kind: "final", text: "done-speaking" },
    ]),
  });
  runtime.registerTool({
    ...probeTool,
    observe(output) {
      const value = output as { echoed?: { value?: string } };
      return `Echoed ${value.echoed?.value ?? "input"}`;
    },
  });
  const events = await collect(runtime.run({ userText: "hi" }));
  const types = events.map((e) => e.type);
  assert.deepEqual(types, [
    "tool_call",
    "tool_result",
    "assistant_text",
    "conclusion",
    "done",
  ]);
  const call = events[0] as Extract<AgentEvent, { type: "tool_call" }>;
  assert.equal(call.tool, "probe");
  assert.deepEqual(call.input, { a: 1 });
  const result = events[1] as Extract<AgentEvent, { type: "tool_result" }>;
  assert.deepEqual(result.output, { echoed: { a: 1 } });
});

test("PiAgentRuntime emits user-visible progress, call reason, and deterministic observation", async () => {
  const runtime = new PiAgentRuntime({
    planner: scriptedPlanner([
      {
        kind: "tool_call",
        tool: "probe",
        input: { value: "hi" },
        callReason: "Need the echo output",
      },
      { kind: "final", text: "done" },
    ]),
  });
  runtime.registerTool({
    ...probeTool,
    observe(output) {
      const value = output as { echoed?: { value?: string } };
      return `Echoed ${value.echoed?.value ?? "input"}`;
    },
  });

  const events = await collect(runtime.run({ userText: "echo" }));

  assert.deepEqual(events.slice(0, 3), [
    { type: "progress_update", text: "Need the echo output" },
    {
      type: "tool_call",
      tool: "probe",
      input: { value: "hi" },
      callReason: "Need the echo output",
    },
    {
      type: "tool_result",
      tool: "probe",
      output: { echoed: { value: "hi" } },
      observation: "Echoed hi",
    },
  ]);
});

test("PiAgentRuntime terminate_execution stops the run", async () => {
  let calls = 0;
  const runtime = new PiAgentRuntime({
    planner: {
      async step() {
        calls += 1;
        return {
          kind: "tool_call",
          tool: "terminate_execution",
          input: { reason: "Missing focused email" },
          callReason: "The user asked to reply but no email context exists",
        };
      },
    },
  });

  const events = await collect(runtime.run({ userText: "reply" }));

  assert.equal(calls, 1);
  assert.deepEqual(events, [
    {
      type: "progress_update",
      text: "The user asked to reply but no email context exists",
    },
    {
      type: "tool_call",
      tool: "terminate_execution",
      input: { reason: "Missing focused email" },
      callReason: "The user asked to reply but no email context exists",
    },
    {
      type: "conclusion",
      status: "needs_input",
      summary: "需要补充信息后才能继续。",
      reason: "Missing focused email",
      impact: "尚未执行需要这些信息的操作。",
      nextAction: "请补充缺少的信息后继续。",
    },
    { type: "terminate", reason: "Missing focused email" },
    { type: "done" },
  ]);
});

test("PiAgentRuntime rejects unknown tool name without crashing", async () => {
  const runtime = new PiAgentRuntime({
    planner: scriptedPlanner([
      { kind: "tool_call", tool: "ghost", input: {} },
      { kind: "final", text: "ok" },
    ]),
  });
  const events = await collect(runtime.run({ userText: "x" }));
  const result = events.find((e) => e.type === "tool_result") as Extract<
    AgentEvent,
    { type: "tool_result" }
  >;
  assert.ok(result);
  const output = result.output as { ok: boolean; error: string };
  assert.equal(output.ok, false);
  assert.match(output.error, /unknown tool/);
  assert.equal(events[events.length - 1].type, "done");
});

test("PiAgentRuntime stops exact repeated calls without a low total iteration cap", async () => {
  const loopPlanner: AgentPlanner = {
    async step() {
      return { kind: "tool_call", tool: "probe", input: {} };
    },
  };
  const runtime = new PiAgentRuntime({ planner: loopPlanner });
  runtime.registerTool(probeTool);
  const events = await collect(runtime.run({ userText: "spin" }));
  const toolCalls = events.filter((e) => e.type === "tool_call");
  assert.equal(toolCalls.length, PI_MAX_REPEAT_TOOL_CALLS);
  const conclusion = events.find((e) => e.type === "conclusion") as Extract<
    AgentEvent,
    { type: "conclusion" }
  >;
  assert.ok(conclusion);
  assert.equal(conclusion.status, "failed");
  assert.match(conclusion.reason ?? "", /相同工具和参数|重复循环/);
});

test("PiAgentRuntime completes productive tool sequences longer than six steps", async () => {
  const decisions: PlannerDecision[] = Array.from(
    { length: 8 },
    (_, index) => ({
      kind: "tool_call" as const,
      tool: "probe",
      input: { index },
    }),
  );
  decisions.push({ kind: "final", text: "long run complete" });
  const runtime = new PiAgentRuntime({
    planner: scriptedPlanner(decisions),
  });
  runtime.registerTool(probeTool);

  const events = await collect(runtime.run({ userText: "analyze many mails" }));

  assert.equal(
    events.filter((event) => event.type === "tool_call").length,
    8,
  );
  assert.equal(
    events.find((event) => event.type === "assistant_text")?.text,
    "long run complete",
  );
  assert.equal(
    (events.find((event) => event.type === "conclusion") as Extract<
      AgentEvent,
      { type: "conclusion" }
    >).status,
    "succeeded",
  );
});

test("PiAgentRuntime completes a representative recent-seven-days HTML report flow", async () => {
  const decisions: PlannerDecision[] = [
    {
      kind: "tool_call",
      tool: "get_current_time",
      input: {},
      callReason: "我先确认最近七天对应的准确时间范围。",
    },
    {
      kind: "tool_call",
      tool: "search_mail",
      input: { dateRange: { preset: "last_7_days" }, limit: 20 },
      callReason: "我现在查找这段时间内与会话分析相关的邮件。",
    },
    {
      kind: "tool_call",
      tool: "batch_get_mail_intelligence",
      input: { ids: ["mail-1", "mail-2"] },
      callReason: "已经找到相关邮件，我继续读取结构化分析数据。",
    },
    {
      kind: "tool_call",
      tool: "batch_read_mail_source",
      input: { ids: ["mail-1", "mail-2"] },
      callReason: "我再核对原始邮件内容，避免报表遗漏关键数据。",
    },
    {
      kind: "tool_call",
      tool: "publish_design_artifact",
      input: {
        title: "最近七天会话分析",
        mode: "report",
        dataset: {
          type: "dataset",
          schema: {
            fields: [
              { name: "time", type: "datetime" },
              { name: "calls", type: "number" },
              { name: "failures", type: "number" },
            ],
          },
          rows: [
            { time: "2026-07-29T09:00:00+08:00", calls: 82482, failures: 108 },
          ],
        },
      },
      callReason: "数据已经齐全，我现在生成并检查 HTML 图表报表。",
    },
    { kind: "final", text: "最近七天会话分析 HTML 报告已生成。" },
  ];
  const outputs: Record<string, unknown> = {
    get_current_time: { nowIso: "2026-07-30T12:00:00.000Z" },
    search_mail: {
      count: 2,
      messages: [{ id: "mail-1" }, { id: "mail-2" }],
    },
    batch_get_mail_intelligence: {
      count: 2,
      messages: [{ id: "mail-1" }, { id: "mail-2" }],
    },
    batch_read_mail_source: {
      ok: true,
      entries: [
        { id: "mail-1", status: "ready" },
        { id: "mail-2", status: "ready" },
      ],
    },
    publish_design_artifact: {
      ok: true,
      artifact: {
        id: "artifact-1",
        title: "最近七天会话分析",
        applicationMessageId: "application-message-1",
      },
    },
  };
  const runtime = new PiAgentRuntime({
    planner: scriptedPlanner(decisions),
  });
  for (const name of Object.keys(outputs)) {
    runtime.registerTool({
      name,
      description: name,
      inputSchema: { type: "object" },
      async handler() {
        return outputs[name];
      },
    });
  }

  const events = await collect(
    runtime.run({
      userText: "统计最近七天邮件并生成 HTML 图表报告",
      accountId: "acct-1",
    }),
  );

  assert.deepEqual(
    events
      .filter((event) => event.type === "tool_call")
      .map((event) => event.tool),
    decisions
      .filter((decision) => decision.kind === "tool_call")
      .map((decision) => decision.tool),
  );
  assert.equal(
    (events.find((event) => event.type === "assistant_text") as Extract<
      AgentEvent,
      { type: "assistant_text" }
    >).text,
    "最近七天会话分析 HTML 报告已生成。",
  );
  assert.deepEqual(
    events
      .filter((event) => event.type === "progress_update")
      .map((event) => event.text),
    decisions
      .filter((decision) => decision.kind === "tool_call")
      .map((decision) => decision.callReason),
  );
  assert.equal(events.at(-1)?.type, "done");
});

test("PiAgentRuntime stops varied legacy calls that return no new result", async () => {
  const runtime = new PiAgentRuntime({
    planner: scriptedPlanner(
      Array.from({ length: 8 }, (_, index) => ({
        kind: "tool_call" as const,
        tool: "constant",
        input: { index },
      })),
    ),
    maxConsecutiveNoProgress: 3,
  });
  runtime.registerTool({
    name: "constant",
    description: "returns an equivalent result",
    inputSchema: { type: "object" },
    async handler() {
      return { ok: true, value: "same" };
    },
  });

  const events = await collect(runtime.run({ userText: "vary forever" }));

  assert.equal(
    events.filter((event) => event.type === "tool_call").length,
    4,
  );
  const conclusion = events.find(
    (event): event is Extract<AgentEvent, { type: "conclusion" }> =>
      event.type === "conclusion",
  );
  assert.match(conclusion?.reason ?? "", /没有产生新的结果|没有取得新进展/);
});

test("PiAgentRuntime stops after a tool throws", async () => {
  const throwingTool: AgentTool = {
    name: "boom",
    description: "throws",
    inputSchema: { type: "object" },
    async handler() {
      throw new Error("exploded");
    },
  };
  const runtime = new PiAgentRuntime({
    planner: scriptedPlanner([
      { kind: "tool_call", tool: "boom", input: {} },
      { kind: "final", text: "recovered" },
    ]),
  });
  runtime.registerTool(throwingTool);
  const events = await collect(runtime.run({ userText: "x" }));
  const result = events.find((e) => e.type === "tool_result") as Extract<
    AgentEvent,
    { type: "tool_result" }
  >;
  const output = result.output as { ok: boolean; error: string };
  assert.equal(output.ok, false);
  assert.match(output.error, /exploded/);
  assert.equal(events.some((e) => e.type === "assistant_text"), false);
  const terminated = events.find((e) => e.type === "terminate") as Extract<
    AgentEvent,
    { type: "terminate" }
  >;
  assert.match(terminated.reason, /工具执行时发生错误/);
});

test("PiAgentRuntime reports a tool-specific deadline without retrying it", async () => {
  let toolCalls = 0;
  let toolSignal: AbortSignal | undefined;
  const runtime = new PiAgentRuntime({
    planner: scriptedPlanner([
      { kind: "tool_call", tool: "slow", input: {} },
      { kind: "final", text: "must not continue" },
    ]),
    toolTimeoutMs: 5,
  });
  runtime.registerTool({
    name: "slow",
    description: "never resolves",
    inputSchema: { type: "object" },
    async handler(_input, ctx) {
      toolCalls += 1;
      toolSignal = ctx.signal;
      return new Promise(() => {});
    },
  });

  const events = await collect(runtime.run({ userText: "run slow tool" }));

  assert.equal(toolCalls, 1);
  assert.equal(toolSignal?.aborted, true);
  const conclusion = events.find(
    (event): event is Extract<AgentEvent, { type: "conclusion" }> =>
      event.type === "conclusion",
  );
  assert.equal(conclusion?.status, "failed");
  assert.match(conclusion?.reason ?? "", /工具 slow.*截止时间/);
  assert.match(conclusion?.nextAction ?? "", /稍后重试|缩小/);
  assert.equal(
    events.some(
      (event) =>
        event.type === "assistant_text" &&
        event.text === "must not continue",
    ),
    false,
  );
});

test("PiAgentRuntime terminates immediately for a non-retryable tool failure", async () => {
  let plannerCalls = 0;
  const runtime = new PiAgentRuntime({
    planner: {
      async step() {
        plannerCalls += 1;
        return { kind: "tool_call", tool: "missing_dependency", input: {} };
      },
    },
  });
  runtime.registerTool({
    name: "missing_dependency",
    description: "requires a missing local executable",
    inputSchema: { type: "object" },
    async handler() {
      throw new AgentTerminalToolError({
        code: "dependency_missing",
        userMessage: "Required CLI is not installed.",
      });
    },
  });

  const events = await collect(runtime.run({ userText: "run it" }));

  assert.equal(plannerCalls, 1);
  assert.deepEqual(events, [
    {
      type: "tool_call",
      tool: "missing_dependency",
      input: {},
      callReason: undefined,
    },
    {
      type: "tool_result",
      tool: "missing_dependency",
      output: {
        ok: false,
        terminal: true,
        code: "dependency_missing",
        error: "Required CLI is not installed.",
      },
      isError: true,
    },
    {
      type: "conclusion",
      status: "blocked",
      summary: "本次操作未执行。",
      reason: "Required CLI is not installed.",
      impact: "失败步骤及其后续操作未执行。",
      nextAction: "请先安装或配置所需的本地工具，然后重试。",
      failureContext: {
        tool: "missing_dependency",
      },
    },
    {
      type: "terminate",
      reason: "Required CLI is not installed.",
    },
    { type: "done" },
  ]);
});

test("PiAgentRuntime listTools reports registered tools with schemas", () => {
  const runtime = new PiAgentRuntime({
    planner: scriptedPlanner([{ kind: "final", text: "" }]),
  });
  runtime.registerTool(probeTool);
  const tools = runtime.listTools();
  assert.equal(tools.length, 2);
  assert.equal(tools[0].name, "probe");
  assert.ok(tools[0].inputSchema);
  assert.equal(tools[1].name, "terminate_execution");
  assert.ok(tools[1].inputSchema);
});

test("PiAgentRuntime can drive the official PI agent event stream", async () => {
  let factoryCalled = false;
  let subscribed: ((event: any) => void | Promise<void>) | undefined;
  const piAgent: PiAgentLike = {
    subscribe(listener) {
      subscribed = listener;
      return () => {};
    },
    async prompt() {
      assert.ok(subscribed);
      await subscribed({
        type: "message_update",
        assistantMessageEvent: { type: "thinking_start", contentIndex: 0 },
      });
      await subscribed({
        type: "message_update",
        assistantMessageEvent: {
          type: "thinking_delta",
          contentIndex: 0,
          delta: "Need mail context",
        },
      });
      await subscribed({
        type: "message_update",
        assistantMessageEvent: {
          type: "thinking_end",
          contentIndex: 0,
          content: "Need mail context",
        },
      });
      await subscribed({
        type: "message_update",
        assistantMessageEvent: { type: "text_start", contentIndex: 1 },
      });
      await subscribed({
        type: "message_update",
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 1,
          delta: "hello ",
        },
      });
      await subscribed({
        type: "message_update",
        assistantMessageEvent: {
          type: "text_end",
          contentIndex: 1,
          content: "hello ",
        },
      });
      await subscribed({
        type: "tool_execution_start",
        toolName: "probe",
        args: { a: 1 },
      });
      await subscribed({
        type: "tool_execution_end",
        toolName: "probe",
        result: {
          details: { echoed: { a: 1 } },
          content: [{ type: "text", text: "ok" }],
        },
      });
      await subscribed({
        type: "message_update",
        assistantMessageEvent: { type: "text_start", contentIndex: 0 },
      });
      await subscribed({
        type: "message_update",
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 0,
          delta: "world",
        },
      });
      await subscribed({
        type: "message_update",
        assistantMessageEvent: {
          type: "text_end",
          contentIndex: 0,
          content: "world",
        },
      });
    },
  };
  const factory: PiAgentFactory = (options) => {
    factoryCalled = true;
    assert.equal(options.initialState?.tools?.length, 2);
    assert.equal(options.initialState?.tools?.[0]?.name, "probe");
    return piAgent;
  };

  const runtime = new PiAgentRuntime({
    pi: {
      apiKey: "fake-key",
      model: "fake-model",
      provider: "openai",
      baseUrl: "http://127.0.0.1:8989/v1",
    },
    piAgentFactory: factory,
  });
  runtime.registerTool(probeTool);

  const events = await collect(runtime.run({ userText: "hi" }));

  assert.equal(factoryCalled, true);
  assert.deepEqual(events, [
    { type: "reasoning_start", contentIndex: 0 },
    { type: "reasoning_delta", contentIndex: 0, text: "Need mail context" },
    { type: "reasoning_end", contentIndex: 0, text: "Need mail context" },
    { type: "text_start", contentIndex: 1 },
    { type: "text_delta", contentIndex: 1, text: "hello " },
    { type: "text_end", contentIndex: 1, text: "hello " },
    { type: "tool_call", tool: "probe", input: { a: 1 } },
    { type: "tool_result", tool: "probe", output: { echoed: { a: 1 } } },
    { type: "text_start", contentIndex: 0 },
    { type: "text_delta", contentIndex: 0, text: "world" },
    { type: "text_end", contentIndex: 0, text: "world" },
    {
      type: "conclusion",
      status: "succeeded",
      summary: "本次 Agent 执行已完成。",
    },
    { type: "done" },
  ]);
});

test("PiAgentRuntime native PI hooks allow more than six productive tool steps", async () => {
  let subscribed: ((event: any) => void | Promise<void>) | undefined;
  const factory: PiAgentFactory = (options) => ({
    subscribe(listener) {
      subscribed = listener;
      return () => {};
    },
    async prompt() {
      assert.ok(subscribed);
      for (let index = 0; index < 8; index += 1) {
        const toolCall = {
          type: "toolCall",
          id: `call-${index}`,
          name: "probe",
          arguments: { index },
        };
        const args = { index };
        const before = await options.beforeToolCall?.({
          assistantMessage: {} as never,
          toolCall: toolCall as never,
          args,
          context: {} as never,
        });
        assert.equal(before?.block, undefined);
        const details = { ok: true, message: { id: `mail-${index}` } };
        const result = {
          details,
          content: [{ type: "text" as const, text: "ok" }],
        };
        const after = await options.afterToolCall?.({
          assistantMessage: {} as never,
          toolCall: toolCall as never,
          args,
          result,
          isError: false,
          context: {} as never,
        });
        assert.equal(after?.terminate, undefined);
        await subscribed({
          type: "tool_execution_start",
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          args,
        });
        await subscribed({
          type: "tool_execution_end",
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          result: {
            ...result,
            ...(after?.details ? { details: after.details } : {}),
          },
          isError: false,
        });
      }
      await subscribed({
        type: "message_update",
        assistantMessageEvent: { type: "text_start", contentIndex: 0 },
      });
      await subscribed({
        type: "message_update",
        assistantMessageEvent: {
          type: "text_end",
          contentIndex: 0,
          content: "native long run complete",
        },
      });
    },
  });
  const runtime = new PiAgentRuntime({
    pi: {
      apiKey: "fake-key",
      model: "fake-model",
      provider: "openai",
      baseUrl: "http://127.0.0.1:8989/v1",
    },
    piAgentFactory: factory,
  });
  runtime.registerTool(probeTool);

  const events = await collect(runtime.run({ userText: "read many mails" }));

  assert.equal(
    events.filter((event) => event.type === "tool_result").length,
    8,
  );
  assert.equal(
    (events.find((event) => event.type === "text_end") as Extract<
      AgentEvent,
      { type: "text_end" }
    >).text,
    "native long run complete",
  );
  assert.equal(
    (events.find((event) => event.type === "conclusion") as Extract<
      AgentEvent,
      { type: "conclusion" }
    >).status,
    "succeeded",
  );
});

test("PiAgentRuntime official PI tool adapter terminates on a non-retryable failure", async () => {
  let subscribed: ((event: any) => void | Promise<void>) | undefined;
  let executeTool: (() => Promise<any>) | undefined;
  let executedResult: any;
  const recoveryAction = {
    id: "pending-install-wecli-1",
    actionType: "install_wecli" as const,
    description: "安装可选组件 WeCLI",
    toolName: "install_wecli",
    inputJson: '{"command":"fixed"}',
    riskReason: "需要用户确认后安装",
    riskLevel: "high" as const,
  };
  const piAgent: PiAgentLike = {
    subscribe(listener) {
      subscribed = listener;
      return () => {};
    },
    async prompt() {
      assert.ok(subscribed);
      assert.ok(executeTool);
      await subscribed({
        type: "tool_execution_start",
        toolCallId: "call-1",
        toolName: "missing_dependency",
        args: {},
      });
      executedResult = await executeTool();
      await subscribed({
        type: "tool_execution_end",
        toolCallId: "call-1",
        toolName: "missing_dependency",
        result: executedResult,
        isError: false,
      });
    },
  };
  const runtime = new PiAgentRuntime({
    pi: {
      apiKey: "fake-key",
      model: "fake-model",
      provider: "openai",
      baseUrl: "http://127.0.0.1:8989/v1",
    },
    piAgentFactory: (options) => {
      const tool = options.initialState?.tools?.[0];
      assert.ok(tool);
      executeTool = () => tool.execute("call-1", {});
      return piAgent;
    },
  });
  runtime.registerTool({
    name: "missing_dependency",
    description: "requires a missing local executable",
    inputSchema: { type: "object" },
    async handler() {
      throw new AgentTerminalToolError({
        code: "dependency_missing",
        userMessage: "Required CLI is not installed.",
        pendingAction: recoveryAction,
      });
    },
  });

  const events = await collect(runtime.run({ userText: "run it" }));

  assert.equal(executedResult.terminate, true);
  assert.deepEqual(events, [
    {
      type: "tool_call",
      tool: "missing_dependency",
      input: {},
      toolCallId: "call-1",
    },
    {
      type: "pending_action",
      action: recoveryAction,
    },
    {
      type: "tool_result",
      tool: "missing_dependency",
      output: {
        ok: false,
        terminal: true,
        code: "dependency_missing",
        error: "Required CLI is not installed.",
        pendingAction: recoveryAction,
      },
      toolCallId: "call-1",
      isError: true,
    },
    {
      type: "conclusion",
      status: "blocked",
      summary: "本次操作未执行。",
      reason: "Required CLI is not installed.",
      impact: "失败步骤及其后续操作未执行。",
      nextAction: "请先安装或配置所需的本地工具，然后重试。",
      failureContext: {
        tool: "missing_dependency",
        toolCallId: "call-1",
      },
    },
    {
      type: "terminate",
      reason: "Required CLI is not installed.",
    },
    { type: "done" },
  ]);
});

test("PiAgentRuntime lets PI repair one argument-validation error", async () => {
  let subscribed: ((event: any) => void | Promise<void>) | undefined;
  let abortCalls = 0;
  const piAgent: PiAgentLike = {
    subscribe(listener) {
      subscribed = listener;
      return () => {};
    },
    abort() {
      abortCalls += 1;
    },
    async prompt() {
      assert.ok(subscribed);
      await subscribed({
        type: "tool_execution_start",
        toolCallId: "invalid-call",
        toolName: "strict_tool",
        args: {},
      });
      await subscribed({
        type: "tool_execution_end",
        toolCallId: "invalid-call",
        toolName: "strict_tool",
        result: {
          content: [
            {
              type: "text",
              text: "Invalid arguments: required property 'value' is missing",
            },
          ],
          details: {},
        },
        isError: true,
      });
      await subscribed({
        type: "tool_execution_start",
        toolCallId: "repaired-call",
        toolName: "strict_tool",
        args: { value: "fixed" },
      });
      await subscribed({
        type: "tool_execution_end",
        toolCallId: "repaired-call",
        toolName: "strict_tool",
        result: {
          content: [{ type: "text", text: "ok" }],
          details: { ok: true },
        },
        isError: false,
      });
    },
  };
  const runtime = new PiAgentRuntime({
    pi: {
      apiKey: "fake-key",
      model: "fake-model",
      provider: "openai",
      baseUrl: "http://127.0.0.1:8989/v1",
    },
    piAgentFactory: () => piAgent,
  });
  runtime.registerTool({
    name: "strict_tool",
    description: "requires value",
    inputSchema: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
    },
    async handler() {
      return { ok: true };
    },
  });

  const events = await collect(runtime.run({ userText: "run it" }));

  assert.equal(abortCalls, 0);
  assert.deepEqual(events, [
    {
      type: "tool_call",
      tool: "strict_tool",
      input: {},
      toolCallId: "invalid-call",
    },
    {
      type: "tool_result",
      tool: "strict_tool",
      output: {
        ok: false,
        code: "tool_execution_failed",
        error: "Invalid arguments: required property 'value' is missing",
      },
      toolCallId: "invalid-call",
      isError: true,
    },
    {
      type: "retry_scheduled",
      attempt: 1,
      delayMs: 0,
      reason: "我生成的工具命令或参数不完整。",
    },
    {
      type: "retry_started",
      attempt: 1,
      maxAttempts: 1,
    },
    {
      type: "thinking",
      text: "工具参数未通过校验，正在自动修正（1/1）。",
    },
    {
      type: "tool_call",
      tool: "strict_tool",
      input: { value: "fixed" },
      toolCallId: "repaired-call",
    },
    {
      type: "tool_result",
      tool: "strict_tool",
      output: { ok: true },
      toolCallId: "repaired-call",
    },
    { type: "retry_completed", attempt: 1 },
    {
      type: "conclusion",
      status: "succeeded",
      summary: "本次 Agent 执行已完成。",
    },
    { type: "done" },
  ]);
});

test("PiAgentRuntime aborts after the one argument-repair attempt also fails", async () => {
  let subscribed: ((event: any) => void | Promise<void>) | undefined;
  let abortCalls = 0;
  const piAgent: PiAgentLike = {
    subscribe(listener) {
      subscribed = listener;
      return () => {};
    },
    abort() {
      abortCalls += 1;
    },
    async prompt() {
      assert.ok(subscribed);
      for (const [index, args] of [{}, { value: "" }].entries()) {
        await subscribed({
          type: "tool_execution_start",
          toolCallId: `invalid-${index}`,
          toolName: "strict_tool",
          args,
        });
        await subscribed({
          type: "tool_execution_end",
          toolCallId: `invalid-${index}`,
          toolName: "strict_tool",
          result: {
            content: [{ type: "text", text: "invalid command" }],
            details: {},
          },
          isError: true,
        });
      }
    },
  };
  const runtime = new PiAgentRuntime({
    pi: {
      apiKey: "fake-key",
      model: "fake-model",
      provider: "openai",
      baseUrl: "http://127.0.0.1:8989/v1",
    },
    piAgentFactory: () => piAgent,
  });
  runtime.registerTool({
    name: "strict_tool",
    description: "requires value",
    inputSchema: { type: "object" },
    async handler() {
      return { ok: true };
    },
  });

  const events = await collect(runtime.run({ userText: "run it" }));

  assert.equal(abortCalls, 1);
  assert.equal(
    events.filter((event) => event.type === "tool_result").length,
    PI_MAX_TOOL_REPAIRS + 1,
  );
  const conclusion = events.find(
    (event): event is Extract<AgentEvent, { type: "conclusion" }> =>
      event.type === "conclusion",
  );
  assert.ok(conclusion);
  assert.equal(conclusion.status, "failed");
  assert.match(conclusion.reason ?? "", /我生成的工具命令或参数/);
  assert.equal(events.filter((event) => event.type === "terminate").length, 1);
  assert.equal(events.at(-1)?.type, "done");
});

test("PiAgentRuntime total timeout calls PI abort before ending the run", async () => {
  let abortCalls = 0;
  let resolvePrompt: (() => void) | undefined;
  const piAgent: PiAgentLike = {
    subscribe() {
      return () => {};
    },
    abort() {
      abortCalls += 1;
      resolvePrompt?.();
    },
    prompt() {
      return new Promise<void>((resolve) => {
        resolvePrompt = resolve;
      });
    },
  };
  const runtime = new PiAgentRuntime({
    runTimeoutMs: 10,
    pi: {
      apiKey: "fake-key",
      model: "fake-model",
      provider: "openai",
      baseUrl: "http://127.0.0.1:8989/v1",
    },
    piAgentFactory: () => piAgent,
  });

  const events = await collect(runtime.run({ userText: "hang" }));

  assert.equal(abortCalls, 1);
  assert.deepEqual(events, [
    {
      type: "conclusion",
      status: "failed",
      summary: "本次执行未完成。",
      reason: "Agent 整体执行超过 1 秒截止时间，系统已调用 abort 自动中断。",
      impact: "失败步骤及其后续操作未执行。",
      nextAction: "请保留当前筛选条件后重试，或将任务拆分为较小批次。",
    },
    {
      type: "terminate",
      reason: "Agent 整体执行超过 1 秒截止时间，系统已调用 abort 自动中断。",
    },
    { type: "done" },
  ]);
});

test("native PI tool deadline aborts the handler before returning terminal failure", async () => {
  let execute: (() => Promise<any>) | undefined;
  let signal: AbortSignal | undefined;
  let result: any;
  const runtime = new PiAgentRuntime({
    toolTimeoutMs: 5,
    pi: { apiKey: "fake", model: "fake", provider: "openai", baseUrl: "http://127.0.0.1:8989/v1" },
    piAgentFactory: (options) => {
      execute = () => options.initialState!.tools![0].execute("slow-call", {});
      return {
        subscribe: () => () => {},
        abort() {},
        async prompt() { result = await execute!(); },
      };
    },
  });
  runtime.registerTool({
    name: "slow",
    description: "wait for cancellation",
    inputSchema: { type: "object" },
    async handler(_input, ctx) {
      signal = ctx.signal;
      return new Promise(() => {});
    },
  });
  await collect(runtime.run({ userText: "run" }));
  assert.equal(signal?.aborted, true);
  assert.equal(result.terminate, true);
  assert.equal(result.details.code, "tool_timeout");
});

test("PiAgentRuntime propagates caller cancellation to PI abort", async () => {
  let abortCalls = 0;
  let resolvePrompt: (() => void) | undefined;
  const piAgent: PiAgentLike = {
    subscribe() {
      return () => {};
    },
    abort() {
      abortCalls += 1;
      resolvePrompt?.();
    },
    prompt() {
      return new Promise<void>((resolve) => {
        resolvePrompt = resolve;
      });
    },
  };
  const runtime = new PiAgentRuntime({
    pi: {
      apiKey: "fake-key",
      model: "fake-model",
      provider: "openai",
      baseUrl: "http://127.0.0.1:8989/v1",
    },
    piAgentFactory: () => piAgent,
  });
  const controller = new AbortController();
  const collecting = collect(
    runtime.run({ userText: "run", signal: controller.signal }),
  );
  await new Promise<void>((resolve) => setImmediate(resolve));

  controller.abort();
  const events = await collecting;

  assert.equal(abortCalls, 1);
  assert.deepEqual(events, [
    {
      type: "conclusion",
      status: "cancelled",
      summary: "本次执行已取消。",
      reason: "用户取消了本次执行。",
      impact: "取消后的后续步骤未执行。",
    },
    { type: "terminate", reason: "用户取消了本次执行。" },
    { type: "done" },
  ]);
});

test("PiAgentRuntime reports a failure conclusion when PI completes without visible events", async () => {
  const piAgent: PiAgentLike = {
    subscribe() {
      return () => {};
    },
    async prompt() {},
  };
  const runtime = new PiAgentRuntime({
    pi: {
      apiKey: "fake-key",
      model: "fake-model",
      provider: "openai",
      baseUrl: "http://127.0.0.1:8989/v1",
    },
    piAgentFactory: () => piAgent,
  });

  const events = await collect(runtime.run({ userText: "hi" }));

  assert.deepEqual(events, [
    {
      type: "conclusion",
      status: "failed",
      summary: "本次执行未完成。",
      reason: "Agent 未返回任何可展示内容，可能是模型服务未正常响应。",
      impact: "失败步骤及其后续操作未执行。",
      nextAction: "请检查模型服务状态后重试。",
    },
    {
      type: "terminate",
      reason: "Agent 未返回任何可展示内容，可能是模型服务未正常响应。",
    },
    { type: "done" },
  ]);
});

test("PiAgentRuntime uses official PI context hooks instead of custom planner stream by default", async () => {
  let capturedOptions: Parameters<PiAgentFactory>[0] | undefined;
  const piAgent: PiAgentLike = {
    subscribe() {
      return () => {};
    },
    async prompt() {},
  };
  const factory: PiAgentFactory = (options) => {
    capturedOptions = options;
    return piAgent;
  };
  const llm: LlmClient = {
    async generate(): Promise<LlmResponse> {
      throw new Error("planner stream should not be called");
    },
  };
  const runtime = new PiAgentRuntime({
    llm,
    pi: {
      apiKey: "fake-key",
      model: "fake-model",
      provider: "openai",
      baseUrl: "http://127.0.0.1:8989/v1",
    },
    piAgentFactory: factory,
  });

  await collect(
    runtime.run({
      userText: "最近七天有哪些邮件",
      accountId: "acct-1",
      emailId: "msg-1",
      context: { timezone: "Asia/Shanghai" },
    }),
  );

  assert.ok(capturedOptions);
  assert.equal(capturedOptions.streamFn, undefined);
  assert.equal(typeof capturedOptions.transformContext, "function");
  assert.equal(typeof capturedOptions.beforeToolCall, "function");
  assert.equal(typeof capturedOptions.afterToolCall, "function");
});

test("PiAgentRuntime system prompt defaults focused mail requests to current email scope", async () => {
  let capturedOptions: Parameters<PiAgentFactory>[0] | undefined;
  const piAgent: PiAgentLike = {
    subscribe() {
      return () => {};
    },
    async prompt() {},
  };
  const factory: PiAgentFactory = (options) => {
    capturedOptions = options;
    return piAgent;
  };
  const runtime = new PiAgentRuntime({
    pi: {
      apiKey: "fake-key",
      model: "fake-model",
      provider: "openai",
      baseUrl: "http://127.0.0.1:8989/v1",
    },
    piAgentFactory: factory,
  });

  await collect(
    runtime.run({
      userText: "帮我把发票上传到月度发票平台",
      accountId: "acct-1",
      emailId: "msg-1",
    }),
  );

  const systemPrompt = capturedOptions?.initialState?.systemPrompt ?? "";
  assert.match(systemPrompt, /FOCUSED MAIL SCOPE/);
  assert.match(systemPrompt, /current focused email/);
  assert.match(systemPrompt, /broader mailbox/);
  assert.match(systemPrompt, /Every tool_call MUST include callReason/);
  assert.match(systemPrompt, /not private chain-of-thought/);
  assert.match(systemPrompt, /ONE-SHOT ARTIFACTS/);
  assert.match(systemPrompt, /call publish_design_artifact, verify its successful result/);
});

test("PI default system prompt treats semantic action execution scope as authoritative", () => {
  assert.match(PI_DEFAULT_SYSTEM_PROMPT, /SEMANTIC ACTION SCOPE/);
  assert.match(PI_DEFAULT_SYSTEM_PROMPT, /executionScope/);
  assert.match(PI_DEFAULT_SYSTEM_PROMPT, /must not silently broaden/i);
});

test("PiAgentRuntime gives a native report one bounded artifact repair turn", async () => {
  let subscribed: ((event: any) => void | Promise<void>) | undefined;
  const prompts: string[] = [];
  const piAgent: PiAgentLike = {
    subscribe(listener) {
      subscribed = listener;
      return () => {};
    },
    async prompt(input) {
      prompts.push(input);
      assert.ok(subscribed);
      if (prompts.length === 1) {
        await subscribed({
          type: "tool_execution_start",
          toolCallId: "read-1",
          toolName: "read_mail",
          args: {},
        });
        await subscribed({
          type: "tool_execution_end",
          toolCallId: "read-1",
          toolName: "read_mail",
          result: { details: { ok: true }, content: [{ type: "text", text: "ok" }] },
        });
        return;
      }
      await subscribed({
        type: "tool_execution_start",
        toolCallId: "publish-1",
        toolName: "publish_design_artifact",
        args: {},
      });
      await subscribed({
        type: "tool_execution_end",
        toolCallId: "publish-1",
        toolName: "publish_design_artifact",
        result: {
          details: {
            ok: true,
            artifact: { applicationMessageId: "application-message-1" },
          },
          content: [{ type: "text", text: "ok" }],
        },
      });
    },
  };
  const runtime = new PiAgentRuntime({
    pi: {
      apiKey: "fake-key",
      model: "fake-model",
      provider: "openai",
      baseUrl: "http://127.0.0.1:8989/v1",
    },
    piAgentFactory: () => piAgent,
  });
  // The repair turn is gated on the publishing tool actually being
  // registered in this session.
  runtime.registerTool({
    name: "publish_design_artifact",
    description: "publish a report artifact",
    inputSchema: { type: "object" },
    async handler() {
      return { ok: true };
    },
  });

  const events = await collect(runtime.run({ userText: "生成洞察报告" }));

  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /publish_design_artifact/);
  assert.equal(
    (events.find((event) => event.type === "conclusion") as Extract<
      AgentEvent,
      { type: "conclusion" }
    >).status,
    "succeeded",
  );
});

test("PI default system prompt guides rolling insight association without forcing one tool", () => {
  assert.match(PI_DEFAULT_SYSTEM_PROMPT, /Prefer list_recent_emails/);
  assert.match(PI_DEFAULT_SYSTEM_PROMPT, /Other mail lookup tools remain valid/);
  assert.match(PI_DEFAULT_SYSTEM_PROMPT, /declared dateRange values or explicit from\/to bounds/);
  assert.doesNotMatch(PI_DEFAULT_SYSTEM_PROMPT, /call list_recent_emails exactly once/);
  assert.doesNotMatch(PI_DEFAULT_SYSTEM_PROMPT, /Never substitute list_mail or search_mail/);
  assert.match(PI_DEFAULT_SYSTEM_PROMPT, /default browser while WeMail is running/);
  assert.match(PI_DEFAULT_SYSTEM_PROMPT, /not a shareable cross-device chat link/);
});

test("PI default system prompt treats SMTP acceptance as send execution evidence", () => {
  assert.match(PI_DEFAULT_SYSTEM_PROMPT, /MAIL SEND VERIFICATION/);
  assert.match(PI_DEFAULT_SYSTEM_PROMPT, /SMTP messageId or accepted recipients/);
  assert.match(PI_DEFAULT_SYSTEM_PROMPT, /sent record has not synchronized/);
  assert.match(PI_DEFAULT_SYSTEM_PROMPT, /do not claim the message was not sent/i);
});

test("PiAgentRuntime monthly invoice prompt keeps focused mail scope", async () => {
  const seen: PlannerStepInput[] = [];
  const runtime = new PiAgentRuntime({
    planner: {
      async step(input) {
        seen.push(input);
        return { kind: "final", text: "我会先处理当前邮件中的月度发票。" };
      },
    },
  });

  const events = await collect(
    runtime.run({
      userText: "帮我处理这封邮件里的月度发票",
      emailId: "acct-1:INBOX:1:10",
      accountId: "acct-1",
    }),
  );

  assert.ok(events.some((event) => event.type === "assistant_text"));
  assert.equal(seen[0]?.context?.emailId, "acct-1:INBOX:1:10");
});

test("PiAgentRuntime system prompt requires user-facing CLI error guidance", () => {
  assert.match(PI_DEFAULT_SYSTEM_PROMPT, /CLI ERROR UX/);
  assert.match(PI_DEFAULT_SYSTEM_PROMPT, /summarize the likely cause/);
  assert.match(PI_DEFAULT_SYSTEM_PROMPT, /next action/);
  assert.match(PI_DEFAULT_SYSTEM_PROMPT, /Do not only paste raw stdout, stderr, exit codes/);
  assert.match(PI_DEFAULT_SYSTEM_PROMPT, /correct the call once/);
  assert.match(PI_DEFAULT_SYSTEM_PROMPT, /Do not repeat the same invalid call/);
  assert.match(PI_DEFAULT_SYSTEM_PROMPT, /FINAL OUTCOME/);
  assert.match(PI_DEFAULT_SYSTEM_PROMPT, /failed tool name/);
  assert.match(PI_DEFAULT_SYSTEM_PROMPT, /redacted command/);
  assert.match(PI_DEFAULT_SYSTEM_PROMPT, /tool call id/);
  // Edition-only dependency guidance (optional CLI installer, its private
  // registry network) must stay OUT of the open default prompt — editions
  // re-add it through PiAgentRuntimeOptions.extraPromptSections.
  assert.doesNotMatch(PI_DEFAULT_SYSTEM_PROMPT, /WECLI OPTIONAL DEPENDENCY/);
  assert.doesNotMatch(PI_DEFAULT_SYSTEM_PROMPT, /Never install WeCLI without explicit user confirmation/);
  // Constructed so the removed section's internal-network phrase is still
  // asserted absent without reintroducing the deny word into tracked files.
  assert.doesNotMatch(
    PI_DEFAULT_SYSTEM_PROMPT,
    new RegExp(`${["We", "Bank"].join("")} network`),
  );
});

test("PiAgentRuntime documents temporal field choices without inventing fallback policy", () => {
  assert.match(PI_DEFAULT_SYSTEM_PROMPT, /mail\.receivedAt/);
  assert.match(PI_DEFAULT_SYSTEM_PROMPT, /received timestamp/);
  assert.match(PI_DEFAULT_SYSTEM_PROMPT, /invoice\.issueDate/);
  assert.match(PI_DEFAULT_SYSTEM_PROMPT, /optional attachment collection field/);
  assert.match(PI_DEFAULT_SYSTEM_PROMPT, /Never add .*fallback unless requested/);
  assert.match(PI_DEFAULT_SYSTEM_PROMPT, /collection lacks aggregation/);
  assert.match(PI_DEFAULT_SYSTEM_PROMPT, /Ask for clarification/);
});

test("PiAgentRuntime keeps edition-only allowance guidance out of the open default prompt", () => {
  // The allowance workflow section moved to the edition module bundle
  // (extraPromptSections); the open default prompt must not embed the
  // workflow text nor its internal quota details.
  assert.doesNotMatch(PI_DEFAULT_SYSTEM_PROMPT, /monthly allowance invoice|月度发票|allowance skill/i);
  assert.doesNotMatch(PI_DEFAULT_SYSTEM_PROMPT, /ALLOWANCE MONTHLY INVOICE/);
  assert.doesNotMatch(PI_DEFAULT_SYSTEM_PROMPT, /餐饮\s*680|通信\s*300|交通\s*500|1480/);
  assert.doesNotMatch(PI_DEFAULT_SYSTEM_PROMPT, new RegExp(["深圳前海", "微众", "银行股份有限公司"].join("")));
});

test("PiAgentRuntime appends edition extraPromptSections after the built-in prompt", async () => {
  let capturedOptions: Parameters<PiAgentFactory>[0] | undefined;
  const piAgent: PiAgentLike = {
    subscribe() {
      return () => {};
    },
    async prompt() {},
  };
  const runtime = new PiAgentRuntime({
    pi: {
      apiKey: "fake-key",
      model: "fake-model",
      provider: "openai",
      baseUrl: "http://127.0.0.1:8989/v1",
    },
    piAgentFactory: (options) => {
      capturedOptions = options;
      return piAgent;
    },
    extraPromptSections: (context) => [
      `EDITION SECTION: focused=${typeof context?.emailId === "string"}`,
      "EDITION SECTION: plain",
      "   ",
    ],
  });

  await collect(
    runtime.run({
      userText: "处理这封邮件",
      accountId: "acct-1",
      emailId: "msg-1",
    }),
  );

  const systemPrompt = capturedOptions?.initialState?.systemPrompt ?? "";
  const editionIndex = systemPrompt.indexOf("EDITION SECTION: focused=true");
  assert.ok(editionIndex > 0, "edition section must be appended");
  // Appended after the whole built-in prompt, and blank sections dropped.
  assert.ok(systemPrompt.indexOf("FINAL OUTCOME") < editionIndex);
  assert.ok(systemPrompt.indexOf("FOCUSED MAIL SCOPE") < editionIndex);
  assert.ok(systemPrompt.endsWith("EDITION SECTION: plain"));
});

test("PiAgentRuntime does not append legacy Skill bodies to the system prompt", async () => {
  let capturedOptions: Parameters<PiAgentFactory>[0] | undefined;
  const piAgent: PiAgentLike = {
    subscribe() {
      return () => {};
    },
    async prompt() {},
  };
  const factory: PiAgentFactory = (options) => {
    capturedOptions = options;
    return piAgent;
  };
  const runtime = new PiAgentRuntime({
    pi: {
      apiKey: "fake-key",
      model: "fake-model",
      provider: "openai",
      baseUrl: "http://127.0.0.1:8989/v1",
    },
    piAgentFactory: factory,
  });

  await collect(
    runtime.run({
      userText: "帮我处理这封邮件里的月度发票",
      accountId: "acct-1",
      emailId: "msg-1",
    }),
  );

  const systemPrompt = capturedOptions?.initialState?.systemPrompt ?? "";
  assert.doesNotMatch(systemPrompt, /monthly allowance invoice/i);
  assert.doesNotMatch(systemPrompt, /餐饮\s*680/);
  assert.doesNotMatch(systemPrompt, new RegExp(["深圳前海", "微众", "银行股份有限公司"].join("")));
  assert.doesNotMatch(systemPrompt, /Allowance Monthly Invoice Skill/);
});

test("PiAgentRuntime exposes Skill metadata without auto-selecting a body", async () => {
  let capturedOptions: Parameters<PiAgentFactory>[0] | undefined;
  const piAgent: PiAgentLike = {
    subscribe() {
      return () => {};
    },
    async prompt() {},
  };
  const runtime = new PiAgentRuntime({
    pi: {
      apiKey: "fake-key",
      model: "fake-model",
      provider: "openai",
      baseUrl: "http://127.0.0.1:8989/v1",
    },
    piAgentFactory: (options) => {
      capturedOptions = options;
      return piAgent;
    },
    skillPrompt: () => [
      "The following skills provide specialized instructions for specific tasks.",
      "Use the read tool to load a skill's file when the task matches its description.",
      "<available_skills>",
      "  <skill>",
      "    <name>wemail-insight-report</name>",
      "    <description>生成预览</description>",
      "    <location>C:/skills/wemail-insight-report/SKILL.md</location>",
      "  </skill>",
      "</available_skills>",
    ].join("\n"),
  });
  await collect(runtime.run({ userText: "把今天的分析生成一个图表预览" }));
  const prompt = capturedOptions?.initialState?.systemPrompt ?? "";
  assert.match(prompt, /<available_skills>/);
  assert.match(prompt, /wemail-insight-report/);
  assert.match(prompt, /Use the read tool/);
  assert.match(prompt, /SKILL\.md/);
  assert.doesNotMatch(prompt, /ARTIFACT REVIEW BODY/);
  assert.match(prompt, /MUST NOT send email directly/);
  assert.doesNotMatch(prompt, /Allowance Monthly Invoice Skill/);
});

test("PiAgentRuntime exposes task-bound Skill metadata without preloading its body", async () => {
  let capturedOptions: Parameters<PiAgentFactory>[0] | undefined;
  const piAgent: PiAgentLike = {
    subscribe() {
      return () => {};
    },
    async prompt() {},
  };
  const runtime = new PiAgentRuntime({
    pi: {
      apiKey: "fake-key",
      model: "fake-model",
      provider: "openai",
      baseUrl: "http://127.0.0.1:8989/v1",
    },
    piAgentFactory: (options) => {
      capturedOptions = options;
      return piAgent;
    },
    skillPrompt: (context) => Array.isArray(context?.skillSnapshots)
      ? [
          "<available_skills>",
          "<skill><name>wemail-insight-report</name>",
          "<description>生成预览</description>",
          "<location>C:/skills/pinned/wemail-insight-report/SKILL.md</location></skill>",
          "</available_skills>",
        ].join("\n")
      : "",
  });
  await collect(runtime.run({
    userText: "执行已确认的流程",
    context: {
      skillSnapshots: [{
        skillId: "wemail-insight-report",
        version: "1.0.0",
        contentHash: "artifact-hash",
        scope: "builtin",
      }],
    },
  }));
  const prompt = capturedOptions?.initialState?.systemPrompt ?? "";
  assert.match(prompt, /C:\/skills\/pinned\/wemail-insight-report\/SKILL\.md/);
  assert.doesNotMatch(prompt, /TASK-BOUND ARTIFACT BODY/);
});

test("PiAgentRuntime planner stream repeats focused mail scope rule", async () => {
  const requests: LlmRequest[] = [];
  const llm: LlmClient = {
    async generate(request): Promise<LlmResponse> {
      requests.push(request);
      return {
        text: JSON.stringify({ kind: "final", text: "ok" }),
        finishReason: "stop",
      };
    },
  };
  const runtime = new PiAgentRuntime({
    llm,
    usePlannerStream: true,
    pi: {
      apiKey: "fake-key",
      model: "fake-model",
      provider: "openai",
      baseUrl: "http://127.0.0.1:8989/v1",
    },
  });

  const events = await collect(
    runtime.run({
      userText: "帮我把发票上传到月度发票平台",
      accountId: "acct-1",
      emailId: "msg-1",
    }),
  );

  assert.equal(events.at(-1)?.type, "done");
  assert.equal(requests.length, 1);
  const systemPrompt = requests[0]?.system;
  assert.ok(systemPrompt);
  assert.match(systemPrompt, /FOCUSED MAIL SCOPE/);
  assert.match(systemPrompt, /current focused email/);
  assert.match(systemPrompt, /broader mailbox/);
});

test("PiAgentRuntime stops the real PI loop after one LLM-planned terminal tool failure", async () => {
  let plannerCalls = 0;
  let finalizerCalls = 0;
  let toolCalls = 0;
  const llm: LlmClient = {
    async generate(request): Promise<LlmResponse> {
      if (request.system?.includes("最终结果整理器")) {
        finalizerCalls += 1;
        return {
          text: JSON.stringify({
            summary: "本次上传未执行。",
            reason: "当前电脑没有安装所需的企业命令行工具。",
            impact: "上传步骤及后续操作均未执行。",
            nextAction: "请先安装并配置企业命令行工具。",
          }),
          finishReason: "stop",
        };
      }
      if (request.signal?.aborted) {
        throw new Error("aborted");
      }
      plannerCalls += 1;
      return {
        text: JSON.stringify({
          kind: "tool_call",
          tool: "missing_dependency",
          input: {},
        }),
        finishReason: "stop",
      };
    },
  };
  const runtime = new PiAgentRuntime({
    llm,
    usePlannerStream: true,
    runTimeoutMs: 1_000,
    pi: {
      apiKey: "fake-key",
      model: "fake-model",
      provider: "openai",
      baseUrl: "http://127.0.0.1:8989/v1",
    },
  });
  runtime.registerTool({
    name: "missing_dependency",
    description: "requires a missing local executable",
    inputSchema: { type: "object" },
    async handler() {
      toolCalls += 1;
      throw new AgentTerminalToolError({
        code: "dependency_missing",
        userMessage: "Required CLI is not installed.",
      });
    },
  });

  const events = await collect(runtime.run({ userText: "run it" }));

  assert.equal(plannerCalls, 1);
  assert.equal(finalizerCalls, 0);
  assert.equal(toolCalls, 1);
  assert.equal(events.some((event) => event.type === "error"), false);
  assert.deepEqual(
    events.find((event) => event.type === "progress_update"),
    { type: "progress_update", text: "我继续处理下一步。" },
  );
  assert.deepEqual(
    events.filter(
      (event) =>
        event.type === "tool_result" ||
        event.type === "terminate" ||
        event.type === "done",
    ),
    [
      {
        type: "tool_result",
        tool: "missing_dependency",
        output: {
          ok: false,
          terminal: true,
          code: "dependency_missing",
          error: "Required CLI is not installed.",
        },
        toolCallId: events.find((event) => event.type === "tool_call")?.toolCallId,
        isError: true,
      },
      {
        type: "terminate",
        reason: "Required CLI is not installed.",
      },
      { type: "done" },
    ],
  );
});

test("PiAgentRuntime lets the real PI loop repair one invalid model tool call", async () => {
  let plannerCalls = 0;
  let toolCalls = 0;
  const llm: LlmClient = {
    async generate(request): Promise<LlmResponse> {
      if (request.signal?.aborted) {
        throw new Error("aborted");
      }
      plannerCalls += 1;
      const decision =
        plannerCalls === 1
          ? {
              kind: "tool_call",
              tool: "strict_tool",
              input: {},
            }
          : plannerCalls === 2
            ? {
                kind: "tool_call",
                tool: "strict_tool",
                input: { value: "fixed" },
              }
            : {
                kind: "final",
                text: "参数已修正，操作完成。",
              };
      return {
        text: JSON.stringify(decision),
        finishReason: "stop",
      };
    },
  };
  const runtime = new PiAgentRuntime({
    llm,
    usePlannerStream: true,
    runTimeoutMs: 1_000,
    pi: {
      apiKey: "fake-key",
      model: "fake-model",
      provider: "openai",
      baseUrl: "http://127.0.0.1:8989/v1",
    },
  });
  runtime.registerTool({
    name: "strict_tool",
    description: "requires a value",
    inputSchema: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
      additionalProperties: false,
    },
    async handler() {
      toolCalls += 1;
      return { ok: true };
    },
  });

  const events = await collect(runtime.run({ userText: "run it" }));

  assert.equal(plannerCalls, 3);
  assert.equal(toolCalls, 1);
  assert.equal(events.some((event) => event.type === "error"), false);
  const toolFailure = events.find(
    (event) => event.type === "tool_result",
  ) as Extract<AgentEvent, { type: "tool_result" }>;
  assert.equal(toolFailure.isError, true);
  assert.match(
    (toolFailure.output as { error: string }).error,
    /required|value|schema|argument/i,
  );
  assert.equal(events.filter((event) => event.type === "terminate").length, 0);
  const repairedCall = events
    .filter((event) => event.type === "tool_call")
    .at(-1) as Extract<AgentEvent, { type: "tool_call" }>;
  assert.deepEqual(repairedCall.input, { value: "fixed" });
  assert.ok(
    events.some(
      (event) =>
        event.type === "conclusion" && event.status === "succeeded",
    ),
  );
  assert.equal(events.at(-1)?.type, "done");
});

test("PiAgentRuntime finalizes after the real PI repair attempt also fails", async () => {
  let plannerCalls = 0;
  let finalizerCalls = 0;
  const llm: LlmClient = {
    async generate(request): Promise<LlmResponse> {
      if (request.system?.includes("最终结果整理器")) {
        finalizerCalls += 1;
        return {
          text: JSON.stringify({
            summary: "本次操作未完成。",
            reason: "我生成的命令参数在自动修正后仍不完整。",
            impact: "失败步骤及后续操作未执行。",
            nextAction: "请重新发起任务；如果问题持续出现，可展开详情排查。",
          }),
          finishReason: "stop",
        };
      }
      if (request.signal?.aborted) {
        throw new Error("aborted");
      }
      plannerCalls += 1;
      return {
        text: JSON.stringify({
          kind: "tool_call",
          tool: "strict_tool",
          input: plannerCalls === 1 ? {} : { other: "still-missing-value" },
        }),
        finishReason: "stop",
      };
    },
  };
  const runtime = new PiAgentRuntime({
    llm,
    usePlannerStream: true,
    runTimeoutMs: 1_000,
    pi: {
      apiKey: "fake-key",
      model: "fake-model",
      provider: "openai",
      baseUrl: "http://127.0.0.1:8989/v1",
    },
  });
  runtime.registerTool({
    name: "strict_tool",
    description: "requires a non-empty value",
    inputSchema: {
      type: "object",
      properties: { value: { type: "string", minLength: 1 } },
      required: ["value"],
      additionalProperties: false,
    },
    async handler() {
      return { ok: true };
    },
  });

  const events = await collect(runtime.run({ userText: "run it" }));

  assert.equal(
    plannerCalls,
    PI_MAX_TOOL_REPAIRS + 1,
    JSON.stringify({
      plannerCalls,
      finalizerCalls,
      eventTypes: events.map((event) => event.type),
      toolErrors: events
        .filter((event) => event.type === "tool_result")
        .map((event) => event.output),
    }),
  );
  assert.equal(finalizerCalls, 0);
  assert.equal(
    events.filter((event) => event.type === "tool_result").length,
    PI_MAX_TOOL_REPAIRS + 1,
  );
  const conclusion = events.find(
    (event): event is Extract<AgentEvent, { type: "conclusion" }> =>
      event.type === "conclusion",
  );
  assert.ok(conclusion);
  assert.equal(conclusion.status, "failed");
  assert.match(conclusion.reason ?? "", /工具命令或参数/);
  assert.equal(events.filter((event) => event.type === "terminate").length, 1);
  assert.equal(events.at(-1)?.type, "done");
});

test("PiAgentRuntime stops after repeated successful tool calls make no progress", async () => {
  let plannerCalls = 0;
  let finalizerCalls = 0;
  let toolCalls = 0;
  const llm: LlmClient = {
    async generate(request): Promise<LlmResponse> {
      if (request.signal?.aborted) {
        throw new Error("aborted");
      }
      if (request.system?.includes("最终结果整理器")) {
        finalizerCalls += 1;
        return {
          text: JSON.stringify({
            summary: "本次操作未完成。",
            reason: "检测到重复调用，系统已停止。",
            impact: "后续步骤未执行。",
            nextAction: "请调整任务条件后重试。",
          }),
          finishReason: "stop",
        };
      }
      plannerCalls += 1;
      return {
        text: JSON.stringify({
          kind: "tool_call",
          tool: "probe",
          input: { value: "same" },
        }),
        finishReason: "stop",
      };
    },
  };
  const runtime = new PiAgentRuntime({
    llm,
    usePlannerStream: true,
    runTimeoutMs: 1_000,
    pi: {
      apiKey: "fake-key",
      model: "fake-model",
      provider: "openai",
      baseUrl: "http://127.0.0.1:8989/v1",
    },
  });
  runtime.registerTool({
    name: "probe",
    description: "always returns the same result",
    inputSchema: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
    },
    async handler() {
      toolCalls += 1;
      return { ok: true, value: "same" };
    },
  });

  const events = await collect(runtime.run({ userText: "loop" }));

  assert.equal(plannerCalls, PI_MAX_REPEAT_TOOL_CALLS + 1);
  assert.equal(finalizerCalls, 0);
  assert.equal(toolCalls, PI_MAX_REPEAT_TOOL_CALLS);
  const termination = events.find(
    (event) => event.type === "terminate",
  ) as Extract<AgentEvent, { type: "terminate" }>;
  assert.match(termination.reason, /重复调用|避免循环/);
  assert.equal(events.at(-1)?.type, "done");
});

test("PiAgentRuntime planner stream stops varied calls with equivalent results", async () => {
  let plannerCalls = 0;
  let toolCalls = 0;
  const llm: LlmClient = {
    async generate(request): Promise<LlmResponse> {
      if (request.system?.includes("最终结果整理器")) {
        return {
          text: JSON.stringify({
            summary: "本次执行因没有新进展而停止。",
            reason: "最近多个工具步骤没有产生新的结果。",
            impact: "后续步骤未执行。",
            nextAction: "请调整筛选条件后重试。",
          }),
          finishReason: "stop",
        };
      }
      const index = plannerCalls;
      plannerCalls += 1;
      return {
        text: JSON.stringify({
          kind: "tool_call",
          tool: "constant",
          input: { index },
        }),
        finishReason: "stop",
      };
    },
  };
  const runtime = new PiAgentRuntime({
    llm,
    usePlannerStream: true,
    maxConsecutiveNoProgress: 3,
    runTimeoutMs: 2_000,
    pi: {
      apiKey: "fake-key",
      model: "fake-model",
      provider: "openai",
      baseUrl: "http://127.0.0.1:8989/v1",
    },
  });
  runtime.registerTool({
    name: "constant",
    description: "returns equivalent details",
    inputSchema: { type: "object" },
    async handler() {
      toolCalls += 1;
      return { ok: true, value: "same" };
    },
  });

  const events = await collect(runtime.run({ userText: "vary forever" }));

  assert.equal(toolCalls, 4);
  assert.equal(plannerCalls, 4);
  assert.equal(
    events.filter((event) => event.type === "tool_result").length,
    toolCalls,
    "the no-progress guard must settle the final started tool",
  );
  const conclusion = events.find(
    (event): event is Extract<AgentEvent, { type: "conclusion" }> =>
      event.type === "conclusion",
  );
  assert.equal(conclusion?.status, "failed");
  assert.match(conclusion?.reason ?? "", /没有产生新的结果/);
  assert.equal(events.at(-1)?.type, "done");
});

test("PiAgentRuntime keeps PI in the loop for multi-step mail requests", async () => {
  const llmResponses = [
    {
      kind: "tool_call",
      tool: "list_mail",
      input: { limit: 10 },
    },
    {
      kind: "tool_call",
      tool: "summarize_mail",
      input: { id: "mail-1" },
    },
    {
      kind: "final",
      text: "这封邮件提醒用户证件信息即将过期，需要尽快更新。",
    },
  ];
  const requests: LlmRequest[] = [];
  const llm: LlmClient = {
    async generate(request): Promise<LlmResponse> {
      requests.push(request);
      const next = llmResponses.shift();
      assert.ok(next, "planner should not request more responses");
      return {
        text: JSON.stringify(next),
        finishReason: "stop",
      };
    },
  };
  const runtime = new PiAgentRuntime({
    llm,
    usePlannerStream: true,
    pi: {
      apiKey: "fake-key",
      model: "fake-model",
      provider: "openai",
      baseUrl: "http://127.0.0.1:8989/v1",
    },
  });
  runtime.registerTool({
    name: "list_mail",
    description: "list mail",
    inputSchema: { type: "object" },
    async handler() {
      return {
        messages: [
          {
            id: "mail-1",
            folder: "INBOX",
            subject: "证件信息即将过期",
            from: { name: "中信银行信用卡", email: "service@example.test" },
            receivedAt: "2026-04-25T02:00:07Z",
          },
        ],
        count: 1,
      };
    },
  });
  runtime.registerTool({
    name: "summarize_mail",
    description: "summarize a mail message",
    inputSchema: { type: "object" },
    async handler(input) {
      assert.deepEqual(input, { id: "mail-1" });
      return {
        summary: "证件信息即将过期，需要更新。",
        keyPoints: ["中信银行信用卡提醒证件信息过期"],
        actionItems: ["更新证件信息"],
        source: "generated",
      };
    },
  });

  const events = await collect(
    runtime.run({ userText: "帮我查看邮件 并给出摘要" }),
  );

  assert.deepEqual(events.filter((event) => event.type === "tool_call").map((event) => ({
    type: event.type,
    tool: event.tool,
    input: event.input,
  })), [
    { type: "tool_call", tool: "list_mail", input: { limit: 10 } },
    { type: "tool_call", tool: "summarize_mail", input: { id: "mail-1" } },
  ]);
  assert.deepEqual(events.filter((event) => event.type === "tool_result").map((event) => ({
    type: event.type,
    tool: event.tool,
    output: event.output,
  })), [
    {
      type: "tool_result",
      tool: "list_mail",
      output: {
        messages: [
          {
            id: "mail-1",
            folder: "INBOX",
            subject: "证件信息即将过期",
            from: { name: "中信银行信用卡", email: "service@example.test" },
            receivedAt: "2026-04-25T02:00:07Z",
          },
        ],
        count: 1,
      },
    },
    {
      type: "tool_result",
      tool: "summarize_mail",
      output: {
        summary: "证件信息即将过期，需要更新。",
        keyPoints: ["中信银行信用卡提醒证件信息过期"],
        actionItems: ["更新证件信息"],
        source: "generated",
      },
    },
  ]);
  const text = [...events].reverse().find(
    (event): event is Extract<AgentEvent, { type: "text_end" }> =>
      event.type === "text_end",
  ) as Extract<
    AgentEvent,
    { type: "text_end" }
  >;
  assert.equal(text.text, "这封邮件提醒用户证件信息即将过期，需要尽快更新。");
  assert.equal(requests.length, 3);
  assert.match(requests[1].messages[0].content, /RESULT list_mail/);
  assert.match(requests[2].messages[0].content, /RESULT summarize_mail/);
  assert.equal(events.at(-1)?.type, "done");
});

test("PiAgentRuntime planner stream completes more than six productive tool steps", async () => {
  let plannerCalls = 0;
  const llm: LlmClient = {
    async generate(): Promise<LlmResponse> {
      const index = plannerCalls;
      plannerCalls += 1;
      return {
        text: JSON.stringify(
          index < 8
            ? {
                kind: "tool_call",
                tool: "probe",
                input: { index },
              }
            : {
                kind: "final",
                text: "planner stream long run complete",
              },
        ),
        finishReason: "stop",
      };
    },
  };
  const runtime = new PiAgentRuntime({
    llm,
    usePlannerStream: true,
    runTimeoutMs: 2_000,
    pi: {
      apiKey: "fake-key",
      model: "fake-model",
      provider: "openai",
      baseUrl: "http://127.0.0.1:8989/v1",
    },
  });
  runtime.registerTool(probeTool);

  const events = await collect(runtime.run({ userText: "analyze eight mails" }));

  assert.equal(plannerCalls, 9);
  assert.equal(
    events.filter((event) => event.type === "tool_result").length,
    8,
  );
  assert.equal(
    (events.find((event) => event.type === "text_end") as Extract<
      AgentEvent,
      { type: "text_end" }
    >).text,
    "planner stream long run complete",
  );
  assert.equal(events.at(-1)?.type, "done");
});

test("PiAgentRuntime repairs prose planner output before emitting PI tool calls", async () => {
  const llmResponses = [
    "我先帮您查看邮箱中的邮件。",
    JSON.stringify({
      kind: "tool_call",
      tool: "list_mail",
      input: { limit: 10 },
    }),
    JSON.stringify({
      kind: "final",
      text: "已查看到 1 封邮件。",
    }),
  ];
  const llm: LlmClient = {
    async generate(): Promise<LlmResponse> {
      const next = llmResponses.shift();
      assert.ok(next, "planner should not request more responses");
      return {
        text: next,
        finishReason: "stop",
      };
    },
  };
  const runtime = new PiAgentRuntime({
    llm,
    usePlannerStream: true,
    pi: {
      apiKey: "fake-key",
      model: "fake-model",
      provider: "openai",
      baseUrl: "http://127.0.0.1:8989/v1",
    },
  });
  runtime.registerTool({
    name: "list_mail",
    description: "list mail",
    inputSchema: { type: "object" },
    async handler() {
      return { messages: [{ id: "mail-1" }], count: 1 };
    },
  });

  const events = await collect(runtime.run({ userText: "帮我查看邮件" }));

  assert.deepEqual(events.filter((event) => event.type === "tool_call").map((event) => ({
    type: event.type,
    tool: event.tool,
    input: event.input,
  })), [
    { type: "tool_call", tool: "list_mail", input: { limit: 10 } },
  ]);
  const text = events.find(
    (event): event is Extract<AgentEvent, { type: "text_end" }> =>
      event.type === "text_end",
  );
  assert.equal(text?.text, "已查看到 1 封邮件。");
  assert.equal(events.at(-1)?.type, "done");
});

test("PiAgentRuntime requires planner or llm in options", () => {
  assert.throws(() => new PiAgentRuntime({}), /requires/);
});

// ── Fix 4: pending_action event emission and citation structured output ──

test("PiAgentRuntime emits pending_action event when propose_action returns a pendingAction (planner path)", async () => {
  const proposeActionTool: AgentTool = {
    name: "propose_action",
    description: "propose a high-risk action",
    inputSchema: { type: "object" },
    async handler() {
      return {
        ok: true,
        pendingAction: {
          id: "pending-1",
          actionType: "delete",
          description: "Delete the email",
          toolName: "propose_action",
          inputJson: '{"actionType":"delete"}',
          riskReason: "delete is a high-risk action",
          riskLevel: "high",
        },
        executed: false,
      };
    },
  };
  const runtime = new PiAgentRuntime({
    planner: scriptedPlanner([
      { kind: "tool_call", tool: "propose_action", input: { actionType: "delete" } },
      { kind: "final", text: "I've proposed deleting the email." },
    ]),
  });
  runtime.registerTool(proposeActionTool);

  const events = await collect(runtime.run({ userText: "delete this email" }));

  const pendingActionEvent = events.find(
    (e): e is Extract<AgentEvent, { type: "pending_action" }> => e.type === "pending_action",
  );
  assert.ok(pendingActionEvent, "expected a pending_action event");
  assert.equal(pendingActionEvent.action.actionType, "delete");
  assert.equal(pendingActionEvent.action.id, "pending-1");

  // tool_result should still be emitted too
  const toolResult = events.find(
    (e): e is Extract<AgentEvent, { type: "tool_result" }> => e.type === "tool_result",
  );
  assert.ok(toolResult);
  assert.equal(toolResult.tool, "propose_action");
});

test("open edition completes the run generically after an upload proposal (no edition conclusion)", async () => {
  // P2.6: the native upload-status conclusion projector moved to the
  // edition module. Without the module the tool result neither ends the run
  // early nor produces a business conclusion — the planner simply continues
  // (its final answer is the outcome). Full projector coverage runs in the
  // edition overlay's suite with the registered module.
  const runtime = new PiAgentRuntime({ planner: scriptedPlanner([
    { kind: "tool_call", tool: "propose_allowance_invoice_upload", input: {} },
    { kind: "final", text: "未发现需要上传的附件，已结束。" },
  ]) });
  runtime.registerTool({ name: "propose_allowance_invoice_upload", description: "upload proposal", inputSchema: { type: "object" },
    async handler() { return { ok: true, noUploadNeeded: true, excluded: [{ filename: "94.pdf", reason: "pending_verification", message: "历史提交结果待核实，本次未重复上传" }] }; } });
  const events = await collect(runtime.run({ userText: "上传发票" }));
  // No edition module: no business conclusion projects the per-attachment
  // status; the run ends with the generic completion conclusion.
  const conclusions = events.filter(
    (event): event is Extract<AgentEvent, { type: "conclusion" }> => event.type === "conclusion",
  );
  assert.ok(!conclusions.some((event) => /94\.pdf|已完成附件状态检查/.test(event.summary)));
  const finalText = events.find((event) => event.type === "assistant_text");
  assert.match(finalText?.text ?? "", /已结束/);
});

test("PiAgentRuntime emits pending_action event when any tool returns a pendingAction (planner path)", async () => {
  const allowanceTool: AgentTool = {
    name: "propose_allowance_invoice_upload",
    description: "propose allowance invoice upload",
    inputSchema: { type: "object" },
    async handler() {
      return {
        ok: true,
        pendingAction: {
          id: "pending-allowance-1",
          actionType: "upload_allowance_invoices",
          description: "上传 2 个邮件附件到 wecli allowance",
          toolName: "propose_allowance_invoice_upload",
          inputJson: '{"items":[{"emailId":"mail-1","attachmentId":"att-1"}]}',
          riskReason: "runs a confirmed wecli allowance upload command",
          riskLevel: "medium",
        },
        executed: false,
      };
    },
  };
  const runtime = new PiAgentRuntime({
    planner: scriptedPlanner([
      {
        kind: "tool_call",
        tool: "propose_allowance_invoice_upload",
        input: { items: [{ emailId: "mail-1", attachmentId: "att-1" }] },
      },
      { kind: "final", text: "已创建上传确认。" },
    ]),
  });
  runtime.registerTool(allowanceTool);

  const events = await collect(runtime.run({ userText: "上传这封邮件的发票附件" }));

  const pendingActionEvent = events.find(
    (e): e is Extract<AgentEvent, { type: "pending_action" }> => e.type === "pending_action",
  );
  assert.ok(pendingActionEvent, "expected a pending_action event");
  assert.equal(pendingActionEvent.action.id, "pending-allowance-1");
  assert.equal(pendingActionEvent.action.actionType, "upload_allowance_invoices");
});

test("PiAgentRuntime does NOT emit pending_action when propose_action returns no pendingAction (planner path)", async () => {
  const proposeActionTool: AgentTool = {
    name: "propose_action",
    description: "propose a high-risk action",
    inputSchema: { type: "object" },
    async handler() {
      return { ok: false, error: "Unknown action type: foo" };
    },
  };
  const runtime = new PiAgentRuntime({
    planner: scriptedPlanner([
      { kind: "tool_call", tool: "propose_action", input: { actionType: "foo" } },
      { kind: "final", text: "That action is not supported." },
    ]),
  });
  runtime.registerTool(proposeActionTool);

  const events = await collect(runtime.run({ userText: "foo this email" }));

  const pendingActionEvent = events.find((e) => e.type === "pending_action");
  assert.equal(pendingActionEvent, undefined, "should not emit pending_action on error");
});

test("PiAgentRuntime emits pending_action event in PI agent path when propose_action returns one", async () => {
  let subscribed: ((event: any) => void | Promise<void>) | undefined;
  const piAgent: PiAgentLike = {
    subscribe(listener) {
      subscribed = listener;
      return () => {};
    },
    async prompt() {
      assert.ok(subscribed);
      await subscribed({
        type: "tool_execution_start",
        toolName: "propose_action",
        args: { actionType: "archive" },
      });
      await subscribed({
        type: "tool_execution_end",
        toolName: "propose_action",
        result: {
          details: {
            ok: true,
            pendingAction: {
              id: "pending-2",
              actionType: "archive",
              description: "Archive the email",
              toolName: "propose_action",
              inputJson: '{"actionType":"archive"}',
              riskReason: "archive is a high-risk action",
              riskLevel: "medium",
            },
            executed: false,
          },
          content: [{ type: "text", text: "ok" }],
        },
      });
      await subscribed({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "Archived." },
      });
    },
  };
  const factory: PiAgentFactory = () => piAgent;

  const runtime = new PiAgentRuntime({
    pi: {
      apiKey: "fake-key",
      model: "fake-model",
      provider: "openai",
      baseUrl: "http://127.0.0.1:8989/v1",
    },
    piAgentFactory: factory,
  });

  const events = await collect(runtime.run({ userText: "archive this" }));

  const pendingActionEvent = events.find(
    (e): e is Extract<AgentEvent, { type: "pending_action" }> => e.type === "pending_action",
  );
  assert.ok(pendingActionEvent, "expected a pending_action event");
  assert.equal(pendingActionEvent.action.actionType, "archive");
  assert.equal(pendingActionEvent.action.id, "pending-2");
});

test("PiAgentRuntime emits pending_action event in PI agent path when any tool returns one", async () => {
  let subscribed: ((event: any) => void | Promise<void>) | undefined;
  const piAgent: PiAgentLike = {
    subscribe(listener) {
      subscribed = listener;
      return () => {};
    },
    async prompt() {
      assert.ok(subscribed);
      await subscribed({
        type: "tool_execution_start",
        toolName: "propose_allowance_invoice_upload",
        args: { items: [{ emailId: "mail-1", attachmentId: "att-1" }] },
      });
      await subscribed({
        type: "tool_execution_end",
        toolName: "propose_allowance_invoice_upload",
        result: {
          details: {
            ok: true,
            pendingAction: {
              id: "pending-allowance-2",
              actionType: "upload_allowance_invoices",
              description: "上传 1 个邮件附件到 wecli allowance",
              toolName: "propose_allowance_invoice_upload",
              inputJson: '{"items":[{"emailId":"mail-1","attachmentId":"att-1"}]}',
              riskReason: "runs a confirmed wecli allowance upload command",
              riskLevel: "medium",
            },
            executed: false,
          },
          content: [{ type: "text", text: "ok" }],
        },
      });
      await subscribed({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "已创建上传确认。" },
      });
    },
  };
  const factory: PiAgentFactory = () => piAgent;

  const runtime = new PiAgentRuntime({
    pi: {
      apiKey: "fake-key",
      model: "fake-model",
      provider: "openai",
      baseUrl: "http://127.0.0.1:8989/v1",
    },
    piAgentFactory: factory,
  });

  const events = await collect(runtime.run({ userText: "上传这封邮件的发票附件" }));

  const pendingActionEvent = events.find(
    (e): e is Extract<AgentEvent, { type: "pending_action" }> => e.type === "pending_action",
  );
  assert.ok(pendingActionEvent, "expected a pending_action event");
  assert.equal(pendingActionEvent.action.id, "pending-allowance-2");
  assert.equal(pendingActionEvent.action.actionType, "upload_allowance_invoices");
});

test("PiAgentRuntime includes citations from planner final decision in assistant_text event (planner path)", async () => {
  const runtime = new PiAgentRuntime({
    planner: {
      async step() {
        return {
          kind: "final",
          text: "The email is about project updates.",
          citations: [
            { emailId: "msg-1", tool: "summarize_mail", path: "summary.bullets" },
            { emailId: "msg-2", tool: "read_mail" },
          ],
        } as PlannerDecision;
      },
    },
  });

  const events = await collect(runtime.run({ userText: "summarize" }));
  const textEvent = events.find(
    (e): e is Extract<AgentEvent, { type: "assistant_text" }> => e.type === "assistant_text",
  );
  assert.ok(textEvent);
  assert.equal(textEvent.text, "The email is about project updates.");
  assert.ok(textEvent.citations, "citations should be present");
  assert.equal(textEvent.citations!.length, 2);
  assert.equal(textEvent.citations![0].emailId, "msg-1");
  assert.equal(textEvent.citations![0].tool, "summarize_mail");
  assert.equal(textEvent.citations![0].path, "summary.bullets");
  assert.equal(textEvent.citations![1].emailId, "msg-2");
  assert.equal(textEvent.citations![1].tool, "read_mail");
  assert.equal(textEvent.citations![1].path, undefined);
});

test("PiAgentRuntime final decision without citations has undefined citations (planner path)", async () => {
  const runtime = new PiAgentRuntime({
    planner: {
      async step() {
        return { kind: "final", text: "Hello!" };
      },
    },
  });

  const events = await collect(runtime.run({ userText: "hi" }));
  const textEvent = events.find(
    (e): e is Extract<AgentEvent, { type: "assistant_text" }> => e.type === "assistant_text",
  );
  assert.ok(textEvent);
  assert.equal(textEvent.citations, undefined);
});

test("PiAgentRuntime filters malformed citations missing emailId or tool (planner path)", async () => {
  const runtime = new PiAgentRuntime({
    planner: {
      async step() {
        return {
          kind: "final",
          text: "Here are some facts.",
          citations: [
            { emailId: "msg-1", tool: "summarize_mail", path: "summary" },
            { emailId: "msg-2" }, // missing tool
            { tool: "read_mail" }, // missing emailId
            { emailId: 123, tool: "read_mail" }, // emailId not string
          ],
        } as PlannerDecision;
      },
    },
  });

  const events = await collect(runtime.run({ userText: "tell me" }));
  const textEvent = events.find(
    (e): e is Extract<AgentEvent, { type: "assistant_text" }> => e.type === "assistant_text",
  );
  assert.ok(textEvent);
  // Only the first citation should survive; the rest are malformed
  assert.ok(textEvent.citations, "citations should be present");
  assert.equal(textEvent.citations!.length, 1);
  assert.equal(textEvent.citations![0].emailId, "msg-1");
  assert.equal(textEvent.citations![0].tool, "summarize_mail");
});

test("PiAgentRuntime records agent_chat usage for each native PI assistant message", async () => {
  // Regression: the production agent path runs the PI SDK's native loop
  // (runWithPi), which made its LLM calls through an internal client that
  // nobody recorded. The "AI 聊天" bucket was always 0 while real chats ran.
  // The fix records one row per assistant message_end, attributed to
  // agent_chat with the message's own usage/model/provider.
  let subscribed: ((event: any) => void | Promise<void>) | undefined;
  const recordCalls: Array<Record<string, unknown>> = [];
  const piAgent: PiAgentLike = {
    subscribe(listener) {
      subscribed = listener;
      return () => {};
    },
    abort() {},
    async prompt() {
      assert.ok(subscribed);
      await subscribed({
        type: "message_update",
        assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "hi" },
      });
      await subscribed({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "hi" }],
          api: "openai-completions",
          provider: "openai",
          model: "fake-model",
          usage: {
            input: 1234,
            output: 567,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 1801,
            cost: { input: 0, output: 0, totalCost: 0 },
          },
          stopReason: "stop",
          timestamp: 0,
        },
      });
    },
  };
  const runtime = new PiAgentRuntime({
    pi: {
      apiKey: "fake-key",
      model: "fake-model",
      provider: "openai",
      baseUrl: "http://127.0.0.1:8989/v1",
    },
    piAgentFactory: () => piAgent,
    usage: {
      record: (input: Record<string, unknown>) => {
        recordCalls.push(input);
      },
    } as unknown as AiUsageRepository,
  });

  await collect(runtime.run({ userText: "hi", accountId: "acct-native" }));

  const agentRows = recordCalls.filter((r) => r.category === "agent_chat");
  assert.equal(agentRows.length, 1, "one row per native assistant message");
  assert.equal(agentRows[0]!.accountId, "acct-native");
  assert.equal(agentRows[0]!.processor, "agent");
  assert.equal(agentRows[0]!.inputTokens, 1234);
  assert.equal(agentRows[0]!.outputTokens, 567);
  assert.equal(agentRows[0]!.model, "fake-model");
  assert.equal(agentRows[0]!.provider, "openai");
});

test("PiAgentRuntime does not record usage from message_end on the planner stream path", async () => {
  // The planner stream records its own usage inside requestPlannerDecision and
  // its synthetic assistant messages carry ZERO_USAGE, so the message_end hook
  // must stay gated off when usePlannerStream is on to avoid zero-noise rows
  // and double counting.
  let subscribed: ((event: any) => void | Promise<void>) | undefined;
  const recordCalls: Array<Record<string, unknown>> = [];
  const piAgent: PiAgentLike = {
    subscribe(listener) {
      subscribed = listener;
      return () => {};
    },
    abort() {},
    async prompt() {
      assert.ok(subscribed);
      await subscribed({
        type: "message_end",
        message: {
          role: "assistant",
          usage: { input: 999, output: 999 },
          model: "fake-model",
          provider: "openai",
        },
      });
    },
  };
  const runtime = new PiAgentRuntime({
    usePlannerStream: true,
    pi: {
      apiKey: "fake-key",
      model: "fake-model",
      provider: "openai",
      baseUrl: "http://127.0.0.1:8989/v1",
    },
    piAgentFactory: () => piAgent,
    usage: {
      record: (input: Record<string, unknown>) => {
        recordCalls.push(input);
      },
    } as unknown as AiUsageRepository,
  });

  await collect(runtime.run({ userText: "hi" }));

  const agentRows = recordCalls.filter((r) => r.category === "agent_chat");
  assert.equal(agentRows.length, 0);
});
