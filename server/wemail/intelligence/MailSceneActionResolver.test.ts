import assert from "node:assert/strict";
import { test } from "node:test";
import type { MailSceneAction } from "../../../shared/wemail/intelligence.js";
import type { SummaryResult } from "../../../shared/wemail/intelligence.js";
import type { MailMessage } from "../../../shared/wemail/mail.js";
import {
  defaultSceneActionContributors,
  resolveMailSceneActions,
  type MailSceneActionInput,
} from "./MailSceneActionResolver.js";

function message(attachments: MailMessage["attachments"] = []): MailMessage {
  return {
    id: "mail-1",
    accountId: "acct-1",
    folder: "INBOX",
    messageId: "m-1",
    from: { email: "monitor@example.com" },
    to: [{ email: "me@example.com" }],
    cc: [],
    bcc: [],
    subject: "小时监控报表",
    snippet: "",
    bodyText: "调用量 100，失败量 2",
    receivedAt: "2026-07-31T01:00:00.000Z",
    hasAttachments: attachments.length > 0,
    attachments,
    flags: { seen: false, flagged: false, answered: false, draft: false },
    sync: {
      uid: 1,
      uidValidity: 1,
      internalDate: "2026-07-31T01:00:00.000Z",
    },
  };
}

const monitoringSummary: SummaryResult = {
  type: "summary",
  schemaVersion: 3,
  headline: "失败量为 2。",
  bullets: ["失败量为 2。"],
  actionItems: [],
  urgency: "low",
  dataInsight: {
    kind: "monitoring_report",
    metrics: [
      { label: "调用量", value: "100" },
      { label: "失败量", value: "2" },
    ],
    findings: [{ kind: "fact", text: "当前失败量为 2。" }],
    evidenceLevel: "snapshot",
    chartRecommended: true,
  },
};

test("resolves chart action only from a chartable monitoring insight", () => {
  const chartActions = resolveMailSceneActions({
    message: message(),
    summary: monitoringSummary,
    invoiceIntent: false,
  });
  assert.deepEqual(chartActions.map((action) => action.id), ["monitoring.generate_chart"]);
  const prompt = chartActions[0]?.agentPrompt ?? "";
  assert.match(prompt, /ship（生成图表）/);
  assert.match(prompt, /wemail-insight-report/);
  assert.match(prompt, /extract_email_tables/);
  assert.match(prompt, /publish_design_artifact/);
  assert.match(prompt, /autoPivot:true/);
  assert.match(prompt, /analysisPlan/);
  assert.match(prompt, /禁止用 `autoPivot` 覆盖/);
  assert.match(prompt, /投递到 WeMail 消息中心/);
  assert.match(prompt, /不要输出分析过程/);
  assert.match(prompt, /最终回复只给出简短执行结果/);
  assert.deepEqual(
    resolveMailSceneActions({
      message: message(),
      summary: {
        ...monitoringSummary,
        dataInsight: {
          ...monitoringSummary.dataInsight!,
          chartRecommended: false,
        },
      },
      invoiceIntent: false,
    }),
    [],
  );
});

test("open edition resolves no invoice upload action (edition-gated)", () => {
  // P2.6: the invoice-attachment heuristic moved to the edition module; the
  // open default is constant false, so even invoice-like mail with intent
  // and recorded statuses resolves no invoice.upload action. The full
  // action-catalog coverage (uploaded/not_uploaded labels) runs in the
  // edition overlay where the module is assembled.
  const invoice = message([
    {
      id: "pdf-1",
      filename: "电子发票.pdf",
      mimetype: "application/pdf",
      size: 128,
    },
  ]);
  assert.deepEqual(
    resolveMailSceneActions({
      message: invoice,
      invoiceIntent: true,
      invoiceStatus: { tag: "未处理发票", state: "not_uploaded", statuses: [] },
    }),
    [],
  );
  assert.deepEqual(
    resolveMailSceneActions({
      message: invoice,
      invoiceIntent: true,
      invoiceStatus: { tag: "已处理发票", state: "uploaded", statuses: [] },
    }),
    [],
  );
});

test("projects required summary actions into executable agent actions", () => {
  const actions = resolveMailSceneActions({
    message: message(),
    invoiceIntent: false,
    summary: {
      type: "summary",
      schemaVersion: 3,
      intent: "request",
      attention: "act",
      displayMode: "actionable",
      headline: "客户要求下周确认续约。",
      details: [],
      actions: ["下周前回复客户是否续约"],
      actionObligation: "required",
      bullets: ["客户要求下周确认续约。"],
      actionItems: ["下周前回复客户是否续约"],
      urgency: "low",
    },
  });

  assert.deepEqual(actions.map((action) => ({
    id: action.id,
    scene: action.scene,
    label: action.label,
  })), [{
    id: "summary.action.1",
    scene: "summary_action",
    label: "下周前回复客户是否续约",
  }]);
  assert.match(actions[0]?.agentPrompt ?? "", /等待我确认后再执行/);
});

test("summary action prompt carries only the generic confirmation skeleton", () => {
  const actions = resolveMailSceneActions({
    invoiceIntent: false,
    summary: {
      type: "summary",
      schemaVersion: 3,
      intent: "request",
      attention: "act",
      displayMode: "actionable",
      headline: "客户要求下周确认续约。",
      details: [],
      actions: ["下周前回复客户是否续约"],
      actionObligation: "required",
      bullets: ["客户要求下周确认续约。"],
      actionItems: ["下周前回复客户是否续约"],
      urgency: "low",
    },
  });
  const prompt = actions[0]?.agentPrompt ?? "";
  assert.match(prompt, /先说明依据/);
  assert.match(prompt, /等待我确认后再执行/);
  // Edition-specific platform exploration guidance is contributed through
  // scene action contributors, never embedded in the open resolver.
  assert.doesNotMatch(prompt, /wecLi_query|服务台|PACE\+|SDL|企业平台操作/i);
});

test("scene action contributors append edition actions after built-ins", () => {
  const requiredSummary: SummaryResult = {
    type: "summary",
    schemaVersion: 3,
    intent: "request",
    attention: "act",
    displayMode: "actionable",
    headline: "客户要求下周确认续约。",
    details: [],
    actions: ["下周前回复客户是否续约"],
    actionObligation: "required",
    bullets: ["客户要求下周确认续约。"],
    actionItems: ["下周前回复客户是否续约"],
    urgency: "low",
  };
  const contributed: MailSceneAction = {
    id: "edition.office-reminder",
    scene: "edition",
    label: "跟进系统待办",
    icon: "action",
    status: "available",
    agentPrompt: "先查询平台待办状态，再提出处理方案；涉及提交时等我确认。",
    risk: "none",
  };
  const contributors = [(input: MailSceneActionInput) => (input.summary ? [contributed] : [])];
  const actions = resolveMailSceneActions({
    invoiceIntent: false,
    summary: requiredSummary,
    contributors,
  });
  assert.deepEqual(
    actions.map((action) => action.id),
    ["summary.action.1", "edition.office-reminder"],
  );
  // Contributors never fire without a summary-backed input.
  assert.deepEqual(
    resolveMailSceneActions({ invoiceIntent: false, contributors }).map((action) => action.id),
    [],
  );
  // No global state: the same input without an explicit contributor set
  // falls back to the build registration (open edition: none).
  assert.deepEqual(
    resolveMailSceneActions({
      invoiceIntent: false,
      summary: requiredSummary,
    }).map((action) => action.id),
    ["summary.action.1"],
  );
});

test("explicit contributor sets are per-call and an empty array means off", () => {
  const requiredSummary: SummaryResult = {
    type: "summary",
    schemaVersion: 3,
    intent: "request",
    attention: "act",
    displayMode: "actionable",
    headline: "请处理待办。",
    details: [],
    actions: ["处理待办"],
    actionObligation: "required",
    bullets: ["请处理待办。"],
    actionItems: ["处理待办"],
    urgency: "low",
  };
  const make = (id: MailSceneAction["id"]) => (): MailSceneAction[] => [{
    id,
    scene: "edition",
    label: id,
    icon: "action",
    status: "available",
    agentPrompt: "wait for confirmation",
    risk: "none",
  }];
  const first = resolveMailSceneActions({
    invoiceIntent: false,
    summary: requiredSummary,
    contributors: [make("edition.first")],
  });
  const second = resolveMailSceneActions({
    invoiceIntent: false,
    summary: requiredSummary,
    contributors: [make("edition.second")],
  });
  const disabled = resolveMailSceneActions({
    invoiceIntent: false,
    summary: requiredSummary,
    contributors: [],
  });
  assert.deepEqual(
    first.map((action) => action.id),
    ["summary.action.1", "edition.first"],
  );
  assert.deepEqual(
    second.map((action) => action.id),
    ["summary.action.1", "edition.second"],
  );
  // An explicit empty array must NOT restore the build registration.
  assert.deepEqual(disabled.map((action) => action.id), ["summary.action.1"]);
  // The open build registers no contributors by default.
  assert.deepEqual(defaultSceneActionContributors(), []);
});

test("does not promote optional summary suggestions into executable actions", () => {
  const actions = resolveMailSceneActions({
    invoiceIntent: false,
    summary: {
      type: "summary",
      schemaVersion: 3,
      intent: "other",
      attention: "know",
      displayMode: "brief",
      headline: "可以尝试重新连接。",
      details: [],
      actions: ["重新连接"],
      actionObligation: "optional",
      bullets: ["可以尝试重新连接。"],
      actionItems: ["重新连接"],
      urgency: "low",
    },
  });

  assert.deepEqual(actions, []);
});
