import assert from "node:assert/strict";
import { test } from "node:test";
import { createMailDatabase } from "../database/Database.js";
import { insertCanonicalTestAccount } from "../database/MailDatabase.test-support.js";
import { ConfigurationFailureAdapter } from "./ConfigurationFailureAdapter.js";
import { ConfigurationIssueCatalog } from "./ConfigurationIssueCatalog.js";
import { ConfigurationOutcomeProjector } from "./ConfigurationOutcomeProjector.js";
import {
  ConfigurationTaskConflictError,
  ConfigurationTaskRepository,
} from "./ConfigurationTaskRepository.js";
import {
  ConfigurationWorkflowService,
  isSafeAutomaticConfigurationRetry,
} from "./ConfigurationWorkflowService.js";

const NOW = "2026-07-29T12:00:00.000Z";

function harness() {
  const db = createMailDatabase(":memory:", { safeIntegers: false });
  insertCanonicalTestAccount(db, {
    id: "account-1",
    email: "operator@example.test",
    displayName: "Operator",
    nowMs: Date.parse(NOW),
  });
  const repository = new ConfigurationTaskRepository(db);
  const workflow = new ConfigurationWorkflowService(
    repository,
    undefined,
    () => NOW,
  );
  return { db, repository, workflow };
}

function start(workflow: ConfigurationWorkflowService) {
  return workflow.start({
    accountId: "account-1",
    sessionId: "conversation-1",
    kind: "automation_rule",
    targetKey: "daily-monitoring-report",
    operation: "create",
    title: "每天21点生成监控报告",
    source: { surface: "agent", sourceId: "conversation-1" },
  });
}

test("configuration task persists, deduplicates, and reloads after restart", () => {
  const { db, repository, workflow } = harness();
  const created = start(workflow);
  const duplicate = start(workflow);
  assert.equal(duplicate.id, created.id);
  assert.equal(repository.list("account-1").length, 1);

  const restartedRepository = new ConfigurationTaskRepository(db);
  const reloaded = restartedRepository.get(created.id, "account-1");
  assert.equal(reloaded?.title, "每天21点生成监控报告");
  assert.equal(reloaded?.currentPhase, "check_prerequisites");
  assert.equal(
    reloaded?.steps.find((step) => step.phase === "check_prerequisites")
      ?.status,
    "running",
  );
});

test("optimistic revision rejects a stale writer", () => {
  const { repository, workflow } = harness();
  const created = start(workflow);
  const next = workflow.completePhase({
    taskId: created.id,
    accountId: created.accountId,
    expectedRevision: created.revision,
    phase: "check_prerequisites",
  });
  assert.throws(
    () => repository.replace({ ...next, revision: 2 }, 1),
    ConfigurationTaskConflictError,
  );
});

test("blocked phase skips downstream work and recovery resumes from prerequisite", async () => {
  const { workflow } = harness();
  const created = start(workflow);
  const adapter = new ConfigurationFailureAdapter();
  const unavailable = adapter.unavailable({
    code: "wecli_binary_missing",
    phase: "check_prerequisites",
    provider: "wecli",
    affectedScope: ["自动化规则的企业命令"],
    unaffectedScope: ["邮件阅读", "其他自动化能力"],
  });
  const { task } = await workflow.runPhase({
    taskId: created.id,
    accountId: created.accountId,
    expectedRevision: created.revision,
    phase: "check_prerequisites",
    hooks: { run: async () => unavailable },
  });
  assert.equal(task.status, "blocked");
  assert.equal(task.issues[0]?.category, "dependency_unavailable");
  assert.equal(
    task.steps.find((step) => step.phase === "discover_capabilities")?.status,
    "skipped",
  );
  const install = task.recoveries.find(
    (recovery) => recovery.type === "install_dependency",
  );
  assert.ok(install);

  const resumed = workflow.resume({
    taskId: task.id,
    accountId: task.accountId,
    expectedRevision: task.revision,
    recoveryActionId: install.id,
  });
  assert.equal(resumed.status, "checking_prerequisites");
  assert.equal(resumed.currentPhase, "check_prerequisites");
  assert.equal(
    resumed.steps.find((step) => step.phase === "discover_capabilities")
      ?.status,
    "pending",
  );
  assert.equal(resumed.authorization, undefined);
});

test("unknown effect is never an automatic retry and projects known impact", () => {
  const { workflow } = harness();
  const created = start(workflow);
  const issue = new ConfigurationIssueCatalog().create({
    code: "execution_outcome_unknown",
    phase: "commit_configuration",
  });
  const task = workflow.block({
    taskId: created.id,
    accountId: created.accountId,
    expectedRevision: created.revision,
    issue,
    effect: {
      id: "effect-1",
      phase: "commit_configuration",
      type: "external-mutation",
      state: "unknown",
      summary: "Bot连接提交结果",
      createdAt: NOW,
      updatedAt: NOW,
    },
  });
  assert.equal(task.status, "outcome_unknown");
  const outcome = new ConfigurationOutcomeProjector().project(task);
  assert.match(outcome.impact.join(" "), /结果待核查/);
  const result = {
    status: "failed" as const,
    issue,
    effectState: "unknown" as const,
  };
  assert.equal(isSafeAutomaticConfigurationRetry(result), false);
});

test("projector rejects LLM wording that contradicts canonical state", () => {
  const { workflow } = harness();
  const created = start(workflow);
  const issue = new ConfigurationIssueCatalog().create({
    code: "authentication_required",
    phase: "check_prerequisites",
  });
  const blocked = workflow.block({
    taskId: created.id,
    accountId: created.accountId,
    expectedRevision: created.revision,
    issue,
  });
  const projector = new ConfigurationOutcomeProjector();
  assert.doesNotMatch(
    projector.safeSummary(blocked, "配置成功，已经生效"),
    /配置成功/,
  );
  assert.match(projector.safeSummary(blocked), /重新认证|登录/);
});

test("repository sanitizes diagnostic paths and retention never deletes active tasks", () => {
  const { db, repository, workflow } = harness();
  const created = start(workflow);
  const issue = new ConfigurationIssueCatalog().create({
    code: "permission_denied",
    phase: "check_prerequisites",
    diagnostic: {
      command: "client --token secret C:\\Users\\alice\\Temp\\result.json",
    },
  });
  const blocked = workflow.block({
    taskId: created.id,
    accountId: created.accountId,
    expectedRevision: created.revision,
    issue,
  });
  const stored = db
    .prepare(
      "SELECT diagnostic_json FROM configuration_task_issues WHERE id = ?",
    )
    .get(issue.id) as { diagnostic_json: string };
  assert.doesNotMatch(stored.diagnostic_json, /secret|Users\\alice/);
  assert.equal(repository.cleanupExpired("2099-01-01T00:00:00.000Z"), 0);

  const cancelled = workflow.cancel({
    taskId: blocked.id,
    accountId: blocked.accountId,
    expectedRevision: blocked.revision,
  });
  assert.ok(cancelled.retentionUntil);
  assert.equal(repository.cleanupExpired("2099-01-01T00:00:00.000Z"), 1);
});
