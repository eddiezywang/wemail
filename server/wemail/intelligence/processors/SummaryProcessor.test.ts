import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  IntelligenceJob,
  SummaryResult,
  SummaryThreadResult,
} from "../../../../shared/wemail/intelligence.js";
import type { MailMessage } from "../../../../shared/wemail/mail.js";
import { LlmClientError, type LlmClient, type LlmResponse } from "../../ai/LlmClient.js";
import { openOrCreateMailDatabase } from "../../database/Database.js";
import { AiUsageRepository } from "../../settings/AiUsageRepository.js";
import type { ProcessorContext } from "../MailIntelligenceProcessor.js";
import {
  SummaryProcessor,
  SummaryProcessorError,
  SUMMARY_BULLETS_MAX_CHARS,
  SUMMARY_PROCESSOR_VERSION,
} from "./SummaryProcessor.js";

function makeMessage(overrides: Partial<MailMessage> = {}): MailMessage {
  return {
    id: "acct-1:INBOX:1:100",
    accountId: "acct-1",
    folder: "INBOX",
    messageId: "<m-100@x.com>",
    from: { email: "boss@x.com", name: "Boss" },
    to: [{ email: "me@x.com" }],
    cc: [],
    bcc: [],
    subject: "Q3 plans",
    snippet: "we need",
    bodyText: "Please prepare the Q3 deck by Friday.",
    receivedAt: "2026-04-24T10:00:00.000Z",
    hasAttachments: false,
    attachments: [],
    flags: { seen: false, flagged: false, answered: false, draft: false },
    sync: { uid: 100, uidValidity: 1, internalDate: "2026-04-24T10:00:00Z" },
    ...overrides,
  };
}

function makeJob(): IntelligenceJob {
  return {
    id: "job-1",
    emailId: "acct-1:INBOX:1:100",
    type: "summary",
    status: "running",
    attempts: 0,
    maxAttempts: 2,
    createdAt: "2026-04-24T10:00:00Z",
    updatedAt: "2026-04-24T10:00:00Z",
  };
}

function makeCtx(
  msg: MailMessage | null,
  workspace?: ProcessorContext["workspace"],
): ProcessorContext {
  return workspace
    ? { getMessage: () => msg, workspace }
    : { getMessage: () => msg };
}

function fakeClient(impl: (req: unknown) => Promise<LlmResponse>): LlmClient {
  return { generate: impl as LlmClient["generate"] };
}

// ── Email-mode tests (legacy) ──────────────────────────────────────

test("SummaryProcessor completes image-only bodies without calling the model", async () => {
  let calls = 0;
  const processor = new SummaryProcessor({
    model: "gpt-4o-mini",
    llmClient: fakeClient(async () => {
      calls += 1;
      throw new Error("model should not be called");
    }),
  });

  const result = await processor.handle(
    makeJob(),
    makeCtx(makeMessage({ bodyText: "", bodyHtml: '<p><img src="cid:banner"></p>' })),
  );

  assert.deepEqual(result, {
    type: "summary",
    bullets: [],
    actionItems: [],
    urgency: "low",
    _status: "completed",
    reason: "image-only-body",
  });
  assert.equal(calls, 0);
});

test("SummaryProcessor returns a valid SummaryResult on happy path", async () => {
  const logs: Array<{ event: string; fields: Record<string, string | number> }> = [];
  let receivedReq: Record<string, unknown> | null = null;
  const processor = new SummaryProcessor({
    model: "gpt-4o-mini",
    llmClient: fakeClient(async (req) => {
      receivedReq = req as Record<string, unknown>;
      return {
        text: JSON.stringify({
          bullets: ["one", "two", "three"],
          actionItems: ["prepare deck"],
          urgency: "medium",
        }),
        finishReason: "stop",
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    }),
    logger: (event, fields) => logs.push({ event, fields }),
  });

  const result = (await processor.handle(
    makeJob(),
    makeCtx(makeMessage()),
  )) as SummaryResult;

  assert.equal(result.type, "summary");
  assert.equal(result.urgency, "medium");
  assert.equal(result.bullets.length, 3);
  assert.ok(receivedReq !== null);
  // System prompt must be the locked summary prompt and schema must be passed.
  assert.ok(typeof (receivedReq as { system: string }).system === "string");
  assert.ok((receivedReq as { jsonSchema: unknown }).jsonSchema);
  // Timeout must be threaded through to the LLM client (< QueueRunner 60s lease).
  assert.equal(typeof (receivedReq as { timeoutMs: number }).timeoutMs, "number");
  assert.ok((receivedReq as { timeoutMs: number }).timeoutMs <= 50_000);

  // Body-free logging: success event must not contain the mail body.
  const ok = logs.find((l) => l.event === "summary-ok");
  assert.ok(ok);
  const serialized = JSON.stringify(logs);
  assert.ok(!serialized.includes("Q3 deck"));
  assert.ok(!serialized.includes("Please prepare"));
});

test("SummaryProcessor selects compact CTA indexes in the summary call and restores URLs locally", async () => {
  let request: Record<string, unknown> | undefined;
  const processor = new SummaryProcessor({
    model: "gpt-4o-mini",
    llmClient: fakeClient(async (input) => {
      request = input as Record<string, unknown>;
      return {
        text: JSON.stringify({
          type: "summary",
          schemaVersion: 3,
          intent: "marketing",
          attention: "know",
          displayMode: "one_line",
          headline: "Agoda 提供日本酒店限时优惠。",
          details: [],
          actions: [],
          actionObligation: "none",
          bullets: ["Agoda 提供日本酒店限时优惠。"],
          actionItems: [],
          urgency: "low",
          dataInsight: null,
          ctas: [{ i: 0, l: "查看限时优惠", c: "h" }],
        }),
        finishReason: "stop",
      };
    }),
  });
  const trackedUrl = "https://tracking.agoda.test/click?linkType=saleButton&member=secret";

  const result = await processor.handle(
    makeJob(),
    makeCtx(makeMessage({
      bodyText: "日本酒店限时降价，最高可享八折。",
      bodyHtml: [
        '<a href="https://tracking.agoda.test/click?linkType=saleTitle">日本酒店限时降价</a>',
        `<a href="${trackedUrl.replace(/&/g, "&amp;")}">ACTIVATE NOW</a>`,
      ].join(""),
    })),
  );

  assert.ok("ctas" in result);
  assert.equal(result.ctas?.length, 1);
  assert.equal(result.ctas?.[0]?.url, trackedUrl);
  assert.equal(result.ctas?.[0]?.label, "查看限时优惠");
  const messages = request?.messages as Array<{ content: string }>;
  assert.match(messages[0]?.content ?? "", /"i":0/);
  assert.doesNotMatch(messages[0]?.content ?? "", /member=secret/);
});

test("SummaryProcessor keeps grounded monitoring insights and blocks snapshot trends", async () => {
  const processor = new SummaryProcessor({
    model: "monitor-model",
    llmClient: fakeClient(async () => ({
      text: JSON.stringify({
        type: "summary",
        schemaVersion: 3,
        intent: "system_notice",
        attention: "know",
        displayMode: "brief",
        headline: "当前调用量 7692，失败量 2。",
        details: [],
        actions: [],
        bullets: ["当前调用量 7692，失败量 2。"],
        actionItems: [],
        urgency: "low",
        dataInsight: {
          kind: "monitoring_report",
          metrics: [
            { label: "调用量", value: "7692", context: "" },
            { label: "失败量", value: "2", context: "" },
            { label: "不存在", value: "9999", context: "" },
          ],
          findings: [
            { kind: "fact", text: "当前失败量为 2。" },
            { kind: "trend", text: "失败量正在上升。" },
          ],
          evidenceLevel: "snapshot",
          chartRecommended: true,
          chartReason: "存在多个可比较指标",
        },
      }),
      finishReason: "stop",
    })),
  });

  const result = await processor.handle(
    makeJob(),
    makeCtx(makeMessage({
      subject: "小时监控报表",
      bodyText: "实时接口访问数量监控报表，最近一小时数据如下：\n指标 值\n调用量 7692\n失败量 2\n平均耗时 35ms",
      bodyVersion: 4,
    })),
  ) as SummaryResult;

  assert.equal(result.schemaVersion, 3);
  assert.deepEqual(result.dataInsight?.metrics.map((metric) => metric.value), [
    "7692",
    "2",
  ]);
  assert.deepEqual(result.dataInsight?.findings.map((finding) => finding.kind), [
    "fact",
  ]);
  assert.equal(result.dataInsight?.chartRecommended, true);
  assert.equal(result._metadata?.bodyVersion, 4);
  assert.equal(result._metadata?.contentFingerprint?.length, 64);
});

test("SummaryProcessor recovers dataInsight via a focused retry when a monitoring candidate is mislabeled", async () => {
  const logs: Array<{ event: string; fields: Record<string, string | number> }> = [];
  let calls = 0;
  const processor = new SummaryProcessor({
    model: "glm-5",
    llmClient: fakeClient(async () => {
      calls += 1;
      if (calls === 1) {
        return {
          text: JSON.stringify({
            type: "summary",
            schemaVersion: 3,
            intent: "system_notice",
            attention: "know",
            displayMode: "one_line",
            headline: "DataAPI 调用量约 3.3 万次，qwen3.6-35b 平均耗时 17570ms。",
            details: [],
            actions: [],
            bullets: ["DataAPI 调用量约 3.3 万次，qwen3.6-35b 平均耗时 17570ms。"],
            actionItems: [],
            urgency: "low",
            dataInsight: null,
          }),
          finishReason: "stop",
          usage: { inputTokens: 10, outputTokens: 5 },
        };
      }
      return {
        text: JSON.stringify({
          type: "summary",
          schemaVersion: 3,
          intent: "system_notice",
          attention: "know",
          displayMode: "brief",
          headline: "调用量 7692，失败量 2。",
          details: [],
          actions: [],
          bullets: ["调用量 7692，失败量 2。"],
          actionItems: [],
          urgency: "low",
          dataInsight: {
            kind: "monitoring_report",
            metrics: [
              { label: "调用量", value: "7692", context: "" },
              { label: "失败量", value: "2", context: "" },
            ],
            findings: [{ kind: "fact", text: "失败量为 2。" }],
            evidenceLevel: "snapshot",
            chartRecommended: true,
            chartReason: "存在多行可比较指标",
          },
        }),
        finishReason: "stop",
        usage: { inputTokens: 20, outputTokens: 8 },
      };
    }),
    logger: (event, fields) => logs.push({ event, fields }),
  });

  const result = (await processor.handle(
    makeJob(),
    makeCtx(makeMessage({
      subject: "小时监控报表",
      bodyText: "实时接口访问数量监控报表，最近一小时数据如下：\n指标 值\n调用量 7692\n失败量 2\n平均耗时 35ms",
      bodyVersion: 1,
    })),
  )) as SummaryResult;

  assert.equal(calls, 2, "should call the LLM twice when recovering a monitoring insight");
  assert.ok(result.dataInsight, "recovered summary should include dataInsight");
  assert.equal(result.dataInsight!.chartRecommended, true);
  assert.deepEqual(result.dataInsight!.metrics.map((m) => m.value), ["7692", "2"]);
  assert.equal(result._metadata?.tokenUsage?.inputTokens, 30);
  assert.equal(result._metadata?.tokenUsage?.outputTokens, 13);
  assert.ok(logs.find((l) => l.event === "summary-monitoring-retry-attempt"));
  assert.ok(logs.find((l) => l.event === "summary-monitoring-retry-ok"));
});

test("SummaryProcessor does not retry for ordinary mail without a monitoring-data body", async () => {
  let calls = 0;
  const processor = new SummaryProcessor({
    model: "x",
    llmClient: fakeClient(async () => {
      calls += 1;
      return {
        text: JSON.stringify({
          type: "summary",
          schemaVersion: 3,
          intent: "request",
          attention: "act",
          displayMode: "actionable",
          headline: "请在周五前确认预算。",
          details: [],
          actions: [],
          bullets: ["请在周五前确认预算。"],
          actionItems: [],
          urgency: "medium",
          dataInsight: null,
        }),
        finishReason: "stop",
      };
    }),
  });

  const result = (await processor.handle(
    makeJob(),
    makeCtx(makeMessage({ bodyText: "请在本周五前确认下季度预算，并回复邮件。" })),
  )) as SummaryResult;

  assert.equal(calls, 1);
  assert.ok(!result.dataInsight);
});

test("SummaryProcessor keeps the original summary when the monitoring retry still omits dataInsight", async () => {
  let calls = 0;
  const processor = new SummaryProcessor({
    model: "x",
    llmClient: fakeClient(async () => {
      calls += 1;
      const headline = calls === 1 ? "原始：调用量 7692。" : "重试仍未识别为数据邮件。";
      return {
        text: JSON.stringify({
          type: "summary",
          schemaVersion: 3,
          intent: "system_notice",
          attention: "know",
          displayMode: "one_line",
          headline,
          details: [],
          actions: [],
          bullets: [headline],
          actionItems: [],
          urgency: "low",
          dataInsight: null,
        }),
        finishReason: "stop",
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    }),
  });

  const result = (await processor.handle(
    makeJob(),
    makeCtx(makeMessage({
      subject: "小时监控报表",
      bodyText: "实时接口访问数量监控报表，最近一小时数据如下：\n指标 值\n调用量 7692\n失败量 2\n平均耗时 35ms",
    })),
  )) as SummaryResult;

  assert.equal(calls, 2);
  assert.ok(!result.dataInsight);
  assert.deepEqual(result.bullets, ["原始：调用量 7692。"], "should keep the original summary");
});

test("SummaryProcessor falls back to the original summary when the monitoring retry returns invalid JSON", async () => {
  let calls = 0;
  const processor = new SummaryProcessor({
    model: "x",
    llmClient: fakeClient(async () => {
      calls += 1;
      if (calls === 1) {
        return {
          text: JSON.stringify({
            type: "summary",
            schemaVersion: 3,
            intent: "system_notice",
            attention: "know",
            displayMode: "one_line",
            headline: "调用量 7692。",
            details: [],
            actions: [],
            bullets: ["调用量 7692。"],
            actionItems: [],
            urgency: "low",
            dataInsight: null,
          }),
          finishReason: "stop",
        };
      }
      return { text: "not json", finishReason: "stop" };
    }),
  });

  const result = (await processor.handle(
    makeJob(),
    makeCtx(makeMessage({
      subject: "小时监控报表",
      bodyText: "实时接口访问数量监控报表，最近一小时数据如下：\n指标 值\n调用量 7692\n失败量 2\n平均耗时 35ms",
    })),
  )) as SummaryResult;

  assert.equal(calls, 2);
  assert.ok(!result.dataInsight);
  assert.deepEqual(result.bullets, ["调用量 7692。"]);
});

test("SummaryProcessor rejects an empty-body claim when body content is available", async () => {
  const processor = new SummaryProcessor({
    model: "x",
    llmClient: fakeClient(async () => ({
      text: JSON.stringify({
        type: "summary",
        schemaVersion: 3,
        intent: "system_notice",
        attention: "know",
        displayMode: "one_line",
        headline: "该邮件正文为空，仅展示主题。",
        details: [],
        actions: [],
        bullets: ["该邮件正文为空，仅展示主题。"],
        actionItems: [],
        urgency: "low",
        dataInsight: null,
      }),
      finishReason: "stop",
    })),
  });

  await assert.rejects(
    () => processor.handle(
      makeJob(),
      makeCtx(makeMessage({
        bodyText: "这里存在足够长且明确的邮件正文内容，用于证明模型不应声称正文为空。正文还包含调用量、失败量和处理状态等真实信息。",
      })),
    ),
    (error: unknown) => {
      assert.ok(error instanceof SummaryProcessorError);
      assert.equal(error.code, "false-empty-body");
      assert.equal(error.retryable, true);
      return true;
    },
  );
});

test("SummaryProcessor records usage tokens when usage repository is provided", async () => {
  const db = openOrCreateMailDatabase(":memory:");
  const usage = new AiUsageRepository(db, () => "2026-04-24T12:00:00.000Z");
  const processor = new SummaryProcessor({
    model: "gpt-4o-mini",
    usage,
    llmClient: fakeClient(async () => ({
      text: JSON.stringify({
        bullets: ["one", "two", "three"],
        actionItems: [],
        urgency: "low",
      }),
      finishReason: "stop",
      usage: { inputTokens: 11, outputTokens: 4 },
    })),
  });

  await processor.handle(makeJob(), makeCtx(makeMessage()));

  const summary = usage.summarize({ accountId: "acct-1", period: "30d" });
  assert.deepEqual(summary.find((row) => row.category === "summary"), {
    category: "summary",
    label: "摘要",
    tokens: 15,
    calls: 1,
  });
});

test("SummaryProcessor propagates LlmClientError (for queue retry)", async () => {
  const processor = new SummaryProcessor({
    model: "x",
    llmClient: fakeClient(async () => {
      throw new LlmClientError({ status: 503, code: "overloaded", message: "busy" });
    }),
  });

  await assert.rejects(
    () => processor.handle(makeJob(), makeCtx(makeMessage())),
    (err: unknown) => {
      assert.ok(err instanceof LlmClientError);
      assert.equal((err as LlmClientError).code, "overloaded");
      assert.equal((err as LlmClientError).retryable, true);
      return true;
    },
  );
});

test("SummaryProcessor marks invalid JSON as non-retryable terminal", async () => {
  const processor = new SummaryProcessor({
    model: "x",
    llmClient: fakeClient(async () => ({
      text: "not json",
      finishReason: "stop",
    })),
  });

  await assert.rejects(
    () => processor.handle(makeJob(), makeCtx(makeMessage())),
    (err: unknown) => {
      assert.ok(err instanceof SummaryProcessorError);
      assert.equal((err as SummaryProcessorError).retryable, false);
      assert.match((err as Error).message, /response-not-json/);
      return true;
    },
  );
});

test("SummaryProcessor accepts fenced JSON when provider ignores structured response_format", async () => {
  const logs: Array<{ event: string; fields: Record<string, string | number> }> = [];
  const processor = new SummaryProcessor({
    model: "x",
    llmClient: fakeClient(async () => ({
      text:
        "```json\n" +
        JSON.stringify({
          bullets: ["a", "b", "c"],
          actionItems: [],
          urgency: "low",
        }) +
        "\n```",
      finishReason: "stop",
    })),
    logger: (event, fields) => logs.push({ event, fields }),
  });

  const result = (await processor.handle(
    makeJob(),
    makeCtx(makeMessage()),
  )) as SummaryResult;

  assert.equal(result.type, "summary");
  assert.deepEqual(result.bullets, ["a", "b", "c"]);
  assert.equal(result.urgency, "low");
  assert.ok(logs.find((entry) => entry.event === "summary-fenced"));
});

test("SummaryProcessor recovers complete fields from truncated JSON", async () => {
  const logs: Array<{ event: string; fields: Record<string, string | number> }> = [];
  const processor = new SummaryProcessor({
    model: "x",
    llmClient: fakeClient(async () => ({
      text: '{"type":"summary","schemaVersion":3,"intent":"request","attention":"act","displayMode":"actionable","headline":"周五前确认合同条款。","details":["复核第 3 条。"],"actionObligation":"none","urgency":"medium","actions":["未完成',
      finishReason: "length",
      usage: { inputTokens: 10, outputTokens: 100 },
    })),
    logger: (event, fields) => logs.push({ event, fields }),
  });

  const result = await processor.handle(makeJob(), makeCtx(makeMessage())) as SummaryResult;

  assert.equal(result.headline, "周五前确认合同条款。");
  assert.deepEqual(result.details, ["复核第 3 条。"]);
  assert.deepEqual(result.actions, []);
  assert.deepEqual(result.bullets, ["周五前确认合同条款。", "复核第 3 条。"]);
  assert.equal(result._metadata?.truncated, true);
  assert.ok(logs.some((entry) => entry.event === "summary-truncated-recovery"));
});

test("SummaryProcessor accepts one to four bullets and rejects too many", async () => {
  const oneBullet = new SummaryProcessor({
    model: "x",
    llmClient: fakeClient(async () => ({
      text: JSON.stringify({
        bullets: ["only one"],
        actionItems: [],
        urgency: "low",
      }),
      finishReason: "stop",
    })),
  });
  const oneResult = await oneBullet.handle(makeJob(), makeCtx(makeMessage())) as SummaryResult;
  assert.deepEqual(oneResult.bullets, ["only one"]);

  const fourBullets = new SummaryProcessor({
    model: "x",
    llmClient: fakeClient(async () => ({
      text: JSON.stringify({
        bullets: ["a", "b", "c", "d"],
        actionItems: [],
        urgency: "low",
      }),
      finishReason: "stop",
    })),
  });
  const fourResult = await fourBullets.handle(makeJob(), makeCtx(makeMessage())) as SummaryResult;
  assert.equal(fourResult.bullets.length, 4);

  const fiveBullets = new SummaryProcessor({
    model: "x",
    llmClient: fakeClient(async () => ({
      text: JSON.stringify({
        bullets: ["a", "b", "c", "d", "e"],
        actionItems: [],
        urgency: "low",
      }),
      finishReason: "stop",
    })),
  });
  await assert.rejects(() => fiveBullets.handle(makeJob(), makeCtx(makeMessage())));
});

test("SummaryProcessor compacts overlong summary bullets instead of failing", async () => {
  const processor = new SummaryProcessor({
    model: "x",
    llmClient: fakeClient(async () => ({
      text: JSON.stringify({
        bullets: ["x".repeat(SUMMARY_BULLETS_MAX_CHARS + 1)],
        actionItems: [],
        urgency: "medium",
      }),
      finishReason: "stop",
    })),
  });

  const result = await processor.handle(makeJob(), makeCtx(makeMessage())) as SummaryResult;

  assert.equal(result.type, "summary");
  assert.equal(result.urgency, "medium");
  assert.ok(result.bullets.length > 0);
  assert.ok(result.bullets.join("").length <= SUMMARY_BULLETS_MAX_CHARS);
});

test("SummaryProcessor thread mode compacts overlong summary bullets instead of failing", async () => {
  const processor = new SummaryProcessor({
    model: "x",
    mode: "thread",
    threadMessages: [
      {
        emailId: "msg-1",
        subject: "Test",
        from: "a@x.com",
        bodyText: "Content",
        receivedAt: "2026-04-24T10:00:00Z",
      },
    ],
    llmClient: fakeClient(async () => ({
      text: JSON.stringify({
        bullets: [
          "这是一个线程摘要要点，内容过长，覆盖多个往返信件和结论，需要被压缩到前端摘要卡片可以直接展示的长度。",
          "第二个线程摘要要点也故意写得很长，用于证明线程模式不会因为 summary-too-long 直接进入失败队列。",
        ],
        actionItems: [],
        urgency: "low",
        evidenceRefs: ["thread-msg-0"],
      }),
      finishReason: "stop",
    })),
  });

  const result = await processor.handle(makeJob(), makeCtx(null)) as SummaryThreadResult;

  assert.equal(result.mode, "thread");
  assert.ok(result.bullets.join("").length <= SUMMARY_BULLETS_MAX_CHARS);
});

test("SummaryProcessor rejects bad urgency", async () => {
  const badUrg = new SummaryProcessor({
    model: "x",
    llmClient: fakeClient(async () => ({
      text: JSON.stringify({
        bullets: ["a"],
        actionItems: [],
        urgency: "SEVERE",
      }),
      finishReason: "stop",
    })),
  });
  await assert.rejects(() => badUrg.handle(makeJob(), makeCtx(makeMessage())));
});

test("SummaryProcessor keeps invoice notifications one-line with no actions", async () => {
  const processor = new SummaryProcessor({
    model: "gpt-4o-mini",
    llmClient: fakeClient(async () => ({
      text: JSON.stringify({
        type: "summary",
        schemaVersion: 2,
        intent: "invoice",
        attention: "know",
        displayMode: "one_line",
        headline: "湖北电信已开具电子发票，PDF 已作为附件发送；无需回复。",
        details: ["电子发票可下载或打印使用。"],
        actions: ["下载并保存附件中的电子发票"],
        bullets: ["模型不应保留这条旧摘要"],
        actionItems: ["模型不应保留这条旧行动"],
        urgency: "medium",
      }),
      finishReason: "stop",
      usage: { inputTokens: 20, outputTokens: 8 },
    })),
  });

  const result = await processor.handle(
    makeJob(),
    makeCtx(makeMessage({
      subject: "湖北电信电子发票",
      from: { email: "notifications@example.com", name: "湖北电信" },
      bodyText: "附件是电子发票，可自行下载打印。如未收到请查垃圾箱。",
      hasAttachments: true,
    })),
  ) as SummaryResult;

  assert.equal(result.schemaVersion, 2);
  assert.equal(result.intent, "invoice");
  assert.equal(result.attention, "know");
  assert.equal(result.displayMode, "one_line");
  assert.equal(result.urgency, "low");
  assert.deepEqual(result.details, []);
  assert.deepEqual(result.actions, []);
  assert.deepEqual(result.bullets, [result.headline]);
  assert.deepEqual(result.actionItems, []);
});

test("SummaryProcessor preserves explicit actions for actionable requests", async () => {
  const processor = new SummaryProcessor({
    model: "gpt-4o-mini",
    llmClient: fakeClient(async () => ({
      text: JSON.stringify({
        type: "summary",
        schemaVersion: 2,
        intent: "request",
        attention: "act",
        displayMode: "actionable",
        headline: "客户要求周五前确认合同条款。",
        details: ["合同第 3 条和第 5 条需要复核。"],
        actions: ["周五前回复客户合同确认意见"],
        actionObligation: "required",
        bullets: [],
        actionItems: [],
        urgency: "low",
      }),
      finishReason: "stop",
    })),
  });

  const result = await processor.handle(makeJob(), makeCtx(makeMessage({
    subject: "合同确认",
    bodyText: "请你周五前确认合同第 3 条和第 5 条，并回复我。",
  }))) as SummaryResult;

  assert.deepEqual(result.bullets, [
    "客户要求周五前确认合同条款。",
    "合同第 3 条和第 5 条需要复核。",
  ]);
  assert.deepEqual(result.actionItems, ["周五前回复客户合同确认意见"]);
  assert.equal(result.actionObligation, "required");
  assert.equal(result.displayMode, "actionable");
  assert.equal(result.urgency, "low");
});

test("SummaryProcessor collapses low-urgency ordinary mail to one sentence", async () => {
  const processor = new SummaryProcessor({
    model: "gpt-4o-mini",
    llmClient: fakeClient(async () => ({
      text: JSON.stringify({
        type: "summary",
        schemaVersion: 2,
        intent: "request",
        attention: "act",
        displayMode: "actionable",
        headline: "VPNCheap 客服建议切换其他地区节点，并重启客户端或本地网络后重试。",
        details: [
          "工单问题为“怎么老挂啊”，客服建议先切换其他地区节点并重启客户端或本地网络后重试。",
          "客服说明会同步排查所有节点超时问题，请您稍等。",
        ],
        actions: [
          "先切换其他地区节点并重试连接。",
          "重启客户端后再连接。",
          "如仍异常，请重启本地网络后再尝试。",
        ],
        bullets: [],
        actionItems: [],
        urgency: "low",
      }),
      finishReason: "stop",
    })),
  });

  const result = await processor.handle(makeJob(), makeCtx(makeMessage({
    subject: "您在VPNCheap的工单得到了回复",
    from: { email: "no-reply@vpncheap.io", name: "VPNCheap" },
    bodyText: "请先尝试切换其他地区节点，并重启客户端或本地网络后再连接。",
  }))) as SummaryResult;

  assert.equal(result.displayMode, "one_line");
  assert.deepEqual(result.details, []);
  assert.deepEqual(result.actions, []);
  assert.deepEqual(result.bullets, [
    "VPNCheap 客服建议切换其他地区节点，并重启客户端或本地网络后重试。",
  ]);
  assert.deepEqual(result.actionItems, []);
});

test("SummaryProcessor throws when mail row is missing", async () => {
  const processor = new SummaryProcessor({
    model: "x",
    llmClient: fakeClient(async () => {
      throw new Error("should not be called");
    }),
  });
  await assert.rejects(
    () => processor.handle(makeJob(), makeCtx(null)),
    (err: Error) => err.message.includes("mail-missing"),
  );
});

// ── Thread-mode tests ──────────────────────────────────────────────

test("SummaryProcessor thread mode returns SummaryThreadResult with structured actionItems", async () => {
  const logs: Array<{ event: string; fields: Record<string, string | number> }> = [];
  const processor = new SummaryProcessor({
    model: "gpt-4o-mini",
    mode: "thread",
    threadMessages: [
      {
        emailId: "msg-1",
        subject: "Re: Q3 plans",
        from: "Boss <boss@x.com>",
        bodyText: "Please prepare the Q3 deck by Friday.",
        receivedAt: "2026-04-24T10:00:00Z",
      },
      {
        emailId: "msg-2",
        subject: "Re: Q3 plans",
        from: "Me <me@x.com>",
        bodyText: "I will have it ready by Thursday.",
        receivedAt: "2026-04-24T11:00:00Z",
      },
    ],
    llmClient: fakeClient(async () => ({
      text: JSON.stringify({
        bullets: ["Boss requested Q3 deck by Friday", "I committed to Thursday", "Deadline is approaching"],
        actionItems: [
          {
            text: "Prepare Q3 deck",
            owner: "me",
            deadline: "Thursday",
            evidenceRefs: ["thread-msg-0", "thread-msg-1"],
          },
        ],
        urgency: "high",
        evidenceRefs: ["thread-msg-0", "thread-msg-1"],
      }),
      finishReason: "stop",
      usage: { inputTokens: 50, outputTokens: 20 },
    })),
    logger: (event, fields) => logs.push({ event, fields }),
  });

  const result = (await processor.handle(makeJob(), makeCtx(null))) as SummaryThreadResult;

  assert.equal(result.type, "summary");
  assert.equal(result.mode, "thread");
  assert.equal(result.urgency, "high");
  assert.equal(result.bullets.length, 3);
  assert.equal(result.actionItems.length, 1);
  assert.equal(result.actionItems[0].text, "Prepare Q3 deck");
  assert.equal(result.actionItems[0].owner, "me");
  assert.equal(result.actionItems[0].deadline, "Thursday");
  assert.deepEqual(result.actionItems[0].evidenceRefs, ["thread-msg-0", "thread-msg-1"]);
  assert.deepEqual(result.evidenceRefs, ["thread-msg-0", "thread-msg-1"]);
  assert.ok(result._metadata);
  assert.equal(result._metadata.version, SUMMARY_PROCESSOR_VERSION);

  // Body-free logging
  const ok = logs.find((l) => l.event === "summary-thread-ok");
  assert.ok(ok);
  const serialized = JSON.stringify(logs);
  assert.ok(!serialized.includes("Q3 deck"));
});

test("SummaryProcessor thread mode with empty actionItems for marketing mail", async () => {
  const processor = new SummaryProcessor({
    model: "gpt-4o-mini",
    mode: "thread",
    threadMessages: [
      {
        emailId: "promo-1",
        subject: "50% off everything!",
        from: "deals@store.com",
        bodyText: "Shop our biggest sale of the year. Limited time only!",
        receivedAt: "2026-04-24T10:00:00Z",
      },
    ],
    llmClient: fakeClient(async () => ({
      text: JSON.stringify({
        bullets: ["Store is having a 50% off sale", "Sale is limited time", "Marketing promotion email"],
        actionItems: [],
        urgency: "low",
        evidenceRefs: ["thread-msg-0"],
      }),
      finishReason: "stop",
      usage: { inputTokens: 30, outputTokens: 10 },
    })),
  });

  const result = (await processor.handle(makeJob(), makeCtx(null))) as SummaryThreadResult;

  assert.equal(result.mode, "thread");
  assert.equal(result.actionItems.length, 0, "marketing mail should have no action items");
  assert.equal(result.urgency, "low");
});

test("SummaryProcessor thread mode throws when no thread messages provided", async () => {
  const processor = new SummaryProcessor({
    model: "x",
    mode: "thread",
    threadMessages: [],
    llmClient: fakeClient(async () => {
      throw new Error("should not be called");
    }),
  });

  await assert.rejects(
    () => processor.handle(makeJob(), makeCtx(null)),
    (err: unknown) => {
      assert.ok(err instanceof SummaryProcessorError);
      assert.equal((err as SummaryProcessorError).code, "no-thread-messages");
      assert.equal((err as SummaryProcessorError).retryable, false);
      return true;
    },
  );
});

test("SummaryProcessor thread mode sorts messages chronologically", async () => {
  let capturedUserMsg = "";
  const processor = new SummaryProcessor({
    model: "gpt-4o-mini",
    mode: "thread",
    threadMessages: [
      {
        emailId: "msg-newer",
        subject: "Later message",
        from: "a@x.com",
        bodyText: "Newer content",
        receivedAt: "2026-04-24T12:00:00Z",
      },
      {
        emailId: "msg-older",
        subject: "Earlier message",
        from: "b@x.com",
        bodyText: "Older content",
        receivedAt: "2026-04-24T10:00:00Z",
      },
    ],
    llmClient: fakeClient(async (req) => {
      const r = req as { messages: Array<{ content: string }> };
      capturedUserMsg = r.messages[0].content;
      return {
        text: JSON.stringify({
          bullets: ["Thread about topic", "Two messages exchanged", "Discussion ongoing"],
          actionItems: [],
          urgency: "low",
          evidenceRefs: ["thread-msg-0"],
        }),
        finishReason: "stop",
        usage: { inputTokens: 20, outputTokens: 10 },
      };
    }),
  });

  await processor.handle(makeJob(), makeCtx(null));

  // Older message should appear first (section thread-msg-0)
  const olderIdx = capturedUserMsg.indexOf("Earlier message");
  const newerIdx = capturedUserMsg.indexOf("Later message");
  assert.ok(olderIdx < newerIdx, "older message should come first in prompt");
});

test("SummaryProcessor thread mode validates evidenceRefs", async () => {
  const processor = new SummaryProcessor({
    model: "x",
    mode: "thread",
    threadMessages: [
      {
        emailId: "msg-1",
        subject: "Test",
        from: "a@x.com",
        bodyText: "Content",
        receivedAt: "2026-04-24T10:00:00Z",
      },
    ],
    llmClient: fakeClient(async () => ({
      text: JSON.stringify({
        bullets: ["One", "Two", "Three"],
        actionItems: [],
        urgency: "low",
        // Missing evidenceRefs
      }),
      finishReason: "stop",
    })),
  });

  await assert.rejects(
    () => processor.handle(makeJob(), makeCtx(null)),
    (err: unknown) => {
      assert.ok(err instanceof SummaryProcessorError);
      assert.equal((err as SummaryProcessorError).code, "invalid-evidenceRefs");
      return true;
    },
  );
});

test("SummaryProcessor thread mode validates actionItems have evidenceRefs", async () => {
  const processor = new SummaryProcessor({
    model: "x",
    mode: "thread",
    threadMessages: [
      {
        emailId: "msg-1",
        subject: "Test",
        from: "a@x.com",
        bodyText: "Content",
        receivedAt: "2026-04-24T10:00:00Z",
      },
    ],
    llmClient: fakeClient(async () => ({
      text: JSON.stringify({
        bullets: ["One", "Two", "Three"],
        actionItems: [{ text: "Do something" }], // Missing evidenceRefs
        urgency: "medium",
        evidenceRefs: ["thread-msg-0"],
      }),
      finishReason: "stop",
    })),
  });

  await assert.rejects(
    () => processor.handle(makeJob(), makeCtx(null)),
    (err: unknown) => {
      assert.ok(err instanceof SummaryProcessorError);
      assert.equal((err as SummaryProcessorError).code, "invalid-actionItems");
      return true;
    },
  );
});

test("SummaryProcessor thread mode handles risks and openQuestions", async () => {
  const processor = new SummaryProcessor({
    model: "gpt-4o-mini",
    mode: "thread",
    threadMessages: [
      {
        emailId: "msg-1",
        subject: "Project risk",
        from: "pm@x.com",
        bodyText: "The vendor may not deliver on time.",
        receivedAt: "2026-04-24T10:00:00Z",
      },
    ],
    llmClient: fakeClient(async () => ({
      text: JSON.stringify({
        bullets: ["Vendor delivery at risk", "Timeline may slip", "Mitigation needed"],
        actionItems: [],
        urgency: "high",
        risks: ["Vendor delivery delay"],
        openQuestions: ["What is the backup plan?"],
        evidenceRefs: ["thread-msg-0"],
      }),
      finishReason: "stop",
      usage: { inputTokens: 20, outputTokens: 15 },
    })),
  });

  const result = (await processor.handle(makeJob(), makeCtx(null))) as SummaryThreadResult;

  assert.ok(result.risks);
  assert.equal(result.risks!.length, 1);
  assert.equal(result.risks![0], "Vendor delivery delay");
  assert.ok(result.openQuestions);
  assert.equal(result.openQuestions!.length, 1);
  assert.equal(result.openQuestions![0], "What is the backup plan?");
});

// ── Language preference tests ──────────────────────────────────────

test("SummaryProcessor email mode appends language instruction for non-English", async () => {
  let capturedSystem = "";
  const processor = new SummaryProcessor({
    model: "gpt-4o-mini",
    summaryLanguage: "Chinese",
    llmClient: fakeClient(async (req) => {
      capturedSystem = (req as { system: string }).system;
      return {
        text: JSON.stringify({
          bullets: ["要点一", "要点二", "要点三"],
          actionItems: [],
          urgency: "low",
        }),
        finishReason: "stop",
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    }),
  });

  await processor.handle(makeJob(), makeCtx(makeMessage()));
  assert.ok(capturedSystem.includes("Chinese"), "system prompt should include language instruction");
});

test("SummaryProcessor thread mode appends language instruction for non-English", async () => {
  let capturedSystem = "";
  const processor = new SummaryProcessor({
    model: "gpt-4o-mini",
    mode: "thread",
    summaryLanguage: "Chinese",
    threadMessages: [
      {
        emailId: "msg-1",
        subject: "Test",
        from: "a@x.com",
        bodyText: "Content",
        receivedAt: "2026-04-24T10:00:00Z",
      },
    ],
    llmClient: fakeClient(async (req) => {
      capturedSystem = (req as { system: string }).system;
      return {
        text: JSON.stringify({
          bullets: ["要点一", "要点二", "要点三"],
          actionItems: [],
          urgency: "low",
          evidenceRefs: ["thread-msg-0"],
        }),
        finishReason: "stop",
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    }),
  });

  await processor.handle(makeJob(), makeCtx(null));
  assert.ok(capturedSystem.includes("Chinese"), "thread system prompt should include language instruction");
});

test("SummaryProcessor does not add language instruction for English", async () => {
  let capturedSystem = "";
  const processor = new SummaryProcessor({
    model: "gpt-4o-mini",
    summaryLanguage: "English",
    llmClient: fakeClient(async (req) => {
      capturedSystem = (req as { system: string }).system;
      return {
        text: JSON.stringify({
          bullets: ["one", "two", "three"],
          actionItems: [],
          urgency: "low",
        }),
        finishReason: "stop",
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    }),
  });

  await processor.handle(makeJob(), makeCtx(makeMessage()));
  assert.ok(!capturedSystem.includes("Produce all text fields in"), "English should not add language instruction");
});

test("SummaryProcessor thread mode user message includes language hint", async () => {
  let capturedUserMsg = "";
  const processor = new SummaryProcessor({
    model: "gpt-4o-mini",
    mode: "thread",
    summaryLanguage: "Chinese",
    threadMessages: [
      {
        emailId: "msg-1",
        subject: "Test",
        from: "a@x.com",
        bodyText: "Content",
        receivedAt: "2026-04-24T10:00:00Z",
      },
    ],
    llmClient: fakeClient(async (req) => {
      const r = req as { messages: Array<{ content: string }> };
      capturedUserMsg = r.messages[0].content;
      return {
        text: JSON.stringify({
          bullets: ["一", "二", "三"],
          actionItems: [],
          urgency: "low",
          evidenceRefs: ["thread-msg-0"],
        }),
        finishReason: "stop",
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    }),
  });

  await processor.handle(makeJob(), makeCtx(null));
  assert.ok(capturedUserMsg.includes("Produce the summary in Chinese"), "user message should include language hint");
});

// ── Thread mode error handling ─────────────────────────────────────

test("SummaryProcessor thread mode marks invalid JSON as non-retryable", async () => {
  const processor = new SummaryProcessor({
    model: "x",
    mode: "thread",
    threadMessages: [
      {
        emailId: "msg-1",
        subject: "Test",
        from: "a@x.com",
        bodyText: "Content",
        receivedAt: "2026-04-24T10:00:00Z",
      },
    ],
    llmClient: fakeClient(async () => ({
      text: "not json",
      finishReason: "stop",
    })),
  });

  await assert.rejects(
    () => processor.handle(makeJob(), makeCtx(null)),
    (err: unknown) => {
      assert.ok(err instanceof SummaryProcessorError);
      assert.equal((err as SummaryProcessorError).retryable, false);
      return true;
    },
  );
});

test("SummaryProcessor thread mode accepts fenced JSON when provider ignores structured response_format", async () => {
  const processor = new SummaryProcessor({
    model: "x",
    mode: "thread",
    threadMessages: [
      {
        emailId: "msg-1",
        subject: "Test",
        from: "a@x.com",
        bodyText: "Content",
        receivedAt: "2026-04-24T10:00:00Z",
      },
    ],
    llmClient: fakeClient(async () => ({
      text: "```json\n" + JSON.stringify({
        bullets: ["a", "b", "c"],
        actionItems: [],
        urgency: "low",
        evidenceRefs: ["thread-msg-0"],
      }) + "\n```",
      finishReason: "stop",
    })),
  });

  const result = (await processor.handle(
    makeJob(),
    makeCtx(null),
  )) as SummaryThreadResult;

  assert.equal(result.type, "summary");
  assert.equal(result.mode, "thread");
  assert.deepEqual(result.evidenceRefs, ["thread-msg-0"]);
});

test("SummaryProcessor defaults to Chinese and explicit English overrides it", async () => {
  let defaultSystem = "";
  const defaultChinese = new SummaryProcessor({
    model: "gpt-4o-mini",
    llmClient: fakeClient(async (req) => {
      defaultSystem = (req as { system: string }).system;
      return {
        text: JSON.stringify({
          bullets: ["默认中文"],
          actionItems: [],
          urgency: "low",
        }),
        finishReason: "stop",
      };
    }),
  });

  await defaultChinese.handle(makeJob(), makeCtx(makeMessage()));
  assert.ok(defaultSystem.includes("Chinese"));

  let englishSystem = "";
  const english = new SummaryProcessor({
    model: "gpt-4o-mini",
    summaryLanguage: "English",
    llmClient: fakeClient(async (req) => {
      englishSystem = (req as { system: string }).system;
      return {
        text: JSON.stringify({
          bullets: ["English"],
          actionItems: [],
          urgency: "low",
        }),
        finishReason: "stop",
      };
    }),
  });

  await english.handle(makeJob(), makeCtx(makeMessage()));
  assert.ok(!englishSystem.includes("Produce all text fields in Chinese"));
});

test("SummaryProcessor thread mode handles truncated response", async () => {
  const processor = new SummaryProcessor({
    model: "x",
    mode: "thread",
    threadMessages: [
      {
        emailId: "msg-1",
        subject: "Test",
        from: "a@x.com",
        bodyText: "Content",
        receivedAt: "2026-04-24T10:00:00Z",
      },
    ],
    llmClient: fakeClient(async () => ({
      text: JSON.stringify({
        bullets: ["a", "b", "c"],
        actionItems: [],
        urgency: "low",
        evidenceRefs: ["thread-msg-0"],
      }),
      finishReason: "length",
    })),
  });

  await assert.rejects(
    () => processor.handle(makeJob(), makeCtx(null)),
    (err: unknown) => {
      assert.ok(err instanceof SummaryProcessorError);
      assert.equal((err as SummaryProcessorError).code, "truncated");
      return true;
    },
  );
});

test("SummaryProcessor thread mode validates risks are strings", async () => {
  const processor = new SummaryProcessor({
    model: "x",
    mode: "thread",
    threadMessages: [
      {
        emailId: "msg-1",
        subject: "Test",
        from: "a@x.com",
        bodyText: "Content",
        receivedAt: "2026-04-24T10:00:00Z",
      },
    ],
    llmClient: fakeClient(async () => ({
      text: JSON.stringify({
        bullets: ["One", "Two", "Three"],
        actionItems: [],
        urgency: "low",
        risks: [123], // Not strings
        evidenceRefs: ["thread-msg-0"],
      }),
      finishReason: "stop",
    })),
  });

  await assert.rejects(
    () => processor.handle(makeJob(), makeCtx(null)),
    (err: unknown) => {
      assert.ok(err instanceof SummaryProcessorError);
      assert.equal((err as SummaryProcessorError).code, "invalid-risks");
      return true;
    },
  );
});

test("SummaryProcessor thread mode propagates LlmClientError", async () => {
  const processor = new SummaryProcessor({
    model: "x",
    mode: "thread",
    threadMessages: [
      {
        emailId: "msg-1",
        subject: "Test",
        from: "a@x.com",
        bodyText: "Content",
        receivedAt: "2026-04-24T10:00:00Z",
      },
    ],
    llmClient: fakeClient(async () => {
      throw new LlmClientError({ status: 503, code: "overloaded", message: "busy" });
    }),
  });

  await assert.rejects(
    () => processor.handle(makeJob(), makeCtx(null)),
    (err: unknown) => {
      assert.ok(err instanceof LlmClientError);
      assert.equal((err as LlmClientError).retryable, true);
      return true;
    },
  );
});

test("SummaryProcessor thread mode records usage tokens", async () => {
  const db = openOrCreateMailDatabase(":memory:");
  const usage = new AiUsageRepository(db, () => "2026-04-24T12:00:00.000Z");
  const processor = new SummaryProcessor({
    model: "gpt-4o-mini",
    mode: "thread",
    usage,
    threadMessages: [
      {
        emailId: "msg-1",
        subject: "Test",
        from: "a@x.com",
        bodyText: "Content",
        receivedAt: "2026-04-24T10:00:00Z",
      },
    ],
    llmClient: fakeClient(async () => ({
      text: JSON.stringify({
        bullets: ["One", "Two", "Three"],
        actionItems: [],
        urgency: "low",
        evidenceRefs: ["thread-msg-0"],
      }),
      finishReason: "stop",
      usage: { inputTokens: 30, outputTokens: 15 },
    })),
  });

  await processor.handle(makeJob(), makeCtx(null));

  const summary = usage.summarize({ accountId: "acct-1", period: "30d" });
  assert.deepEqual(summary.find((row) => row.category === "summary"), {
    category: "summary",
    label: "摘要",
    tokens: 45,
    calls: 1,
  });
});

test("SummaryProcessor thread mode validates openQuestions are strings", async () => {
  const processor = new SummaryProcessor({
    model: "x",
    mode: "thread",
    threadMessages: [
      {
        emailId: "msg-1",
        subject: "Test",
        from: "a@x.com",
        bodyText: "Content",
        receivedAt: "2026-04-24T10:00:00Z",
      },
    ],
    llmClient: fakeClient(async () => ({
      text: JSON.stringify({
        bullets: ["One", "Two", "Three"],
        actionItems: [],
        urgency: "low",
        openQuestions: [42],
        evidenceRefs: ["thread-msg-0"],
      }),
      finishReason: "stop",
    })),
  });

  await assert.rejects(
    () => processor.handle(makeJob(), makeCtx(null)),
    (err: unknown) => {
      assert.ok(err instanceof SummaryProcessorError);
      assert.equal((err as SummaryProcessorError).code, "invalid-openQuestions");
      return true;
    },
  );
});

test("SummaryProcessor default mode is email", async () => {
  const processor = new SummaryProcessor({
    model: "gpt-4o-mini",
    llmClient: fakeClient(async () => ({
      text: JSON.stringify({
        bullets: ["one", "two", "three"],
        actionItems: [],
        urgency: "low",
      }),
      finishReason: "stop",
      usage: { inputTokens: 10, outputTokens: 5 },
    })),
  });

  const result = await processor.handle(makeJob(), makeCtx(makeMessage()));
  // Email mode returns SummaryResult (no mode field, no evidenceRefs)
  assert.equal(result.type, "summary");
  assert.ok(!("mode" in result), "email mode result should not have mode field");
  assert.ok(!("evidenceRefs" in result), "email mode result should not have evidenceRefs field");
});

// ── Workspace injection (Route C / WP D) ───────────────────────────

test("SummaryProcessor email mode: undefined workspace yields byte-identical user message", async () => {
  let captureBaseline = "";
  const baseline = new SummaryProcessor({
    model: "gpt-4o-mini",
    llmClient: fakeClient(async (req) => {
      captureBaseline = (req as { messages: Array<{ content: string }> }).messages[0].content;
      return {
        text: JSON.stringify({
          bullets: ["a", "b", "c"],
          actionItems: [],
          urgency: "low",
        }),
        finishReason: "stop",
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    }),
  });
  await baseline.handle(makeJob(), makeCtx(makeMessage()));

  let captureExplicitUndef = "";
  const explicitUndef = new SummaryProcessor({
    model: "gpt-4o-mini",
    llmClient: fakeClient(async (req) => {
      captureExplicitUndef = (req as { messages: Array<{ content: string }> }).messages[0].content;
      return {
        text: JSON.stringify({
          bullets: ["a", "b", "c"],
          actionItems: [],
          urgency: "low",
        }),
        finishReason: "stop",
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    }),
  });
  // ctx with workspace explicitly undefined (no field) — should be byte-identical
  await explicitUndef.handle(makeJob(), makeCtx(makeMessage(), undefined));

  assert.equal(captureExplicitUndef, captureBaseline);
});

test("SummaryProcessor email mode: workspace injects [INBOX_OVERVIEW_MD] into user message", async () => {
  let capturedUser = "";
  const processor = new SummaryProcessor({
    model: "gpt-4o-mini",
    llmClient: fakeClient(async (req) => {
      capturedUser = (req as { messages: Array<{ content: string }> }).messages[0].content;
      return {
        text: JSON.stringify({
          bullets: ["a", "b", "c"],
          actionItems: [],
          urgency: "low",
        }),
        finishReason: "stop",
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    }),
  });

  await processor.handle(
    makeJob(),
    makeCtx(makeMessage(), {
      sections: [{ path: "inbox-overview.md", content: "重点项目: A/B/C" }],
      totalTokenEstimate: 8,
      truncated: false,
    }),
  );

  assert.ok(capturedUser.includes("<<<INBOX_OVERVIEW_MD>>>"), "should include workspace section header");
  assert.ok(capturedUser.includes("重点项目: A/B/C"), "should include workspace content verbatim");
});

test("SummaryProcessor thread mode: undefined workspace yields byte-identical user message", async () => {
  const threadMessages = [
    {
      emailId: "msg-1",
      subject: "Test",
      from: "a@x.com",
      bodyText: "Content",
      receivedAt: "2026-04-24T10:00:00Z",
    },
  ];

  let captureBaseline = "";
  const baseline = new SummaryProcessor({
    model: "gpt-4o-mini",
    mode: "thread",
    threadMessages,
    llmClient: fakeClient(async (req) => {
      captureBaseline = (req as { messages: Array<{ content: string }> }).messages[0].content;
      return {
        text: JSON.stringify({
          bullets: ["a", "b", "c"],
          actionItems: [],
          urgency: "low",
          evidenceRefs: ["thread-msg-0"],
        }),
        finishReason: "stop",
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    }),
  });
  await baseline.handle(makeJob(), makeCtx(null));

  let captureExplicitUndef = "";
  const explicitUndef = new SummaryProcessor({
    model: "gpt-4o-mini",
    mode: "thread",
    threadMessages,
    llmClient: fakeClient(async (req) => {
      captureExplicitUndef = (req as { messages: Array<{ content: string }> }).messages[0].content;
      return {
        text: JSON.stringify({
          bullets: ["a", "b", "c"],
          actionItems: [],
          urgency: "low",
          evidenceRefs: ["thread-msg-0"],
        }),
        finishReason: "stop",
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    }),
  });
  await explicitUndef.handle(makeJob(), makeCtx(null, undefined));

  assert.equal(captureExplicitUndef, captureBaseline);
});

test("SummaryProcessor thread mode: workspace injects [INBOX_OVERVIEW_MD] into user message", async () => {
  let capturedUser = "";
  const processor = new SummaryProcessor({
    model: "gpt-4o-mini",
    mode: "thread",
    threadMessages: [
      {
        emailId: "msg-1",
        subject: "Test",
        from: "a@x.com",
        bodyText: "Content",
        receivedAt: "2026-04-24T10:00:00Z",
      },
    ],
    llmClient: fakeClient(async (req) => {
      capturedUser = (req as { messages: Array<{ content: string }> }).messages[0].content;
      return {
        text: JSON.stringify({
          bullets: ["a", "b", "c"],
          actionItems: [],
          urgency: "low",
          evidenceRefs: ["thread-msg-0"],
        }),
        finishReason: "stop",
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    }),
  });

  await processor.handle(
    makeJob(),
    makeCtx(null, {
      sections: [{ path: "inbox-overview.md", content: "重点项目: A/B/C" }],
      totalTokenEstimate: 8,
      truncated: false,
    }),
  );

  assert.ok(capturedUser.includes("<<<INBOX_OVERVIEW_MD>>>"), "thread user message should include workspace header");
  assert.ok(capturedUser.includes("重点项目: A/B/C"), "thread user message should include workspace content verbatim");
});

test("SummaryProcessor thread mode uses thread schema and prompt", async () => {
  let capturedSchema: unknown = null;
  let capturedSystem: string = "";
  const processor = new SummaryProcessor({
    model: "gpt-4o-mini",
    mode: "thread",
    threadMessages: [
      {
        emailId: "msg-1",
        subject: "Test",
        from: "a@x.com",
        bodyText: "Content",
        receivedAt: "2026-04-24T10:00:00Z",
      },
    ],
    llmClient: fakeClient(async (req) => {
      const r = req as { jsonSchema: unknown; system: string };
      capturedSchema = r.jsonSchema;
      capturedSystem = r.system;
      return {
        text: JSON.stringify({
          bullets: ["One", "Two", "Three"],
          actionItems: [],
          urgency: "low",
          evidenceRefs: ["thread-msg-0"],
        }),
        finishReason: "stop",
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    }),
  });

  await processor.handle(makeJob(), makeCtx(null));

  // Should use the thread schema (has evidenceRefs property)
  const schema = capturedSchema as Record<string, unknown>;
  const props = schema.properties as Record<string, unknown>;
  assert.ok("evidenceRefs" in props, "thread schema should include evidenceRefs");
  assert.ok("actionItems" in props, "thread schema should include actionItems");
  assert.ok(capturedSystem.includes("email thread"), "thread system prompt should mention thread");
});
