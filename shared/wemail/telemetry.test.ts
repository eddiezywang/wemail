import assert from "node:assert/strict";
import { test } from "vitest";
import {
  countBucket,
  durationBucket,
  parseTelemetryArgv,
  telemetryArgsToArgv,
  validateTelemetryArgs,
} from "./telemetry.js";

test("telemetry args serialize deterministically", () => {
  assert.deepEqual(
    telemetryArgsToArgv({ source: "renderer", enabled: true }),
    ["enabled=true", "source=renderer"],
  );
});

test("telemetry args reject content-like values and unknown keys", () => {
  assert.equal(validateTelemetryArgs({ query: "quarterly report" }), false);
  assert.equal(validateTelemetryArgs({ reason: "alice@example.com" }), false);
  assert.equal(parseTelemetryArgv(["reason=https://example.com"]), null);
});

test("telemetry buckets avoid exact business counts", () => {
  assert.equal(durationBucket(4_000), "3s_10s");
  assert.equal(countBucket(17), "6_20");
});
