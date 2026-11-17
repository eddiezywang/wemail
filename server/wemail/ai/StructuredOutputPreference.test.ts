import assert from "node:assert/strict";
import { test } from "node:test";
import { StructuredOutputPreference } from "./StructuredOutputPreference.js";

test("structured fallback requires repeated validated failures, is schema-specific, and expires", () => {
  let now = 0;
  const cache = new StructuredOutputPreference(() => now, 100, 2);
  const key = cache.key("model", { type: "object", properties: { a: { type: "string" } } });
  const other = cache.key("model", { type: "object", properties: { b: { type: "string" } } });
  const otherModel = cache.key("other-model", { type: "object", properties: { a: { type: "string" } } });
  cache.recordValidatedFallback(key);
  assert.equal(cache.preferJsonObject(key), false);
  cache.recordValidatedFallback(key);
  assert.equal(cache.preferJsonObject(key), true);
  assert.equal(cache.preferJsonObject(other), false);
  assert.equal(cache.preferJsonObject(otherModel), false);
  now = 100;
  assert.equal(cache.preferJsonObject(key), false);
  cache.recordValidatedFallback(key);
  assert.equal(cache.preferJsonObject(key), false);
  cache.recordNativeSuccess(key);
  cache.recordValidatedFallback(key);
  assert.equal(cache.preferJsonObject(key), false);
});

test("structured fallback hints are bounded", () => {
  const cache = new StructuredOutputPreference(() => 0, 100, 1);
  cache.recordValidatedFallback("first");
  cache.recordValidatedFallback("first");
  cache.recordValidatedFallback("second");
  assert.equal(cache.preferJsonObject("first"), false);
});
