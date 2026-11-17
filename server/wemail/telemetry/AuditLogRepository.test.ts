import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { openOrCreateMailDatabase } from "../database/Database.js";
import type { WecliCommandClassification } from "../../../shared/wemail/wecliTypes.js";
import {
  AUDIT_STREAM_CAP_BYTES,
  AuditLogRepository,
} from "./AuditLogRepository.js";

function openDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-audit-"));
  const db = openOrCreateMailDatabase(path.join(dir, "wemail.sqlite"));
  return { db, dir };
}

function autoClassification(
  subcommand = "ls",
): WecliCommandClassification {
  return {
    kind: "auto-approved",
    command: "wecli",
    subcommand,
    reason: `read-only ${subcommand} auto-approved`,
  };
}

test("AuditLogRepository.record inserts a well-formed row", () => {
  const { db } = openDb();
  const repo = new AuditLogRepository(
    db,
    () => new Date("2026-04-24T10:00:00.000Z"),
  );
  const entry = repo.record({
    command: "wecli",
    args: ["ls", "--mine"],
    classification: autoClassification(),
    exitCode: 0,
    stdout: '{"ok":true}',
    stderr: "",
    durationMs: 42,
  });

  assert.ok(entry.id);
  assert.equal(entry.invokedAt, "2026-04-24T10:00:00.000Z");
  assert.equal(entry.classification.kind, "auto-approved");
  assert.equal(entry.exitCode, 0);
  assert.equal(entry.durationMs, 42);

  const list = repo.list();
  assert.equal(list.length, 1);
  assert.deepEqual(list[0].args, ["ls", "--mine"]);
  assert.equal(list[0].classification.subcommand, "ls");
});

test("AuditLogRepository.list returns rows newest-first", () => {
  const { db } = openDb();
  const repo = new AuditLogRepository(db);
  repo.record({
    command: "wecli",
    args: ["ls"],
    classification: autoClassification(),
    durationMs: 1,
    invokedAt: "2026-04-20T00:00:00.000Z",
  });
  repo.record({
    command: "wecli",
    args: ["list"],
    classification: autoClassification("list"),
    durationMs: 2,
    invokedAt: "2026-04-22T00:00:00.000Z",
  });
  repo.record({
    command: "wecli",
    args: ["deploy"],
    classification: {
      kind: "requires-confirmation",
      command: "wecli",
      subcommand: "deploy",
      reason: "mutation",
    },
    durationMs: 3,
    invokedAt: "2026-04-21T00:00:00.000Z",
  });

  const list = repo.list({ limit: 10 });
  assert.equal(list.length, 3);
  assert.equal(list[0].invokedAt, "2026-04-22T00:00:00.000Z");
  assert.equal(list[1].invokedAt, "2026-04-21T00:00:00.000Z");
  assert.equal(list[2].invokedAt, "2026-04-20T00:00:00.000Z");
});

test("AuditLogRepository.list honors since filter", () => {
  const { db } = openDb();
  const repo = new AuditLogRepository(db);
  repo.record({
    command: "wecli",
    args: ["ls"],
    classification: autoClassification(),
    durationMs: 1,
    invokedAt: "2026-04-01T00:00:00.000Z",
  });
  repo.record({
    command: "wecli",
    args: ["list"],
    classification: autoClassification("list"),
    durationMs: 2,
    invokedAt: "2026-04-23T00:00:00.000Z",
  });

  const list = repo.list({ since: "2026-04-20T00:00:00.000Z" });
  assert.equal(list.length, 1);
  assert.equal(list[0].classification.subcommand, "list");
});

test("AuditLogRepository truncates stdout/stderr beyond the cap", () => {
  const { db } = openDb();
  const repo = new AuditLogRepository(db);
  const giant = "x".repeat(AUDIT_STREAM_CAP_BYTES + 100);
  const entry = repo.record({
    command: "wecli",
    args: ["ls"],
    classification: autoClassification(),
    durationMs: 1,
    stdout: giant,
  });
  assert.ok((entry.stdout ?? "").includes("[truncated]"));
  const persisted = repo.list()[0];
  assert.ok((persisted.stdout ?? "").endsWith("[truncated]"));
});

test("AuditLogRepository.deleteOlderThan prunes old rows", () => {
  const { db } = openDb();
  const repo = new AuditLogRepository(db);
  repo.record({
    command: "wecli",
    args: ["ls"],
    classification: autoClassification(),
    durationMs: 1,
    invokedAt: "2026-01-01T00:00:00.000Z",
  });
  repo.record({
    command: "wecli",
    args: ["list"],
    classification: autoClassification("list"),
    durationMs: 2,
    invokedAt: "2026-04-23T00:00:00.000Z",
  });

  const deleted = repo.deleteOlderThan("2026-03-01T00:00:00.000Z");
  assert.equal(deleted, 1);
  const remaining = repo.list();
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].classification.subcommand, "list");
});

test("AuditLogRepository exposes no update method (append-only)", () => {
  const repo = new AuditLogRepository(
    openOrCreateMailDatabase(
      path.join(
        fs.mkdtempSync(path.join(os.tmpdir(), "wemail-audit-")),
        "wemail.sqlite",
      ),
    ),
  );
  // Compile-time shape: these methods must not exist. Runtime check guards
  // against future regressions that would accept mutations.
  assert.equal(
    (repo as unknown as { update?: unknown }).update,
    undefined,
  );
  assert.equal(
    (repo as unknown as { modify?: unknown }).modify,
    undefined,
  );
});
