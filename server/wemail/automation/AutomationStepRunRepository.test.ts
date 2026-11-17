import { insertCanonicalTestAccount } from "../database/MailDatabase.test-support.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { openOrCreateMailDatabase } from "../database/Database.js";
import { AutomationStepRunRepository } from "./AutomationStepRunRepository.js";

test("step audit persists bounded summaries, duration, side effects and redacted errors", () => {
  const db = openOrCreateMailDatabase(":memory:");
  try {
    insertCanonicalTestAccount(db, { id: "account-1", email: "owner@example.test", displayName: "Owner" });
    const repository = new AutomationStepRunRepository(db);
    repository.record({
      runId: "run-1",
      ruleId: "rule-1",
      ruleVersion: 2,
      stepId: "bot",
      inputSummary: { mailIds: ["mail-1"], oversized: "x".repeat(40_000) },
      result: {
        status: "failed",
        warnings: ["Bot 未连接"],
        sideEffects: [{ type: "publish-message", summary: "消息中心已成功" }],
        error: {
          code: "execution-failed",
          message: "token=secret-value C:\\Users\\Owner\\Temp\\payload.json",
          retryable: true,
          retrySafe: true,
        },
        audit: {
          provider: "bot-message",
          capability: "publish-connected",
          capabilityFingerprint: "fingerprint-1",
          startedAt: "2026-07-29T12:00:00.000Z",
          completedAt: "2026-07-29T12:00:01.250Z",
          durationMs: 1250,
        },
      },
    });
    const [row] = repository.list("run-1");
    assert.equal(row?.duration_ms, 1250);
    assert.match(String(row?.input_summary_json), /"truncated":true/);
    assert.match(String(row?.warnings_json), /Bot 未连接/);
    assert.match(String(row?.side_effects_json), /消息中心已成功/);
    assert.doesNotMatch(String(row?.error_json), /secret-value|Owner/);
    assert.match(String(row?.error_json), /REDACTED/);
  } finally {
    db.close();
  }
});
