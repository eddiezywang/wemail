import assert from "node:assert/strict";
import test from "node:test";
import { openOrCreateMailDatabase } from "../database/Database.js";
import { AgentPendingActionRepository, rowToAction } from "./AgentPendingActionRepository.js";
import { publicActionExecution } from "./AgentActionExecutor.js";
import { ensureActionExecutionSchema } from "./ActionExecutionSchema.js";

function setup() {
  const db = openOrCreateMailDatabase(":memory:");
  const pending = new AgentPendingActionRepository({
    db,
    now: () => "2026-07-30T12:00:00.000Z",
  });
  return { db, pending };
}

function insert(pending: AgentPendingActionRepository, id: string): string {
  pending.insert({
    id,
    accountId: "account-1",
    actionType: "permanent_delete",
    description: "永久删除邮件",
    inputJson: "{}",
    riskReason: "不可恢复",
    parameters: {},
  });
  const row = pending.getById(id);
  return row?.idempotency_key ?? `legacy:${id}`;
}

test("legacy action results do not expose command output through the public projection", () => {
  const { db, pending } = setup();
  try {
    insert(pending, "legacy-result");
    pending.completeExecution("legacy-result", "failed", { ok: false, summary: "未完成", items: [
      { ok: false, command: "secret command", stderr: "private mail", error: "secret key" },
    ] });
    const result = rowToAction(pending.getById("legacy-result")!).executionResult;
    assert.doesNotMatch(JSON.stringify(result), /secret command|private mail|secret key/);
  } finally { db.close(); }
});

test("legacy errors without a summary are not returned verbatim", () => {
  const { db, pending } = setup();
  try {
    insert(pending, "legacy-error");
    pending.completeExecution("legacy-error", "failed", { ok: false, error: "secret key" });
    const result = rowToAction(pending.getById("legacy-error")!).executionResult;
    assert.deepEqual(result, { ok: false, error: "操作未完成，请检查操作状态。" });
  } finally { db.close(); }
});

test("sanitized failed submission retains the legacy duplicate guard", () => {
  const { db, pending } = setup();
  try {
    pending.insert({ id: "legacy-upload", accountId: "account-1", actionType: "upload_allowance_invoices",
      description: "上传", inputJson: JSON.stringify({ items: [{ emailId: "mail-1", attachmentId: "att-1" }] }), riskReason: "上传" });
    const result = publicActionExecution({ ok: false, summary: "未完成", items: [{ ok: false, command: "sensitive-command" }] });
    pending.completeExecution("legacy-upload", "failed", { ...result });
    ensureActionExecutionSchema(db);
    const row = db.prepare("SELECT account_id FROM agent_action_legacy_submissions WHERE email_id=? AND attachment_id=?")
      .get("mail-1", "att-1") as { account_id: string } | undefined;
    assert.equal(row?.account_id, "account-1");
    assert.doesNotMatch(JSON.stringify(result), /sensitive-command/);
  } finally { db.close(); }
});

test("completeExecution('failed') records a terminal failed execution", () => {
  const { pending } = setup();
  const idempotencyKey = insert(pending, "pa-fail");
  pending.reserveExecution({ id: "pa-fail", idempotencyKey, parameters: {} });
  pending.completeExecution("pa-fail", "failed", { ok: false, error: "boom" });

  const row = pending.getById("pa-fail");
  assert.equal(row?.status, "confirmed");
  assert.equal(row?.execution_state, "failed");
  assert.equal(row?.resolved_at, "2026-07-30T12:00:00.000Z");
});

test("a failed execution cannot reuse the same confirmation", () => {
  const { pending } = setup();
  const idempotencyKey = insert(pending, "pa-retry");

  const first = pending.reserveExecution({ id: "pa-retry", idempotencyKey, parameters: {} });
  assert.equal(first.kind, "reserved");
  assert.equal(pending.getById("pa-retry")?.execution_state, "executing");

  pending.completeExecution("pa-retry", "failed", { ok: false, error: "boom" });
  assert.equal(pending.getById("pa-retry")?.status, "confirmed");
  assert.equal(pending.getById("pa-retry")?.execution_state, "failed");

  const second = pending.reserveExecution({ id: "pa-retry", idempotencyKey, parameters: {} });
  assert.equal(second.kind, "duplicate");
});

test("terminal and in-flight rows are not re-reservable", () => {
  const { pending } = setup();

  // succeeded → status confirmed → duplicate
  const keySucceeded = insert(pending, "pa-succeeded");
  pending.reserveExecution({ id: "pa-succeeded", idempotencyKey: keySucceeded, parameters: {} });
  pending.completeExecution("pa-succeeded", "succeeded", { ok: true });
  assert.equal(
    pending.reserveExecution({ id: "pa-succeeded", idempotencyKey: keySucceeded, parameters: {} }).kind,
    "duplicate",
  );

  // outcome_unknown → status confirmed → duplicate
  const keyUnknown = insert(pending, "pa-unknown");
  pending.reserveExecution({ id: "pa-unknown", idempotencyKey: keyUnknown, parameters: {} });
  pending.completeExecution("pa-unknown", "outcome_unknown", { ok: false });
  assert.equal(
    pending.reserveExecution({ id: "pa-unknown", idempotencyKey: keyUnknown, parameters: {} }).kind,
    "duplicate",
  );

  // in-flight (executing, still pending) → duplicate, guarding concurrent double-run
  const keyExecuting = insert(pending, "pa-executing");
  pending.reserveExecution({ id: "pa-executing", idempotencyKey: keyExecuting, parameters: {} });
  assert.equal(pending.getById("pa-executing")?.execution_state, "executing");
  assert.equal(pending.getById("pa-executing")?.status, "pending");
  assert.equal(
    pending.reserveExecution({ id: "pa-executing", idempotencyKey: keyExecuting, parameters: {} }).kind,
    "duplicate",
  );
});

test("pending action polling needs no write lock when nothing is stale", () => {
  const { db, pending } = setup();
  try {
    insert(pending, "pa-current");
    db.pragma("query_only = ON");
    assert.doesNotThrow(() => pending.getPendingByAccount("account-1"));
    assert.equal(pending.getById("pa-current")?.status, "pending");
  } finally {
    db.close();
  }
});

test("polling excludes stale confirmations and derives history without acquiring a write lock", () => {
  const { db, pending } = setup();
  try {
    insert(pending, "expired");
    insert(pending, "failed");
    db.prepare("UPDATE agent_pending_actions SET expires_at = '2026-07-29T00:00:00.000Z' WHERE id = 'expired'").run();
    db.prepare("UPDATE agent_pending_actions SET execution_state = 'failed' WHERE id = 'failed'").run();
    db.exec(`INSERT INTO agent_conversations (id, account_id, created_at, updated_at)
      VALUES ('history', 'account-1', '2026-07-30', '2026-07-30');
      UPDATE agent_pending_actions SET conversation_id = 'history';`);
    db.pragma("query_only = ON");
    assert.deepEqual(pending.getPending(), []);
    assert.deepEqual(pending.getPendingByAccount("account-1"), []);
    const history = pending.getConversationHistory("history");
    assert.equal(history.find((row) => row.id === "expired")?.status, "expired");
    assert.equal(history.find((row) => row.id === "failed")?.status, "confirmed");
    assert.equal(pending.getById("expired")?.status, "pending");
  } finally { db.close(); }
});

test("expireStale repairs legacy failed rows before applying expiry", () => {
  const { db, pending } = setup();
  insert(pending, "pa-legacy-failed");
  db.prepare(
    `UPDATE agent_pending_actions
        SET execution_state = 'failed', execution_completed_at = '2026-07-30T11:59:00.000Z'
      WHERE id = 'pa-legacy-failed'`,
  ).run();

  pending.expireStale();

  const row = pending.getById("pa-legacy-failed");
  assert.equal(row?.status, "confirmed");
  assert.equal(row?.resolved_at, "2026-07-30T11:59:00.000Z");
});

test("expireStale lets a recorded failure override legacy expiry", () => {
  const { db, pending } = setup();
  insert(pending, "pa-expired-failed");
  db.prepare(
    `UPDATE agent_pending_actions
        SET status = 'expired', execution_state = 'failed',
            execution_completed_at = '2026-07-30T11:58:00.000Z'
      WHERE id = 'pa-expired-failed'`,
  ).run();

  pending.expireStale();

  assert.equal(pending.getById("pa-expired-failed")?.status, "confirmed");
});
