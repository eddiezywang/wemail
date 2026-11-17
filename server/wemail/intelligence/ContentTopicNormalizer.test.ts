import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeContentTopic } from "./ContentTopicNormalizer.js";

test("normalizes volatile dates, versions, and ticket numbers", () => {
  assert.equal(normalizeContentTopic("服务器故障 2026-07-28")?.normalizedKey, "服务器故障");
  assert.equal(normalizeContentTopic("季度预算 v2.3")?.normalizedKey, "季度预算");
  assert.equal(normalizeContentTopic("冲突 INC-12345")?.normalizedKey, "冲突");
});

test("rejects system labels and generic buckets as content topics", () => {
  for (const name of ["重要", "待处理", "发票", "通知", "其他", "个人"]) {
    assert.equal(normalizeContentTopic(name), null);
  }
});
