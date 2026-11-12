import assert from "node:assert/strict";
import test from "node:test";
import { openOrCreateMailDatabase } from "../database/Database.js";
import { AgentPendingActionRepository } from "./AgentPendingActionRepository.js";
import { ActionExecutionRepository } from "./ActionExecutionRepository.js";
import type { ActionExecutionCommand, ActionExecutionSnapshot } from "../../../shared/wemail/actionExecution.js";

/**
 * P2.6 open-edition regression: the durable action-execution queue is
 * retained infrastructure (schema v19, `agent.writeActionExecution` DB lane)
 * and must keep working with NO edition module — receipt parsing and the
 * invoice status store resolve to their no-op open defaults, so dispatch
 * never crashes and the invoice table stays untouched. The full
 * accept → execute → status write-back chain (with the real module ports)
 * is exercised in the edition overlay (wemail-int internal/src/allowance).
 */

function fixture() {
  const db = openOrCreateMailDatabase(":memory:");
  let now = Date.parse("2026-11-03T00:00:00Z");
  const pending = new AgentPendingActionRepository({ db, now: () => new Date(now).toISOString() });
  const repository = new ActionExecutionRepository(db, () => now);
  const parameters = { items: [{ emailId: "mail-1", attachmentId: "att-1", filename: "invoice.pdf" }] };
  const propose = (id: string) => {
    pending.insert({ id, accountId: "account-1", actionType: "upload_allowance_invoices", description: "上传发票",
      inputJson: JSON.stringify(parameters), parameters, riskReason: "上传到平台" });
    return { op: "accept" as const, actionId: id, accountId: "account-1", parameters, idempotencyKey: pending.getById(id)!.idempotency_key! };
  };
  const dispatch = (command: ActionExecutionCommand) => repository.dispatch(command) as ActionExecutionSnapshot;
  return { db, pending, propose, dispatch, nowFn: () => now, advance: (ms: number) => { now += ms; } };
}

test("confirmation atomically queues once and survives expiry without an edition module", () => {
  const f = fixture();
  try {
    const input = f.propose("a");
    const task = f.dispatch(input);
    assert.equal(task.state, "queued");
    assert.equal(f.dispatch(input).id, task.id);
    f.advance(20 * 60_000);
    f.pending.expireStale();
    assert.equal(f.dispatch(input).id, task.id);
    const claimed = f.dispatch({ op: "claim", owner: "worker" });
    assert.equal(claimed.id, task.id);
  } finally { f.db.close(); }
});

test("writeActionExecution lane progresses and finishes without invoice semantics", () => {
  const f = fixture();
  try {
    f.dispatch(f.propose("a"));
    const task = f.dispatch({ op: "claim", owner: "worker" });
    const lease = { id: task.id, owner: "worker", generation: task.generation };
    f.dispatch({ op: "update", ...lease, index: 0, phase: "preparing" });
    f.dispatch({ op: "update", ...lease, index: 0, phase: "submitting", sha256: "a".repeat(64) });
    f.dispatch({ op: "update", ...lease, index: 0, phase: "succeeded", invoiceId: "receipt" });
    // No module: the store port is absent, so markUploaded is skipped —
    // the invoice_attachment_statuses table stays empty.
    const rows = f.db.prepare("SELECT count(*) AS n FROM invoice_attachment_statuses").get() as { n: number };
    assert.equal(rows.n, 0);
    const done = f.dispatch({ op: "finish", ...lease });
    assert.equal(done.state, "succeeded");
    const result = JSON.parse(f.pending.getById("a")!.execution_result_json!);
    assert.match(result.summary, /本次上传 1 个/);
  } finally { f.db.close(); }
});

test("preflight reads legacy guard rows and live tasks without an edition module", () => {
  const f = fixture();
  try {
    f.db.prepare("INSERT INTO agent_action_legacy_submissions VALUES (?,?,?)").run("account-1", "old", "attachment");
    f.dispatch(f.propose("a"));
    assert.throws(() => f.dispatch(f.propose("stale")), /upload-list-stale/);
    const items = [{ emailId: "old", attachmentId: "attachment" }, { emailId: "mail-1", attachmentId: "att-1" },
      { emailId: "new", attachmentId: "attachment" }];
    const repository = new ActionExecutionRepository(f.db);
    assert.deepEqual(repository.dispatch({ op: "preflight", accountId: "account-1", items }),
      { eligibility: items.map((item, index) => ({ ...item, reason: ["pending_verification", "in_progress", null][index] })) });
    assert.deepEqual(repository.dispatch({ op: "preflight", accountId: "other-account", items }),
      { eligibility: items.map((item) => ({ ...item, reason: null })) });
  } finally { f.db.close(); }
});

test("lease recovery fences late writers and never replays a possibly submitted item", () => {
  const f = fixture();
  try {
    f.dispatch(f.propose("a"));
    const task = f.dispatch({ op: "claim", owner: "old" });
    const lease = { id: task.id, owner: "old", generation: task.generation };
    f.dispatch({ op: "update", ...lease, index: 0, phase: "preparing" });
    f.dispatch({ op: "update", ...lease, index: 0, phase: "submitting", sha256: "a".repeat(64) });
    f.advance(90_001);
    const recovered = f.dispatch({ op: "claim", owner: "new" });
    assert.equal(recovered.items[0].phase, "outcome_unknown");
    assert.throws(() => f.dispatch({ op: "update", ...lease, index: 0, phase: "succeeded", invoiceId: "receipt" }), /lease-lost/);
    const done = f.dispatch({ op: "finish", id: task.id, owner: "new", generation: recovered.generation });
    assert.equal(done.state, "outcome_unknown");
    assert.equal(f.pending.getById("a")!.execution_state, "outcome_unknown");
  } finally { f.db.close(); }
});

test("explicit lane port injection stays available for edition/test harnesses", () => {
  const f = fixture();
  try {
    const marked: Array<{ emailId: string; invoiceId?: string }> = [];
    const repository = new ActionExecutionRepository(f.db, f.nowFn, {
      receipts: {
        allowanceAuthenticationFailure: () => null,
        rejectedAllowanceReceipt: () => null,
        selectAllowanceReceipt: () => null,
      },
      invoiceStatuses: {
        get: () => null,
        getMailStatus: () => ({ tag: null, state: null, statuses: [] }),
        markUploaded: (input) => { marked.push({ emailId: input.emailId, invoiceId: input.invoiceId }); },
        markFromUploadFailure: () => {},
        markDeletedByInvoiceIds: () => 0,
        reconcilePlatformOutput: () => 0,
        ensureNotStartedForInvoiceMessage: () => 0,
      },
    });
    const parameters = { items: [{ emailId: "mail-1", attachmentId: "att-1" }] };
    f.pending.insert({ id: "b", accountId: "account-1", actionType: "upload_allowance_invoices", description: "上传",
      inputJson: JSON.stringify(parameters), parameters, riskReason: "上传" });
    repository.dispatch({ op: "accept", actionId: "b", accountId: "account-1", parameters, idempotencyKey: f.pending.getById("b")!.idempotency_key! });
    const task = repository.dispatch({ op: "claim", owner: "worker" }) as ActionExecutionSnapshot;
    const lease = { id: task.id, owner: "worker", generation: task.generation };
    repository.dispatch({ op: "update", ...lease, index: 0, phase: "preparing" });
    repository.dispatch({ op: "update", ...lease, index: 0, phase: "submitting", sha256: "b".repeat(64) });
    repository.dispatch({ op: "update", ...lease, index: 0, phase: "succeeded", invoiceId: "receipt" });
    assert.deepEqual(marked, [{ emailId: "mail-1", invoiceId: "receipt" }]);
  } finally { f.db.close(); }
});
