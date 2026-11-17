import { insertCanonicalTestAccount } from "../database/MailDatabase.test-support.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { openOrCreateMailDatabase } from "../database/Database.js";
import { ConfigurationTaskReconciler } from "./ConfigurationTaskReconciler.js";
import { ConfigurationTaskRepository } from "./ConfigurationTaskRepository.js";
import { ConfigurationWorkflowService } from "./ConfigurationWorkflowService.js";

test("startup reconciliation deduplicates diagnostics and supersedes stale active authoring", () => {
  const db = openOrCreateMailDatabase(":memory:");
  const oldNow = () => "2026-07-29T10:00:00.000Z";
  try {
    insertCanonicalTestAccount(db, { id: "account-1", email: "owner@example.test", displayName: "Owner" });
    const repository = new ConfigurationTaskRepository(db);
    const workflow = new ConfigurationWorkflowService(
      repository,
      undefined,
      oldNow,
    );
    const active = workflow.start({
      accountId: "account-1",
      kind: "automation_rule",
      targetKey: "daily-monitoring",
      operation: "create",
      title: "旧日报配置",
      source: { surface: "agent" },
    });
    const issue = {
      id: "issue-1",
      category: "dependency_unavailable" as const,
      code: "bot-not-connected",
      phase: "discover_capabilities" as const,
      severity: "blocking" as const,
      userMessage: "Bot 未连接",
      responsibility: "user_action" as const,
      retryability: "safe_after_recovery" as const,
      privacyClass: "public" as const,
      affectedScope: ["delivery:bot"],
      createdAt: oldNow(),
    };
    repository.replace(
      {
        ...active,
        status: "blocked",
        issues: [issue, { ...issue, id: "issue-duplicate" }],
        recoveries: [
          {
            id: "recovery-1",
            issueId: issue.id,
            type: "open_settings",
            label: "连接 Bot",
            requiresConfirmation: false,
            dangerous: false,
          },
          {
            id: "recovery-duplicate",
            issueId: "issue-duplicate",
            type: "open_settings",
            label: "连接 Bot",
            requiresConfirmation: false,
            dangerous: false,
          },
        ],
        revision: 2,
        updatedAt: oldNow(),
      },
      1,
    );
    repository.create({
      ...active,
      id: "configuration-task-newer",
      operation: "update",
      title: "新日报配置",
      status: "completed",
      currentPhase: "verify_configuration",
      steps: active.steps.map((step) =>
        step.phase === "verify_configuration"
          ? { ...step, status: "completed", completedAt: "2026-07-29T11:00:00.000Z" }
          : { ...step, status: "skipped" },
      ),
      issues: [],
      recoveries: [],
      references: [{
        type: "committed_resource",
        id: "rule-new",
        version: 2,
        hash: "rule-hash-new",
      }],
      revision: 1,
      createdAt: "2026-07-29T11:00:00.000Z",
      updatedAt: "2026-07-29T11:00:00.000Z",
    });

    const result = new ConfigurationTaskReconciler(
      repository,
      () => "2026-07-29T12:00:00.000Z",
    ).reconcile("account-1");
    assert.deepEqual(result, { normalized: 1, superseded: 1 });
    const reconciled = repository.get(active.id, "account-1")!;
    assert.equal(reconciled.status, "cancelled");
    assert.equal(reconciled.issues.length, 1);
    assert.equal(reconciled.recoveries.length, 1);
    assert.match(reconciled.interaction?.message ?? "", /新日报配置/);
  } finally {
    db.close();
  }
});
