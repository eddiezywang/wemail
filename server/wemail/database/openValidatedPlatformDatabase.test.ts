import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createMailDatabase } from "./Database.js";
import { MAIL_DATABASE_SCHEMA_VERSION } from "./Schema.generated.js";
import { openValidatedPlatformDatabase } from "./openValidatedPlatformDatabase.js";

test("platform opens an existing database only after the service validates it", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-platform-open-"));
  const databasePath = path.join(directory, "wemail.sqlite");
  createMailDatabase(databasePath).close();
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  let opened = false;
  const opening = openValidatedPlatformDatabase(databasePath, { checkIntegrity: async () => {
    await pending;
    return { valid: true, schemaVersion: MAIL_DATABASE_SCHEMA_VERSION };
  } }).then((db) => { opened = true; return db; });
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(opened, false);
    release();
    const db = await opening;
    assert.equal(db.prepare("SELECT 1").pluck().get(), 1);
    db.close();
  } finally {
    release();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("failed integrity validation does not create or migrate a platform database", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-platform-reject-"));
  const databasePath = path.join(directory, "wemail.sqlite");
  try {
    for (const result of [{ valid: false, schemaVersion: MAIL_DATABASE_SCHEMA_VERSION }, { valid: true, schemaVersion: 0 }]) {
      await assert.rejects(openValidatedPlatformDatabase(databasePath, { checkIntegrity: async () => result }), /integrity-check-failed/);
    }
    await assert.rejects(openValidatedPlatformDatabase(databasePath, { checkIntegrity: async () => { throw new Error("service-offline"); } }), /service-offline/);
    assert.equal(fs.existsSync(databasePath), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("platform rejects a schema mismatch even if the service reports a valid database", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-platform-schema-"));
  const databasePath = path.join(directory, "wemail.sqlite");
  const db = createMailDatabase(databasePath);
  db.exec("UPDATE db_meta SET value = '0' WHERE key = 'schema_version'");
  db.close();
  try {
    await assert.rejects(openValidatedPlatformDatabase(databasePath, {
      checkIntegrity: async () => ({ valid: true, schemaVersion: MAIL_DATABASE_SCHEMA_VERSION }),
    }), /schema-mismatch/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
