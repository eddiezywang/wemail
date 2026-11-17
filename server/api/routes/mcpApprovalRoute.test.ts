import { insertCanonicalTestAccount } from "../../wemail/database/MailDatabase.test-support.js";
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { Hono } from "hono";
import { openOrCreateMailDatabase } from "../../wemail/database/Database.js";
import { AgentPendingActionRepository } from "../../wemail/agent/AgentPendingActionRepository.js";
import { McpPreparedOperationRepository } from "../../wemail/mcp/McpPreparedOperationRepository.js";
import { buildAgentRoutes } from "./agentRoutes.js";

test("confirming an MCP pending action approves the exact operation without executing it", async () => {
  const db = openOrCreateMailDatabase(":memory:");
  try {
    insertCanonicalTestAccount(db, { id: "a", email: "a@example.test", displayName: "A" });
    const pendingActions = new AgentPendingActionRepository({ db });
    const operations = new McpPreparedOperationRepository(db);
    const payload = { accountId: "a", action: "archive", messageIds: ["m1"] };
    const payloadHash = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
    const operation = operations.create({
      id: "op-1",
      accountId: "a",
      operationType: "mail_action",
      payload,
      payloadHash,
      preview: "Archive one message",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    pendingActions.insert({
      id: "approval-1",
      accountId: "a",
      mcpOperationId: operation.id,
      actionType: "archive",
      description: operation.preview,
      inputJson: JSON.stringify({ operationId: operation.id, payloadHash }),
      riskReason: "MCP confirmation required",
      riskLevel: "high",
    });
    let executions = 0;
    const app = new Hono();
    app.route("/api/agent", buildAgentRoutes({
      pendingActions,
      mcpOperations: operations,
      getActiveAccountId: () => "a",
      actionExecutor: { execute: async () => { executions += 1; return { ok: true, summary: "wrong" }; } },
    }));
    const response = await app.request("/api/agent/pending-actions/approval-1/resolve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        status: "confirmed",
        idempotencyKey: pendingActions.getById("approval-1")?.idempotency_key,
        parameters: JSON.parse(
          pendingActions.getById("approval-1")?.displayed_parameters_json ?? "{}",
        ),
      }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      approval: { operationId: "op-1", state: "approved", executed: false },
    });
    assert.equal(executions, 0);
    assert.equal(operations.get("op-1")?.state, "approved");
    assert.equal(pendingActions.getById("approval-1")?.status, "confirmed");
  } finally {
    db.close();
  }
});
