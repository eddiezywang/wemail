import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  applyPendingDataMigration,
  ensureDataDirectoryMarker,
  resolveDataDirectory,
} from "./data-directory.js";

function withoutManagedDataDirectory<T>(run: () => T): T {
  const previous = process.env.WEMAIL_DATA_DIR;
  delete process.env.WEMAIL_DATA_DIR;
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env.WEMAIL_DATA_DIR;
    else process.env.WEMAIL_DATA_DIR = previous;
  }
}

test("pending migration copies, verifies, switches and removes the old directory", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-data-directory-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const controlDir = path.join(root, "control");
  const source = path.join(root, "old-data");
  const target = path.join(root, "new-data");
  fs.mkdirSync(path.join(source, "attachments"), { recursive: true });
  ensureDataDirectoryMarker(source);
  fs.mkdirSync(controlDir, { recursive: true });
  fs.writeFileSync(path.join(source, "wemail.sqlite"), "database");
  fs.writeFileSync(path.join(source, "attachments", "invoice.pdf"), "pdf");
  fs.writeFileSync(path.join(controlDir, "data-location"), source);
  fs.writeFileSync(
    path.join(controlDir, "data-migration-pending.json"),
    JSON.stringify({ from: source, to: target, requestedAt: new Date().toISOString() }),
  );

  withoutManagedDataDirectory(() => applyPendingDataMigration(controlDir));

  assert.equal(fs.existsSync(source), false);
  assert.equal(fs.readFileSync(path.join(target, "wemail.sqlite"), "utf8"), "database");
  assert.equal(
    withoutManagedDataDirectory(() => resolveDataDirectory(controlDir)),
    target,
  );
  const result = JSON.parse(
    fs.readFileSync(path.join(controlDir, "data-migration-result.json"), "utf8"),
  ) as { status: string };
  assert.equal(result.status, "success");
});

test("migration keeps the original directory when the target is not empty", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-data-directory-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const controlDir = path.join(root, "control");
  const source = path.join(root, "old-data");
  const target = path.join(root, "occupied-target");
  fs.mkdirSync(source, { recursive: true });
  ensureDataDirectoryMarker(source);
  fs.mkdirSync(target, { recursive: true });
  fs.mkdirSync(controlDir, { recursive: true });
  fs.writeFileSync(path.join(source, "wemail.sqlite"), "database");
  fs.writeFileSync(path.join(target, "other.txt"), "do not touch");
  fs.writeFileSync(path.join(controlDir, "data-location"), source);
  fs.writeFileSync(
    path.join(controlDir, "data-migration-pending.json"),
    JSON.stringify({ from: source, to: target, requestedAt: new Date().toISOString() }),
  );

  withoutManagedDataDirectory(() => applyPendingDataMigration(controlDir));

  assert.equal(fs.readFileSync(path.join(source, "wemail.sqlite"), "utf8"), "database");
  assert.equal(fs.readFileSync(path.join(target, "other.txt"), "utf8"), "do not touch");
  assert.equal(fs.readFileSync(path.join(controlDir, "data-location"), "utf8"), source);
  const result = JSON.parse(
    fs.readFileSync(path.join(controlDir, "data-migration-result.json"), "utf8"),
  ) as { status: string };
  assert.equal(result.status, "failed");
});
