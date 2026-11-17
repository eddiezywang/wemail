import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { ExecutionPipelineDraft } from "../../../shared/wemail/skillCenter.js";
import {
  classifyReviewReply,
  PipelinePreviewStore,
  PipelineReviewService,
} from "./PipelineReviewService.js";

function draft(): ExecutionPipelineDraft {
  return {
    id: "pipeline-review",
    accountId: "account-1",
    revision: 1,
    mode: "automation",
    trigger: {
      event: "schedule",
      timing: { localTime: "21:00", timezone: "Asia/Shanghai" },
    },
    dataSelection: {
      version: 1,
      source: "mail",
      scope: { type: "calendar_day", timezone: "Asia/Shanghai" },
      filters: [{ field: "subject", operator: "contains", value: "告警" }],
      limits: { maxMessages: 1000 },
    },
    analysis: {
      version: 1,
      inputKinds: ["mail-collection"],
      dimensions: [{ id: "hour", field: "hour" }],
      metrics: [{ id: "requests", label: "调用量", aggregation: "sum", field: "requestCount" }],
      modelTasks: [{ id: "summary", instruction: "总结告警", outputFields: ["summary"], maxInputItems: 100 }],
      conclusions: [],
      outputSchema: {},
    },
    artifact: {
      version: 1,
      format: "html",
      title: "银行电销会话分析日报",
      components: [{ id: "trend", type: "line_chart", title: "小时趋势" }],
      layout: { structure: "report", sections: ["trend"] },
      theme: { name: "wemail" },
      accessibility: { includeTextSummary: true, chartDescriptions: true },
      emptyState: "当天没有监控数据",
      errorState: "报告生成失败",
      outputSchema: {},
    },
    delivery: {
      version: 1,
      destinations: [
        { type: "message_center", enabled: true },
        { type: "connected_bot", enabled: true },
      ],
      content: {
        includeSummary: true,
        includeImage: false,
        includeArtifactLink: true,
      },
      fallbackPolicy: {
        type: "first_available",
        priority: ["feishu_bot", "wecom_bot"],
        messageCenterRequired: true,
      },
    },
    steps: [],
    skillSnapshots: [],
    capabilitySnapshots: [],
    reviews: [],
    validation: { status: "not_validated", issues: [] },
    createdAt: "2026-07-29T00:00:00.000Z",
    updatedAt: "2026-07-29T00:00:00.000Z",
  };
}

test("review replies are conversational, unambiguous, and version-bound", () => {
  const service = new PipelineReviewService(() => "2026-07-29T12:00:00.000Z");
  let current = service.synchronizeCheckpoints(draft(), {
    artifact: { previewId: "preview-1", previewUrl: "/preview/1" },
  });
  const artifact = current.reviews.find((review) => review.target === "artifact")!;

  const ambiguous = service.respond(current, artifact.id, "我再想想");
  assert.equal(ambiguous.classification, "ambiguous");
  assert.equal(
    ambiguous.draft.reviews.find((review) => review.id === artifact.id)?.status,
    "pending",
  );

  const accepted = service.respond(current, artifact.id, "符合，就这样");
  assert.equal(accepted.classification, "accept");
  current = accepted.draft;
  assert.equal(
    current.reviews.find((review) => review.id === artifact.id)?.status,
    "accepted",
  );

  const recipeV2 = {
    ...current.artifact!,
    version: 2,
    theme: { name: "wemail", tokens: { failure: "#dc2626" } },
  };
  current = service.revise(current, "artifact", recipeV2, {
    previewId: "preview-2",
    previewUrl: "/preview/2",
  });
  assert.equal(
    current.reviews.find((review) => review.id === artifact.id)?.status,
    "stale",
  );
  const latest = current.reviews.filter((review) => review.target === "artifact").at(-1)!;
  assert.equal(latest.targetVersion, 2);
  assert.equal(latest.status, "pending");
  assert.throws(
    () => service.respond(current, artifact.id, "可以"),
    /review-checkpoint-not-current/,
  );
});

test("upstream revision invalidates dependent reviews but delivery-only change preserves upstream acceptance", () => {
  const service = new PipelineReviewService();
  let current = service.synchronizeCheckpoints(draft());
  for (const target of ["data", "analysis", "artifact", "delivery"] as const) {
    const checkpoint = current.reviews.filter((review) => review.target === target).at(-1)!;
    current = service.respond(current, checkpoint.id, "可以").draft;
  }
  const revisedData = {
    ...current.dataSelection!,
    version: 2,
    filters: [
      ...current.dataSelection!.filters,
      { field: "subject", operator: "contains", value: "执行报告" },
    ],
  };
  const afterData = service.revise(current, "data", revisedData);
  assert.equal(
    afterData.reviews.find((review) => review.target === "analysis")?.status,
    "stale",
  );
  assert.equal(
    afterData.reviews.find((review) => review.target === "artifact")?.status,
    "stale",
  );

  const reset = service.synchronizeCheckpoints(draft());
  let accepted = reset;
  for (const target of ["data", "analysis", "artifact", "delivery"] as const) {
    const checkpoint = accepted.reviews.filter((review) => review.target === target).at(-1)!;
    accepted = service.respond(accepted, checkpoint.id, "接受").draft;
  }
  const changedPriority = {
    ...accepted.delivery!,
    version: 2,
    fallbackPolicy: {
      ...accepted.delivery!.fallbackPolicy,
      priority: ["wecom_bot", "feishu_bot"] as Array<"feishu_bot" | "wecom_bot">,
    },
  };
  const afterDelivery = service.revise(accepted, "delivery", changedPriority);
  assert.ok(
    afterDelivery.reviews
      .filter((review) => review.target !== "delivery")
      .every((review) => review.status === "accepted"),
  );
});

test("artifact preview contains a real accessible line chart and escaped sample values", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-preview-"));
  try {
    const store = new PipelinePreviewStore(root);
    const preview = store.createArtifactPreview({
      pipelineId: "pipeline-1",
      title: "当日监控日报",
      format: "html",
      rows: [
        { hour: "20:00", requestCount: 100 },
        { hour: "21:00<script>", requestCount: 120 },
      ],
      xField: "hour",
      series: [{ field: "requestCount", label: "调用量" }],
      textSummary: "调用量从 100 上升到 120。",
    });
    const html = store.read("pipeline-1", preview.previewId);
    assert.match(html, /<svg role="img"/);
    assert.match(html, /<polyline/);
    assert.match(html, /请回到对话中用自然语言确认/);
    assert.doesNotMatch(html, /21:00<script>/);
    assert.match(html, /21:00&lt;script&gt;/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("preview store renders bounded data, analysis, image, PDF, and Bot message forms without side effects", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-preview-forms-"));
  try {
    const store = new PipelinePreviewStore(root);
    const data = store.createDataPreview({
      pipelineId: "pipeline-forms",
      title: "告警邮件匹配",
      matches: Array.from({ length: 25 }, (_, index) => ({
        emailId: `mail-${index}`,
        subject: `告警 ${index}`,
        reason: "主题命中",
      })),
    });
    const dataHtml = store.read("pipeline-forms", data.previewId);
    assert.match(dataHtml, /共匹配 25 封邮件/);
    assert.doesNotMatch(dataHtml, /mail-24/);

    const analysis = store.createAnalysisPreview({
      pipelineId: "pipeline-forms",
      title: "分析样本",
      rows: [{ hour: "21:00", count: 120 }],
      provenance: [{ outputPath: "rows.0", emailIds: ["mail-1"] }],
      summary: "调用量 120",
    });
    assert.match(store.read("pipeline-forms", analysis.previewId), /来源样本 1 条/);

    const image = store.createArtifactPreview({
      pipelineId: "pipeline-forms",
      title: "趋势图片",
      format: "image",
      rows: [{ hour: "20:00", count: 100 }, { hour: "21:00", count: 120 }],
      xField: "hour",
      series: [{ field: "count", label: "调用量" }],
      textSummary: "调用量趋势",
    });
    const imageResource = store.readResource("pipeline-forms", image.previewId);
    assert.equal(imageResource.contentType, "image/svg+xml");
    assert.match(imageResource.body.toString("utf8"), /<polyline/);

    const pdf = store.createArtifactPreview({
      pipelineId: "pipeline-forms",
      title: "PDF 日报",
      format: "pdf",
      rows: [{ hour: "21:00", count: 120 }],
      textSummary: "调用量 120",
    });
    const pdfResource = store.readResource("pipeline-forms", pdf.previewId);
    assert.equal(pdfResource.contentType, "application/pdf");
    assert.match(pdfResource.body.toString("utf8", 0, 8), /%PDF-1.4/);

    const bot = store.createBotMessagePreview({
      pipelineId: "pipeline-forms",
      title: "监控日报",
      body: "报告已经生成",
      destination: "企业微信 Bot",
    });
    const botHtml = store.read("pipeline-forms", bot.previewId);
    assert.match(botHtml, /企业微信 Bot/);
    assert.match(botHtml, /不会发送消息/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("review classifier does not treat vague replies as approval", () => {
  assert.equal(classifyReviewReply("可以"), "accept");
  assert.equal(classifyReviewReply("把失败率改成红色"), "revise");
  assert.equal(classifyReviewReply("不行"), "reject");
  assert.equal(classifyReviewReply("你看着办"), "ambiguous");
});
