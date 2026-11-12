import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { classifyServerTest, parseShard, selectServerTests } from "../../scripts/test-selection.mjs";

test("classifies server tests by explicit naming conventions", () => {
  assert.equal(classifyServerTest("server/a.test.ts"), "unit");
  assert.equal(classifyServerTest("server/a.integration.test.ts"), "integration");
  assert.equal(classifyServerTest("server/a.workspace.test.ts"), "integration");
  assert.equal(classifyServerTest("server/acceptance/a.test.ts"), "acceptance");
  assert.equal(classifyServerTest("server/a.eval.test.ts"), "evaluation");
  assert.equal(classifyServerTest("server/a.live.test.ts"), "live");
  assert.equal(classifyServerTest("server/a.live.ts"), "live");
});

test("selects paths deterministically before applying a shard", () => {
  const files = ["server/b.test.ts", "server/a.test.ts", "server/c.integration.test.ts"].map((file) => path.resolve(file));
  assert.deepEqual(selectServerTests(files, { scope: "unit", shard: "1/2" }), [path.resolve("server/a.test.ts")]);
  assert.deepEqual(selectServerTests(files, { scope: "unit", shard: "2/2" }), [path.resolve("server/b.test.ts")]);
});

test("rejects invalid shards", () => {
  assert.throws(() => parseShard("0/2"), /Invalid shard/);
  assert.throws(() => parseShard("3/2"), /Invalid shard/);
});
