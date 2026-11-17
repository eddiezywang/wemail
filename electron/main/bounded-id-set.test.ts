import assert from "node:assert/strict";
import { test } from "node:test";
import { BoundedIdSet } from "./bounded-id-set.js";

test("bounded id set evicts oldest ids and expires stale ids", () => {
  let now = 0;
  const ids = new BoundedIdSet(2, 100, () => now);

  assert.deepEqual(ids.add("mail-a"), []);
  assert.deepEqual(ids.add("mail-b"), []);
  assert.deepEqual(ids.add("mail-c"), ["mail-a"]);
  assert.equal(ids.has("mail-a"), false);
  assert.equal(ids.has("mail-b"), true);
  assert.equal(ids.has("mail-c"), true);

  now = 101;
  assert.equal(ids.has("mail-b"), false);
  assert.equal(ids.has("mail-c"), false);
});
