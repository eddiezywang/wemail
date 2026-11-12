import { insertCanonicalTestAccount } from "../../wemail/database/MailDatabase.test-support.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { openOrCreateMailDatabase } from "../../wemail/database/Database.js";
import { ConfigurationTaskRepository } from "../../wemail/configuration/ConfigurationTaskRepository.js";
import { ConfigurationWorkflowService } from "../../wemail/configuration/ConfigurationWorkflowService.js";
import { buildConfigurationRoutes } from "./configurationRoutes.js";

function fixture() {
  const db = openOrCreateMailDatabase(":memory:");
  const now = () => "2026-07-29T12:00:00.000Z";
  insertCanonicalTestAccount(db, { id: "acct-1", email: "one@example.test", displayName: "One" });
  const workflow = new ConfigurationWorkflowService(new ConfigurationTaskRepository(db), undefined, now);
  const app = buildConfigurationRoutes({ workflow, getActiveAccountId: () => "acct-1" });
  return { db, workflow, app };
}

test("configuration routes deduplicate starts and enforce active-account scope", async () => {
  const { db, app } = fixture();
  try {
    const input = {
      accountId: "acct-2",
      kind: "automation_rule",
      targetKey: "daily-monitoring",
      operation: "create",
      title: "每日监控",
      source: { surface: "api" },
    };
    const first = await app.request("/", { method: "POST", body: JSON.stringify(input), headers: { "content-type": "application/json" } });
    const second = await app.request("/", { method: "POST", body: JSON.stringify(input), headers: { "content-type": "application/json" } });
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    const firstBody = await first.json() as any;
    const secondBody = await second.json() as any;
    assert.equal(firstBody.snapshot.id, secondBody.snapshot.id);
    assert.equal(firstBody.snapshot.accountId, "acct-1");
  } finally {
    db.close();
  }
});

test("configuration routes reject stale revisions and mismatched confirmations", async () => {
  const { db, workflow, app } = fixture();
  try {
    let task = workflow.start({
      accountId: "acct-1",
      kind: "automation_rule",
      targetKey: "daily-monitoring",
      operation: "create",
      title: "每日监控",
      source: { surface: "api" },
    });
    task = workflow.recordPreview({
      taskId: task.id,
      accountId: "acct-1",
      expectedRevision: task.revision,
      previewId: "preview-1",
      previewHash: "hash-1",
      expiresAt: "2026-07-29T13:00:00.000Z",
      capabilityFingerprints: [{ provider: "processor", capability: "monitoring-report", fingerprint: "fp-1" }],
      risk: "external-mutation",
    });

    const stale = await app.request(`/${task.id}/cancel`, {
      method: "POST",
      body: JSON.stringify({ expectedRevision: task.revision - 1 }),
      headers: { "content-type": "application/json" },
    });
    assert.equal(stale.status, 409);
    const staleBody = await stale.json() as any;
    assert.equal(staleBody.snapshot.revision, task.revision);

    const mismatch = await app.request(`/${task.id}/confirm`, {
      method: "POST",
      body: JSON.stringify({
        expectedRevision: task.revision,
        authorization: { ...task.authorization, previewHash: "tampered" },
      }),
      headers: { "content-type": "application/json" },
    });
    assert.equal(mismatch.status, 409);

    const confirmed = await app.request(`/${task.id}/confirm`, {
      method: "POST",
      body: JSON.stringify({ expectedRevision: task.revision, authorization: task.authorization }),
      headers: { "content-type": "application/json" },
    });
    assert.equal(confirmed.status, 200);
    assert.equal(((await confirmed.json()) as any).snapshot.status, "committing");
  } finally {
    db.close();
  }
});
