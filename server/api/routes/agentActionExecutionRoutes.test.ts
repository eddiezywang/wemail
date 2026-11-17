import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import { buildAgentRoutes } from "./agentRoutes.js";
import { openOrCreateMailDatabase } from "../../wemail/database/Database.js";
import { AgentPendingActionRepository } from "../../wemail/agent/AgentPendingActionRepository.js";
import type { ActionExecutionPort } from "../../wemail/agent/allowancePort.js";

test("confirmation returns 202 and one task without waiting for or invoking the legacy executor", async () => {
  const db = openOrCreateMailDatabase(":memory:");
  const pendingActions = new AgentPendingActionRepository({ db });
  const parameters = { items: [{ emailId: "mail", attachmentId: "attachment", filename: "invoice.pdf" }] };
  pendingActions.insert({ id: "a", accountId: "account", actionType: "upload_allowance_invoices", description: "上传", inputJson: JSON.stringify(parameters), parameters, riskReason: "上传" });
  const task = { planVersion: 1 as const, id: "task-a", actionId: "a", accountId: "account",
    state: "queued" as const, revision: 1, generation: 0, items: [] };
  // Port stub: only the route contract is under test here. The full
  // accept → execute → status write-back chain is exercised by the
  // edition module's harness (wemail-int internal/src/allowance).
  const actionExecutions: ActionExecutionPort = {
    available: true,
    async accept(input) {
      const reservation = pendingActions.reserveExecution({ id: input.actionId, idempotencyKey: input.idempotencyKey, parameters: input.parameters });
      if (reservation.kind !== "reserved" && reservation.kind !== "duplicate") throw new Error(`action-${reservation.kind}`);
      return task;
    },
    get: async (accountId, actionId) => accountId === task.accountId && actionId === task.actionId ? task : null,
    subscribe: () => () => {},
    wake() {},
    async stop() {},
  };
  const app = new Hono();
  let oldCalls = 0;
  app.route("/api/agent", buildAgentRoutes({ pendingActions, actionExecutions, getActiveAccountId: () => "account",
    actionExecutor: { async execute() { oldCalls++; throw new Error("legacy path must not run"); } } }));
  try {
    const confirm = () => app.request("/api/agent/pending-actions/a/resolve", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "confirmed", parameters, idempotencyKey: pendingActions.getById("a")!.idempotency_key }) });
    const first = await confirm();
    assert.equal(first.status, 202);
    const body = await first.json() as { task: { id: string; state: string } };
    assert.equal(body.task.state, "queued");
    const second = await confirm();
    assert.equal(second.status, 202);
    assert.equal(((await second.json()) as { task: { id: string } }).task.id, body.task.id);
    assert.equal(oldCalls, 0);
    const state = await app.request("/api/agent/action-executions/a");
    assert.equal(state.status, 200);
    const reject = await app.request("/api/agent/pending-actions/a/resolve", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "rejected" }) });
    assert.equal(reject.status, 409);
  } finally { db.close(); }
});
