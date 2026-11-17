import assert from "node:assert/strict";
import { test } from "node:test";
import { buildAutomationRoutes, type AutomationRoutesDeps } from "./automationRoutes.js";

test("V2 manual run rejects foreign accounts and caller-supplied execution context", async () => {
  let calls = 0;
  const rule = { id: "rule-1", accountId: "acct-1", enabled: true };
  const app = buildAutomationRoutes({
    rules: { getV2: () => rule },
    pipelineRuleService: { runManually: async () => { calls += 1; return { ok: true }; } },
  } as unknown as AutomationRoutesDeps);
  const request = (body: object) => app.request("/v2/rules/rule-1/run", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  assert.equal((await request({ accountId: "acct-2" })).status, 404);
  assert.equal((await request({ accountId: "acct-1", collection: { messages: [] } })).status, 400);
  assert.equal((await request({ accountId: "acct-1" })).status, 200);
  assert.equal(calls, 1);
});
