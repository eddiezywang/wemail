import assert from "node:assert/strict";
import { test } from "node:test";
import { validateToolArguments } from "@earendil-works/pi-ai";
import type { TemporalExpression } from "../../../shared/wemail/automation.js";
import type { AgentTool } from "./AgentRuntime.js";
import {
  createWemailAgentTools,
  describeTemporalExpression,
  type WemailAgentToolDeps,
} from "./WemailAgentTools.js";

const delay = { type: "delay", amount: 24, unit: "hour" } as const;
const latestInvoicePlus24Hours = {
  type: "addDuration",
  base: {
    type: "aggregate",
    operator: "max",
    values: {
      type: "field",
      path: "invoice.issueDate",
      scope: "matchingAttachments",
    },
  },
  duration: { amount: 24, unit: "hour" },
} as const satisfies TemporalExpression;
const latestInvoiceOrReceivedPlus24Hours = {
  type: "addDuration",
  base: {
    type: "coalesce",
    values: [
      {
        type: "aggregate",
        operator: "max",
        values: {
          type: "field",
          path: "invoice.issueDate",
          scope: "matchingAttachments",
        },
      },
      { type: "field", path: "mail.receivedAt", scope: "mail" },
    ],
  },
  duration: { amount: 24, unit: "hour" },
} as const satisfies TemporalExpression;
const unreducedInvoicePlus24Hours = {
  type: "addDuration",
  base: {
    type: "field",
    path: "invoice.issueDate",
    scope: "matchingAttachments",
  },
  duration: { amount: 24, unit: "hour" },
} as const satisfies TemporalExpression;
const unknownField = {
  type: "field",
  path: "mail.sentAt",
  scope: "mail",
} as const satisfies TemporalExpression;

function createHarness(overrides: Partial<WemailAgentToolDeps> = {}) {
  const proposed: Array<{
    description: string;
    inputJson: string;
  }> = [];
  const deps = {
    getActiveAccountId: () => "acct-1",
    dryRunner: {
      dryRunDraft: () => ({
        ok: true,
        ruleId: "preview",
        matched: [],
        matchedCount: 0,
        dryRun: true,
      }),
    },
    pendingActions: {
      insert(action: { description: string; inputJson: string }) {
        proposed.push(action);
      },
    },
    ...overrides,
  } as unknown as WemailAgentToolDeps;
  return {
    proposed,
    tools: createWemailAgentTools(deps),
  };
}

function createDraftMailStub() {
  const drafts = new Map<string, Record<string, unknown>>();
  let generatedId = 0;
  const mailDatabase = {
    async getDraft(input: { accountId: string; id: string }) {
      const draft = drafts.get(input.id);
      return draft?.accountId === input.accountId ? draft : null;
    },
    async listDrafts(input: { accountId: string }) {
      return [...drafts.values()].filter((draft) => draft.accountId === input.accountId);
    },
    async saveDraft(input: Record<string, unknown>) {
      const id = typeof input.id === "string" ? input.id : `draft-generated-${++generatedId}`;
      const existing = drafts.get(id);
      // Mirrors MailDatabaseWriter.saveDraft: a public draft id is globally
      // unique, so saving under another account's id must be refused.
      if (existing && existing.accountId !== input.accountId) {
        throw new Error("draft-account-mismatch");
      }
      const draft = {
        ...existing,
        ...input,
        id,
        type: input.originalEmailId ? "reply" : "new",
        status: "draft",
        createdAt: existing?.createdAt ?? "2026-07-30T16:34:00.000Z",
        updatedAt: existing ? "2026-07-30T16:35:00.000Z" : "2026-07-30T16:34:00.000Z",
      };
      drafts.set(id, draft);
      return { value: draft, commitVersion: 1, changes: [] };
    },
  };
  return { drafts, mailDatabase };
}

function byName(tools: AgentTool[], name: string): AgentTool {
  const tool = tools.find((candidate) => candidate.name === name);
  assert.ok(tool, `missing tool ${name}`);
  return tool;
}

function ruleInput(execution: Record<string, unknown>) {
  return {
    name: "发票提醒",
    trigger: { type: "mailReceived", execution },
    naturalLanguageCondition: "邮件包含发票附件",
    conditions: {},
    actions: [{ type: "archive" }],
  };
}

function validateWithPi(tool: AgentTool, arguments_: Record<string, unknown>): unknown {
  return validateToolArguments(
    {
      name: tool.name,
      description: tool.description,
      parameters: JSON.parse(JSON.stringify(tool.inputSchema)),
    },
    {
      type: "toolCall",
      id: "tool-call-1",
      name: tool.name,
      arguments: arguments_,
    },
  );
}

test("publish_design_artifact accepts a minimal call and reuses this run's extracted dataset", async () => {
  const published: Array<Record<string, unknown>> = [];
  const html = [
    "<table><tr><th>model</th><th>cnt</th></tr><tr><td>a</td><td>3</td></tr></table>",
    "<table><tr><th>model</th><th>latency</th></tr><tr><td>a</td><td>10</td></tr></table>",
  ].join("");
  const { tools } = createHarness({
    mailDatabase: {
      async getMailSnapshot() {
        return {
          message: {
            id: "mail-1",
            subject: "Model health",
            receivedAt: "2026-08-03T08:00:00.000Z",
            bodyHtml: html,
          },
        };
      },
    } as unknown as WemailAgentToolDeps["mailDatabase"],
    artifactDelivery: {
      publish(input: Record<string, unknown>) {
        published.push(input);
        return {
          // Mirrors AgentArtifactDeliveryService: the artifact carries the
          // application message pointer, validated by publish_design_artifact.
          artifact: {
            artifactId: "artifact-1",
            applicationMessageId: "message-1",
            title: input.title,
          },
          applicationMessage: { id: "message-1", title: input.title },
        };
      },
    } as unknown as WemailAgentToolDeps["artifactDelivery"],
  });
  const extract = byName(tools, "extract_email_tables");
  const publish = byName(tools, "publish_design_artifact");
  const ctx = {
    sessionId: "conversation-1",
    runContext: { runId: "run-artifact-1", accountId: "acct-1", emailId: "mail-1" },
  };

  assert.doesNotThrow(() => validateWithPi(publish, { mode: "brief" }));
  assert.doesNotThrow(() => validateWithPi(publish, {
    mode: "report",
    analysisPlan: {
      dimensions: [
        { field: "type", requiredValues: ["实时", "离线"] },
        { field: "model", requiredValues: ["A", "B"] },
        { field: "window", requiredValues: ["最近一小时", "当天"], overlapping: true },
      ],
      measures: [{ field: "value", agg: "sum" }],
    },
    charts: [{ family: "dumbbell", x: "type", y: "lastHour", y2: "today", switchLabel: "类型" }],
  }));
  assert.throws(() => validateWithPi(publish, {
    mode: "report",
    analysisPlan: {
      dimensions: [{ field: "type", label: "类型" }],
      measures: [{ field: "value", agg: "sum" }],
    },
  }));
  const extracted = await extract.handler({}, ctx) as { ok: boolean; datasetId: string };
  assert.equal(extracted.ok, true);
  const result = await publish.handler({ mode: "brief", autoPivot: true }, ctx) as { ok: boolean };

  assert.equal(result.ok, true);
  assert.equal(published.length, 1);
  assert.equal(typeof published[0].title, "string");
  assert.equal(published[0].autoPivot, true);
  const dataset = published[0].dataset as { rows: unknown[]; rawTables: unknown[] };
  assert.equal(dataset.rows.length, 1);
  assert.equal(dataset.rawTables.length, 2);

  const crossRun = await publish.handler({ datasetId: extracted.datasetId }, {
    sessionId: "conversation-1",
    runContext: { runId: "run-artifact-2", accountId: "acct-1" },
  }) as { ok: boolean; code: string };
  assert.deepEqual(crossRun, {
    ok: false,
    code: "dataset-not-found",
    error: "dataset-not-found",
    datasetId: extracted.datasetId,
  });
});

test("publish_design_artifact returns a stable error when this run has no dataset", async () => {
  const { tools } = createHarness({
    artifactDelivery: {
      publish() {
        throw new Error("must not publish");
      },
    } as unknown as WemailAgentToolDeps["artifactDelivery"],
  });
  const result = await byName(tools, "publish_design_artifact").handler({ mode: "brief" }, {
    sessionId: "conversation-empty",
    runContext: { runId: "run-empty", accountId: "acct-1" },
  }) as { ok: boolean; code: string };

  assert.equal(result.ok, false);
  assert.equal(result.code, "dataset-required");
});

test("save_mail_draft creates and idempotently updates a caller-supplied draft id", async () => {
  const { drafts, mailDatabase } = createDraftMailStub();
  const { tools } = createHarness({ mailDatabase: mailDatabase as unknown as WemailAgentToolDeps["mailDatabase"] });
  const tool = byName(tools, "save_mail_draft");
  const input = {
    accountId: "acct-1",
    draftId: "draft-forward-20260730-1634",
    draftType: "forward",
    originalEmailId: "acct-1:INBOX:1:1667488407",
    to: ["kuixu@example.com"],
    cc: ["qingyiluan@example.com"],
    subject: "Fw: delivery check",
    bodyText: "forwarded body",
  };

  const created = await tool.handler(input, {}) as {
    ok: boolean;
    draft: { id: string };
  };
  assert.equal(created.ok, true);
  assert.equal(created.draft.id, input.draftId);
  assert.equal(drafts.size, 1);
  assert.deepEqual(drafts.get(input.draftId)?.cc, [{ email: "qingyiluan@example.com" }]);
  assert.equal(drafts.get(input.draftId)?.type, "reply");

  const updated = await tool.handler({
    ...input,
    subject: "Fw: updated delivery check",
  }, {}) as {
    ok: boolean;
    draft: { id: string; subject: string };
  };
  assert.equal(updated.ok, true);
  assert.equal(updated.draft.id, input.draftId);
  assert.equal(updated.draft.subject, "Fw: updated delivery check");
  assert.equal(drafts.size, 1);
});

test("save_mail_draft refuses to overwrite a caller-supplied id owned by another account", async () => {
  const { drafts, mailDatabase } = createDraftMailStub();
  drafts.set("draft-shared", {
    id: "draft-shared",
    accountId: "acct-2",
    type: "new",
    to: [],
    cc: [],
    bcc: [],
    subject: "Other account",
    bodyText: "private",
    attachments: [],
  });
  const { tools } = createHarness({ mailDatabase: mailDatabase as unknown as WemailAgentToolDeps["mailDatabase"] });

  // The wired mailDatabase resolves drafts per account, so the handler's
  // ownership guard never sees the foreign draft; the underlying
  // MailDatabaseWriter refuses the overwrite with draft-account-mismatch.
  await assert.rejects(
    byName(tools, "save_mail_draft").handler({
      accountId: "acct-1",
      draftId: "draft-shared",
      subject: "Overwrite attempt",
      bodyText: "changed",
    }, {}),
    /draft-account-mismatch/,
  );
  assert.equal(drafts.get("draft-shared")?.subject, "Other account");
});

test("saved draft can be proposed for an exact future scheduled send", async () => {
  const { mailDatabase } = createDraftMailStub();
  await mailDatabase.saveDraft({
    id: "draft-scheduled",
    accountId: "acct-1",
    type: "new",
    to: [{ email: "eddiewang@example.com" }],
    cc: [],
    bcc: [],
    subject: "明天上午10点会议",
    bodyText: "提醒：明天上午10点开会。",
    bodyHtml: "<p>提醒：明天上午10点开会。</p>",
    attachments: [],
  });
  const { proposed, tools } = createHarness({
    mailDatabase: mailDatabase as unknown as WemailAgentToolDeps["mailDatabase"],
  });

  const result = (await byName(tools, "propose_schedule_mail").handler(
    {
      accountId: "acct-1",
      draftId: "draft-scheduled",
      sendAt: "2099-08-01T13:00:00+08:00",
    },
    {},
  )) as { ok: boolean; pendingAction?: { actionType: string } };

  assert.equal(result.ok, true);
  assert.equal(result.pendingAction?.actionType, "schedule_send");
  assert.equal(proposed.length, 1);
  assert.deepEqual(JSON.parse(proposed[0]!.inputJson), {
    accountId: "acct-1",
    sendAt: "2099-08-01T05:00:00.000Z",
    draft: {
      accountId: "acct-1",
      to: [{ email: "eddiewang@example.com" }],
      cc: [],
      bcc: [],
      subject: "明天上午10点会议",
      bodyText: "提醒：明天上午10点开会。",
      bodyHtml: "<p>提醒：明天上午10点开会。</p>",
      attachments: [],
    },
  });
});

test("automation preview and proposal use central temporal validation", async () => {
  const { proposed, tools } = createHarness();
  const preview = byName(tools, "preview_automation_rule");
  const proposal = byName(tools, "propose_automation_rule_change");
  // P2.6: the invoice.issueDate field (and the structured wecli allowance
  // upload step) is an edition module contribution. The open edition gates
  // invoice expressions at validation (unknown field), so the mechanism
  // cases run against the native received-time field; the module-aware
  // coverage runs in the edition overlay's suite.
  const cases = [
    {
      name: "legacy delay",
      execution: delay,
      ok: true,
    },
    {
      name: "received time plus duration",
      execution: {
        type: "atExpression",
        timezone: "Asia/Shanghai",
        expression: latestInvoicePlus24Hours,
      },
      ok: false,
      error: "temporal-expression-unknown-field",
    },
    {
      name: "unreduced invoice collection",
      execution: {
        type: "atExpression",
        timezone: "Asia/Shanghai",
        expression: unreducedInvoicePlus24Hours,
      },
      ok: false,
      error: "temporal-expression-unknown-field",
    },
    {
      name: "unknown field",
      execution: {
        type: "atExpression",
        timezone: "Asia/Shanghai",
        expression: unknownField,
      },
      ok: false,
      error: "temporal-expression-unknown-field",
    },
  ] as const;

  for (const item of cases) {
    const input = ruleInput(item.execution);
    const expectedError = "error" in item ? item.error : undefined;
    const previewResult = await preview.handler(input, {
      sessionId: "session-1",
      runContext: { accountId: "acct-1" },
    }) as { ok: boolean; error?: string };
    assert.equal(previewResult.ok, item.ok, `${item.name} preview`);
    assert.equal(previewResult.error, expectedError, `${item.name} preview error`);

    const proposalResult = await proposal.handler(
      { operation: "create", ...input },
      {
        sessionId: "session-1",
        runContext: { accountId: "acct-1" },
      },
    ) as {
      ok: boolean;
      error?: string;
      pendingAction?: { description: string; inputJson: string };
    };
    assert.equal(proposalResult.ok, item.ok, `${item.name} proposal`);
    assert.equal(proposalResult.error, expectedError, `${item.name} proposal error`);
  }

  assert.ok(
    !proposed.some((item) =>
      item.description.includes("最晚发票开票日期后 24 小时"),
    ),
    "open edition never describes an invoice temporal proposal",
  );
});

test("automation tool schema serializes recursive temporal expression guidance accepted by PI", () => {
  const { tools } = createHarness();
  const tool = byName(tools, "preview_automation_rule");
  const serialized = JSON.stringify(tool.inputSchema);
  // P2.6: the invoice.issueDate enum entry (and its label) is contributed by
  // the edition module; the open schema enumerates only native fields.
  assert.doesNotMatch(serialized, /invoice\.issueDate/);
  assert.match(serialized, /mail\.receivedAt/);
  assert.match(serialized, /atExpression/);
  assert.match(serialized, /"field"/);
  assert.match(serialized, /"aggregate"/);
  assert.match(serialized, /"coalesce"/);
  assert.match(serialized, /"addDuration"/);
  assert.match(serialized, /收到邮件的时间/);

  assert.doesNotThrow(() => validateWithPi(tool, ruleInput({
    type: "atExpression",
    timezone: "Asia/Shanghai",
    expression: {
      type: "addDuration",
      base: { type: "field", path: "mail.receivedAt", scope: "mail" },
      duration: { amount: 24, unit: "hour" },
    },
  })));
});

test("temporal expression descriptions use deterministic catalog labels", () => {
  assert.equal(
    describeTemporalExpression({
      type: "field",
      path: "mail.receivedAt",
      scope: "mail",
    }),
    "收到邮件的时间",
  );
  // P2.6: invoice.issueDate leaves the open catalog with the module; the
  // description degrades deterministically to the raw path.
  assert.equal(
    describeTemporalExpression({
      type: "aggregate",
      operator: "min",
      values: {
        type: "field",
        path: "invoice.issueDate",
        scope: "matchingAttachments",
      },
    }),
    "最早invoice.issueDate",
  );
});

test("proposal schema discriminates create, update, and ruleId-only operations in PI", () => {
  const { tools } = createHarness();
  const tool = byName(tools, "propose_automation_rule_change");
  const fullRule = ruleInput(delay);

  assert.doesNotThrow(() => validateWithPi(tool, {
    operation: "create",
    ...fullRule,
  }));
  assert.doesNotThrow(() => validateWithPi(tool, {
    operation: "update",
    ruleId: "rule-1",
    ...fullRule,
  }));
  for (const operation of ["enable", "disable", "delete"]) {
    assert.doesNotThrow(() => validateWithPi(tool, {
      operation,
      ruleId: "rule-1",
    }));
  }

  for (const invalid of [
    { operation: "create", name: "missing trigger and actions" },
    { operation: "update", ...fullRule },
    { operation: "enable" },
    { operation: "disable", ...fullRule },
    { operation: "delete", name: "irrelevant full rule" },
  ]) {
    assert.throws(() => validateWithPi(tool, invalid));
  }
});

test("proposal handler returns stable central validation errors for malformed drafts", async () => {
  const { tools } = createHarness();
  const proposal = byName(tools, "propose_automation_rule_change");
  const ctx = {
    sessionId: "session-1",
    runContext: { accountId: "acct-1" },
  };
  const cases = [
    {
      input: { operation: "create", name: "missing trigger", actions: [{ type: "archive" }] },
      error: "automation-rule-trigger-required",
    },
    {
      input: { operation: "create", name: "missing actions", trigger: { type: "manual" } },
      error: "automation-rule-actions-required",
    },
    {
      input: {
        operation: "create",
        name: "unknown execution",
        trigger: {
          type: "mailReceived",
          execution: { type: "afterBusinessDays", amount: 1 },
        },
        naturalLanguageCondition: "invoice",
        actions: [{ type: "archive" }],
      },
      error: "invalid-mail-received-execution",
    },
    {
      input: {
        operation: "create",
        name: "unknown trigger",
        trigger: { type: "mailDeleted" },
        actions: [{ type: "archive" }],
      },
      error: "automation-rule-trigger-required",
    },
    {
      input: {
        operation: "create",
        name: "malformed external input",
        trigger: { type: "manual" },
        actions: [{ type: "external", adapter: "wecli.operation", input: null }],
      },
      error: "invalid-automation-action",
    },
  ];

  for (const item of cases) {
    const result = await proposal.handler(item.input, ctx) as {
      ok: boolean;
      error?: string;
    };
    assert.deepEqual(result, { ok: false, error: item.error });
  }
});

test("temporal descriptions flatten associative coalesces without mutating the AST", () => {
  const received = {
    type: "field",
    path: "mail.receivedAt",
    scope: "mail",
  } as const satisfies TemporalExpression;
  const earliestInvoice = {
    type: "aggregate",
    operator: "min",
    values: {
      type: "field",
      path: "invoice.issueDate",
      scope: "matchingAttachments",
    },
  } as const satisfies TemporalExpression;
  const latestInvoice = {
    type: "aggregate",
    operator: "max",
    values: {
      type: "field",
      path: "invoice.issueDate",
      scope: "matchingAttachments",
    },
  } as const satisfies TemporalExpression;
  const leftNested = {
    type: "coalesce",
    values: [
      { type: "coalesce", values: [received, earliestInvoice] },
      latestInvoice,
    ],
  } as const satisfies TemporalExpression;
  const rightNested = {
    type: "coalesce",
    values: [
      received,
      { type: "coalesce", values: [earliestInvoice, latestInvoice] },
    ],
  } as const satisfies TemporalExpression;
  const flat = {
    type: "coalesce",
    values: [received, earliestInvoice, latestInvoice],
  } as const satisfies TemporalExpression;
  const expected =
    "优先使用收到邮件的时间，取不到时使用最早invoice.issueDate，仍取不到时使用最晚invoice.issueDate";

  for (const expression of [leftNested, rightNested, flat]) {
    const before = structuredClone(expression);
    assert.equal(describeTemporalExpression(expression), expected);
    assert.deepEqual(expression, before);
  }
  assert.equal(
    describeTemporalExpression({
      type: "addDuration",
      base: rightNested,
      duration: { amount: 24, unit: "hour" },
    }),
    `${expected}后 24 小时`,
  );
});

test("list_recent_emails anchors the rolling window to the focused email's send time", async () => {
  let searchInput: Record<string, unknown> | undefined;
  const focusedEmail = {
    id: "mail-focus",
    subject: "Weekly ops report",
    receivedAt: "2026-08-01T08:00:00.000Z",
    from: { name: "Ops Bot", email: "ops@example.com" },
  };
  const pool = [
    focusedEmail,
    {
      id: "mail-sibling",
      subject: "Weekly ops report",
      receivedAt: "2026-08-01T06:00:00.000Z",
      from: { name: "Ops Bot", email: "ops@example.com" },
    },
    {
      id: "mail-too-old",
      subject: "Weekly ops report",
      receivedAt: "2026-07-30T08:00:00.000Z",
      from: { name: "Ops Bot", email: "ops@example.com" },
    },
    {
      id: "mail-after",
      subject: "Weekly ops report",
      receivedAt: "2026-08-03T10:00:00.000Z",
      from: { name: "Ops Bot", email: "ops@example.com" },
    },
  ];
  const { tools } = createHarness({
    mailDatabase: {
      async getMailSnapshot(id: string) {
        const message = pool.find(
          (m) => m.id === id || id.endsWith(`:${m.id}`),
        );
        return { message: message ?? null };
      },
      async search(input: Record<string, unknown>) {
        searchInput = input;
        return { messages: pool };
      },
    } as unknown as WemailAgentToolDeps["mailDatabase"],
  });
  const tool = byName(tools, "list_recent_emails");
  const result = await tool.handler(
    { from: "Ops", subject: "Weekly" },
    {
      sessionId: "conversation-insight-1",
      runContext: {
        runId: "run-insight-1",
        accountId: "acct-1",
        emailId: "mail-focus",
        sceneAction: {
          kind: "insight-report",
          operation: "aggregate",
          lookbackPreset: "24h",
        },
      },
    },
  ) as {
    ok: boolean;
    windowDays: number;
    windowPreset: string;
    windowAnchor?: string;
    windowStart?: string;
    windowEnd?: string;
    emails: Array<{ id: string }>;
  };

  assert.equal(result.ok, true);
  assert.equal(result.windowDays, 1);
  assert.equal(result.windowPreset, "24h");
  // The window ends at the focused email's send time, not the wall clock
  // (2026-08-01 vs 2026-08-09), and covers the preceding 24 hours.
  assert.equal(result.windowAnchor, "focused-email");
  assert.equal(result.windowEnd, "2026-08-01T08:00:00.000Z");
  assert.equal(result.windowStart, "2026-07-31T08:00:00.000Z");
  assert.deepEqual(searchInput, {
    accountId: "acct-1",
    from: "Ops",
    subject: "Weekly",
    receivedFromMs: Date.parse("2026-07-31T08:00:00.000Z"),
    receivedToMs: Date.parse("2026-08-01T08:00:00.000Z"),
    limit: 100,
  });
  const ids = result.emails.map((email) => email.id).sort();
  assert.deepEqual(ids, ["mail-focus", "mail-sibling"].sort());
});

test("list_recent_emails falls back to a now-anchored window without a focused email", async () => {
  const { tools } = createHarness({
    mailDatabase: {
      async getMailSnapshot() {
        return { message: null };
      },
      async search() {
        return { messages: [] };
      },
    } as unknown as WemailAgentToolDeps["mailDatabase"],
  });
  const tool = byName(tools, "list_recent_emails");
  const result = await tool.handler(
    { from: "Ops", subject: "Weekly", days: 1 },
    {
      sessionId: "conversation-plain-1",
      runContext: { accountId: "acct-1" },
    },
  ) as {
    ok: boolean;
    windowDays: number;
    windowAnchor?: string;
  };

  assert.equal(result.ok, true);
  assert.equal(result.windowDays, 1);
  assert.equal(result.windowAnchor, undefined);
});
