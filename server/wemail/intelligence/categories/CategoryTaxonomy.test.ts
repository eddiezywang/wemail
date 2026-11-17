import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SMART_CLASSIFICATION_IDS,
  SMART_CLASSIFICATION_LABELS,
  SMART_CLASSIFICATION_SET,
  type SmartClassificationId,
} from "../../../../shared/wemail/intelligence.js";
import {
  SYSTEM_CATEGORY_IDS as LOCAL_IDS,
  SYSTEM_CATEGORY_LABELS as LOCAL_LABELS,
  SYSTEM_CATEGORY_SET as LOCAL_SET,
  isSystemCategory,
} from "./CategoryTaxonomy.js";

test("visible taxonomy has exactly 3 canonical ids", () => {
  assert.equal(LOCAL_IDS.length, 3);
});

test("SYSTEM_CATEGORY_IDS are in canonical order", () => {
  assert.deepEqual([...LOCAL_IDS], [
    "important",
    "action_required",
    "invoice",
  ]);
});

test("SYSTEM_CATEGORY_SET contains all canonical ids", () => {
  for (const id of LOCAL_IDS) {
    assert.ok(LOCAL_SET.has(id), `${id} should be in visible set`);
  }
});

test("SYSTEM_CATEGORY_SET does not contain non-canonical ids", () => {
  assert.ok(!LOCAL_SET.has("newsletter"));
  assert.ok(!LOCAL_SET.has("receipt"));
  assert.ok(!LOCAL_SET.has("notification"));
});

test("SYSTEM_CATEGORY_LABELS has a label for every system category", () => {
  for (const id of LOCAL_IDS) {
    const label = LOCAL_LABELS[id];
    assert.ok(typeof label === "string" && label.length > 0, `${id} should have a label`);
  }
});

test("visible taxonomy uses approved Chinese labels", () => {
  assert.equal(LOCAL_LABELS.important, "重要");
  assert.equal(LOCAL_LABELS.action_required, "待处理");
  assert.equal(LOCAL_LABELS.invoice, "发票");
});

test("isSystemCategory returns true for canonical ids", () => {
  assert.equal(isSystemCategory("important"), true);
  assert.equal(isSystemCategory("action_required"), true);
  assert.equal(isSystemCategory("invoice"), true);
});

test("isSystemCategory returns false for non-canonical ids", () => {
  assert.equal(isSystemCategory("finance"), false);
  assert.equal(isSystemCategory("Important"), false); // case-sensitive
  assert.equal(isSystemCategory(""), false);
  assert.equal(isSystemCategory("random"), false);
});

test("shared smart-classification and local visible taxonomy definitions are identical", () => {
  assert.deepEqual([...LOCAL_IDS], [...SMART_CLASSIFICATION_IDS]);
  assert.deepEqual([...LOCAL_SET], [...SMART_CLASSIFICATION_SET]);
  assert.deepEqual(LOCAL_LABELS, SMART_CLASSIFICATION_LABELS);
  assert.equal(isSystemCategory("invoice"), true);
  assert.equal(isSystemCategory("random"), false);
});

test("system category ids are language-independent (ASCII only, no spaces)", () => {
  for (const id of LOCAL_IDS) {
    assert.ok(/^[a-z_]+$/.test(id), `${id} should be lowercase ASCII with underscores only`);
  }
});

test("no system category id is a display label", () => {
  // Display labels like "Action Required" must not be used as ids
  for (const id of LOCAL_IDS) {
    const label = SMART_CLASSIFICATION_LABELS[id as SmartClassificationId];
    assert.notEqual(id, label, `id ${id} should not equal its display label`);
  }
});
