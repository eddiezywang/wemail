import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  assertValidAccountId,
  composeWorkspace,
  InvalidAccountIdError,
} from "./workspace.js";

function tmpDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "wemail-workspace-comp-"));
}

test("assertValidAccountId accepts safe identifiers", () => {
  assert.doesNotThrow(() => assertValidAccountId("acct-1"));
  assert.doesNotThrow(() => assertValidAccountId("user.name"));
  assert.doesNotThrow(() => assertValidAccountId("ABC_123"));
});

test("assertValidAccountId rejects empty / non-string", () => {
  assert.throws(() => assertValidAccountId(""), InvalidAccountIdError);
  assert.throws(() => assertValidAccountId(undefined), InvalidAccountIdError);
  assert.throws(() => assertValidAccountId(123), InvalidAccountIdError);
});

test("assertValidAccountId rejects . and ..", () => {
  assert.throws(() => assertValidAccountId("."), InvalidAccountIdError);
  assert.throws(() => assertValidAccountId(".."), InvalidAccountIdError);
});

test("assertValidAccountId rejects path separators", () => {
  assert.throws(() => assertValidAccountId("foo/bar"), InvalidAccountIdError);
  assert.throws(() => assertValidAccountId("foo\\bar"), InvalidAccountIdError);
  assert.throws(
    () => assertValidAccountId("../../etc/passwd"),
    InvalidAccountIdError,
  );
  assert.throws(
    () => assertValidAccountId("/abs/path"),
    InvalidAccountIdError,
  );
});

test("assertValidAccountId rejects ids starting with .", () => {
  assert.throws(() => assertValidAccountId(".hidden"), InvalidAccountIdError);
  assert.throws(() => assertValidAccountId("..foo"), InvalidAccountIdError);
});

test("assertValidAccountId rejects ids with whitespace or unsafe chars", () => {
  assert.throws(() => assertValidAccountId("a b"), InvalidAccountIdError);
  assert.throws(() => assertValidAccountId("a\tb"), InvalidAccountIdError);
  assert.throws(() => assertValidAccountId("a;b"), InvalidAccountIdError);
});

test("composeWorkspace.forAccount throws on invalid accountId", () => {
  const dataDir = tmpDataDir();
  const ws = composeWorkspace({ dataDir });
  assert.throws(
    () => ws.forAccount("../../etc"),
    InvalidAccountIdError,
  );
  assert.throws(() => ws.forAccount(""), InvalidAccountIdError);
});

test("composeWorkspace.forAccount creates the per-account dir under root", () => {
  const dataDir = tmpDataDir();
  const ws = composeWorkspace({ dataDir });
  ws.forAccount("acct-1");
  const expected = path.join(dataDir, "agent-workspace", "acct-1");
  assert.ok(fs.existsSync(expected));
});

test("routingSink drops events with malicious accountId without crashing", async () => {
  const dataDir = tmpDataDir();
  const events: { event: string; fields: Record<string, unknown> }[] = [];
  const ws = composeWorkspace({
    dataDir,
    logger: (event, fields) => events.push({ event, fields }),
  });
  // Should NOT throw — routing sink defensively logs and returns.
  await ws.routingSink.append("tag-reject", {
    accountId: "../../etc",
    detail: "anything",
  });
  await ws.routingSink.append("tag-reject", { detail: "no accountId" });
  // Both emits dropped; no per-account file created.
  const evicted = events.filter((e) =>
    e.event === "workspace.feedback.invalid-accountId" ||
    e.event === "workspace.feedback.missing-accountId"
  );
  assert.equal(evicted.length, 2);
});

test("routingSink routes to forAccount for valid accountId", async () => {
  const dataDir = tmpDataDir();
  const ws = composeWorkspace({ dataDir });
  await ws.routingSink.append("tag-reject", {
    accountId: "acct-1",
    label: "newsletter",
  });
  const expectedFile = path.join(
    dataDir,
    "agent-workspace",
    "acct-1",
    "feedback",
    "tag-events.jsonl",
  );
  assert.ok(fs.existsSync(expectedFile));
});
