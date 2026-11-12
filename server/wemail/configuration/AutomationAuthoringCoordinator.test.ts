import { insertCanonicalTestAccount } from "../database/MailDatabase.test-support.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { ExecutionPipelineDraft } from "../../../shared/wemail/skillCenter.js";
import { openOrCreateMailDatabase } from "../database/Database.js";
import { ExecutionPipelineDraftRepository } from "../workflows/ExecutionPipelineDraftRepository.js";
import { PipelineReviewService } from "../workflows/PipelineReviewService.js";
import {
  AutomationAuthoringCoordinator,
  classifyFinalAuthorization,
} from "./AutomationAuthoringCoordinator.js";
import { ConfigurationTaskRepository } from "./ConfigurationTaskRepository.js";
import { ConfigurationWorkflowService } from "./ConfigurationWorkflowService.js";

const NOW = "2026-07-29T12:00:00.000Z";

function harness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-authoring-"));
  const db = openOrCreateMailDatabase(path.join(root, "wemail.sqlite"));
  insertCanonicalTestAccount(db, { id: "account-1", email: "owner@example.test", displayName: "Owner" });
  const taskRepository = new ConfigurationTaskRepository(db);
  const workflow = new ConfigurationWorkflowService(
    taskRepository,
    undefined,
    () => NOW,
  );
  const drafts = new ExecutionPipelineDraftRepository(db);
  const pipeline = {
    async validate() {
      return { status: "valid" as const, issues: [], validatedAt: NOW };
    },
    async compile() {
      return {
        pipeline: [],
        trigger: {
          type: "scheduled" as const,
          schedule: {
            type: "daily" as const,
            localTime: "21:00",
            timezone: "Asia/Shanghai",
          },
        },
        hash: "rule-hash-1",
      };
    },
  };
  const catalog = {
    async list() {
      return [{
        id: "delivery.bot.sendConnected",
        category: "delivery" as const,
        name: "发送到 Bot",
        description: "发送",
        inputSchema: {},
        outputSchema: {},
        inputKinds: ["artifact-reference" as const],
        outputKinds: ["delivery-receipt" as const],
        availability: { state: "ready" as const },
        risk: "external_side_effect" as const,
        previewSupport: "full" as const,
        idempotency: "keyed" as const,
        version: "1",
        fingerprint: "bot-fingerprint",
      }];
    },
  };
  const coordinator = new AutomationAuthoringCoordinator(
    workflow,
    drafts,
    pipeline as never,
    catalog as never,
    () => NOW,
  );
  return { root, db, workflow, drafts, coordinator };
}

function readyDraft(): ExecutionPipelineDraft {
  const base: ExecutionPipelineDraft = {
    id: "pipeline-1",
    accountId: "account-1",
    accountScope: {
      type: "selectedAccounts",
      accountIds: ["account-1", "account-2"],
    },
    revision: 1,
    mode: "automation",
    trigger: {
      event: "schedule",
      timing: { localTime: "21:00", timezone: "Asia/Shanghai" },
    },
    artifact: {
      version: 1,
      format: "html",
      title: "当日监控日报",
      components: [{ id: "trend", type: "line_chart" }],
      layout: { structure: "report", sections: ["trend"] },
      theme: { name: "wemail" },
      accessibility: { includeTextSummary: true, chartDescriptions: true },
      emptyState: "暂无数据",
      errorState: "生成失败",
      outputSchema: {},
    },
    delivery: {
      version: 1,
      destinations: [{ type: "connected_bot", enabled: true }],
      content: {
        includeSummary: true,
        includeImage: false,
        includeArtifactLink: true,
      },
      fallbackPolicy: {
        type: "first_available",
        priority: ["feishu_bot", "wecom_bot"],
      },
    },
    steps: [{
      id: "send",
      capabilityId: "delivery.bot.sendConnected",
      input: {},
      outputKind: "delivery-receipt",
      onError: { policy: "continue", retries: 2 },
    }],
    skillSnapshots: [{
      skillId: "wemail-automation-authoring",
      version: "1.0.0",
      contentHash: "skill-hash",
      scope: "builtin",
    }],
    capabilitySnapshots: [{
      capabilityId: "delivery.bot.sendConnected",
      version: "1",
      fingerprint: "bot-fingerprint",
      availabilityAtPreview: "ready",
      risk: "external_side_effect",
    }],
    reviews: [],
    validation: { status: "valid", issues: [], validatedAt: NOW },
    createdAt: NOW,
    updatedAt: NOW,
  };
  const reviews = new PipelineReviewService(() => NOW);
  let current = reviews.synchronizeCheckpoints(base, {
    artifact: { previewId: "preview-1", previewUrl: "/preview/1" },
  });
  for (const target of ["artifact", "delivery"] as const) {
    const checkpoint = current.reviews.filter((item) => item.target === target).at(-1)!;
    if (target === "delivery" && !checkpoint.previewId) {
      checkpoint.previewId = "delivery-preview-1";
      checkpoint.previewUrl = "/preview/delivery-1";
    }
    current = reviews.respond(current, checkpoint.id, "接受").draft;
  }
  return { ...current, revision: 1 };
}

test("durable automation requires a separate exact final confirmation and verifies commit", async () => {
  const { root, db, workflow, drafts, coordinator } = harness();
  try {
    const persisted = drafts.create(readyDraft());
    let task = workflow.start({
      accountId: "account-1",
      sessionId: "session-1",
      kind: "automation_rule",
      targetKey: "daily-monitoring",
      operation: "create",
      title: "每天 21 点生成监控日报",
      source: { surface: "agent" },
    });
    task = await coordinator.prepareFinalConfirmation(task, persisted);
    assert.equal(task.status, "awaiting_final_confirmation");
    assert.equal(task.effects.length, 0);
    assert.ok(task.confirmationSnapshot?.configuration?.artifact);
    assert.deepEqual(
      task.confirmationSnapshot?.configuration?.authorizationBounds
        ?.resolvedAccounts,
      ["account-1", "account-2"],
    );
    assert.match(
      task.interaction?.message ?? "",
      /邮箱范围 account-1、account-2/,
    );

    await assert.rejects(
      () =>
        coordinator.authorizeFinal({
          task,
          message: "图表可以",
          snapshotId: task.confirmationSnapshot!.id,
          ruleHash: task.confirmationSnapshot!.ruleHash,
        }),
      /ambiguous/,
    );
    task = await coordinator.authorizeFinal({
      task,
      message: "确认创建",
      snapshotId: task.confirmationSnapshot!.id,
      ruleHash: task.confirmationSnapshot!.ruleHash,
    });
    assert.equal(task.status, "committing");

    task = await coordinator.commitAndVerify({
      task,
      adapter: {
        async commit() {
          return {
            resourceId: "rule-1",
            version: 1,
            hash: "rule-hash-1",
            value: { id: "rule-1", enabled: true },
          };
        },
        async reload() {
          return { id: "rule-1", enabled: true };
        },
        async verify({ actual }) {
          return { valid: actual.enabled };
        },
      },
    });
    assert.equal(task.status, "completed");
    assert.equal(task.effects[0]?.state, "committed");
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("intent and final authorization classifiers do not conflate preview acceptance with creation", () => {
  const { root, db, coordinator } = harness();
  try {
    assert.equal(
      coordinator.routeIntent("把今天这些邮件整理成图片发给我"),
      "one_shot",
    );
    assert.equal(
      coordinator.routeIntent("每天晚上九点整理后发到企业微信"),
      "automation",
    );
    assert.equal(classifyFinalAuthorization("符合"), "ambiguous");
    assert.equal(classifyFinalAuthorization("确认创建并启用"), "confirm");
    assert.equal(classifyFinalAuthorization("先不要"), "decline");
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("final authorization cancels cleanly and rejects a draft changed after snapshot", async () => {
  const { root, db, workflow, drafts, coordinator } = harness();
  try {
    const persisted = drafts.create(readyDraft());
    let task = workflow.start({
      accountId: "account-1",
      sessionId: "session-1",
      kind: "automation_rule",
      targetKey: "daily-monitoring-stale",
      operation: "create",
      title: "每天 21 点生成监控日报",
      source: { surface: "agent" },
    });
    task = await coordinator.prepareFinalConfirmation(task, persisted);
    drafts.replace(
      {
        ...persisted,
        revision: persisted.revision + 1,
        updatedAt: "2026-07-29T12:01:00.000Z",
      },
      persisted.revision,
    );
    await assert.rejects(
      () =>
        coordinator.authorizeFinal({
          task,
          message: "确认创建并启用",
          snapshotId: task.confirmationSnapshot!.id,
          ruleHash: task.confirmationSnapshot!.ruleHash,
        }),
      /stale/,
    );
    const cancelled = await coordinator.authorizeFinal({
      task,
      message: "先不要",
      snapshotId: task.confirmationSnapshot!.id,
      ruleHash: task.confirmationSnapshot!.ruleHash,
    });
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.effects.length, 0);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
