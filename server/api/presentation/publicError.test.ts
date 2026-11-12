import assert from "node:assert/strict";
import test from "node:test";
import { projectPublicErrorResponse } from "./publicError.js";

test("projects raw API failures into a renderer-safe envelope", () => {
  const response = projectPublicErrorResponse(500, {
    ok: false,
    error: "sqlite failed at C:\\Users\\alice\\mail.db",
    detail: "provider token=secret",
    stage: "database-open",
    errorId: "error_123456",
    execution: {
      summary: "任务没有完成",
      stderr: "private process output",
      toolCallId: "call-private",
    },
  });

  assert.equal(response.error, "服务暂时不可用，请稍后重试。");
  assert.equal(response.code, "SERVICE_UNAVAILABLE");
  assert.deepEqual(response.execution, { summary: "任务没有完成" });
  assert.equal(JSON.stringify(response).includes("alice"), false);
  assert.equal(JSON.stringify(response).includes("secret"), false);
  assert.equal(JSON.stringify(response).includes("call-private"), false);
  assert.deepEqual(response.publicError, {
    code: "SERVICE_UNAVAILABLE",
    messageKey: "service_unavailable",
    retryable: true,
    recoveryAction: "retry",
    correlationId: "error_123456",
  });
});
