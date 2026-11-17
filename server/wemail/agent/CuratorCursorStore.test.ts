import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import {
  InMemoryCuratorCursorStore,
  JsonCuratorCursorStore,
  ZERO_COUNTERS,
} from "./CuratorCursorStore.js";
import { WorkspaceFileSystem } from "../workspace/WorkspaceFileSystem.js";
import { createWorkspacePathPolicy } from "../workspace/WorkspacePathPolicy.js";

function freshAccountFs(): { fs: WorkspaceFileSystem; root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-cursor-store-"));
  const policy = createWorkspacePathPolicy({ root });
  return { fs: new WorkspaceFileSystem({ policy }), root };
}

test("InMemoryCuratorCursorStore returns null + zero counters when empty", async () => {
  const store = new InMemoryCuratorCursorStore();
  assert.equal(await store.getLastRunAt("acct-1"), null);
  assert.deepEqual(await store.getCounters("acct-1"), ZERO_COUNTERS);
});

test("InMemoryCuratorCursorStore round-trips lastRunAt and counters", async () => {
  const store = new InMemoryCuratorCursorStore();
  const t = new Date("2026-04-29T12:00:00Z");
  await store.setLastRunAt("acct-1", t);
  assert.equal((await store.getLastRunAt("acct-1"))?.toISOString(), t.toISOString());
  await store.setCounters("acct-1", {
    "mail-arrived": 7,
    "feedback-event": 3,
  });
  const counters = await store.getCounters("acct-1");
  assert.equal(counters["mail-arrived"], 7);
  assert.equal(counters["feedback-event"], 3);
});

test("JsonCuratorCursorStore reads empty state for missing file", async () => {
  const { fs: wfs } = freshAccountFs();
  const store = new JsonCuratorCursorStore({ fsForAccount: () => wfs });
  assert.equal(await store.getLastRunAt("acct-1"), null);
  assert.deepEqual(await store.getCounters("acct-1"), ZERO_COUNTERS);
});

test("JsonCuratorCursorStore writes and re-reads counters and lastRunAt", async () => {
  const { fs: wfs, root } = freshAccountFs();
  const store = new JsonCuratorCursorStore({ fsForAccount: () => wfs });
  const t = new Date("2026-04-29T12:00:00Z");
  await store.setLastRunAt("acct-1", t);
  await store.setCounters("acct-1", { "mail-arrived": 49, "feedback-event": 2 });
  // The file is on disk under the account workspace root.
  const onDisk = fs.readFileSync(path.join(root, "curator-cursor.json"), "utf8");
  const parsed = JSON.parse(onDisk);
  assert.equal(parsed.lastRunAt, t.toISOString());
  assert.deepEqual(parsed.counters, { "mail-arrived": 49, "feedback-event": 2 });

  const reread = new JsonCuratorCursorStore({ fsForAccount: () => wfs });
  assert.equal((await reread.getLastRunAt("acct-1"))?.toISOString(), t.toISOString());
  assert.deepEqual(await reread.getCounters("acct-1"), {
    "mail-arrived": 49,
    "feedback-event": 2,
  });
});

test("JsonCuratorCursorStore tolerates malformed JSON by returning empty state", async () => {
  const { fs: wfs } = freshAccountFs();
  await wfs.writeFile("curator-cursor.json", "not-json");
  const store = new JsonCuratorCursorStore({ fsForAccount: () => wfs });
  assert.equal(await store.getLastRunAt("acct-1"), null);
  assert.deepEqual(await store.getCounters("acct-1"), ZERO_COUNTERS);
});

test("JsonCuratorCursorStore normalizes negative or non-integer counters", async () => {
  const { fs: wfs } = freshAccountFs();
  const store = new JsonCuratorCursorStore({ fsForAccount: () => wfs });
  await store.setCounters("acct-1", {
    "mail-arrived": -5,
    "feedback-event": 1.7 as unknown as number,
  });
  const counters = await store.getCounters("acct-1");
  assert.equal(counters["mail-arrived"], 0);
  assert.equal(counters["feedback-event"], 1);
});
