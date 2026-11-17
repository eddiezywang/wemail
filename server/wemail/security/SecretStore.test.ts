import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { FileSecretStore } from "./SecretStore.js";

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "wemail-secret-"));
}

test("SecretStore round-trips saveSecret / getSecret", () => {
  const dir = makeTempDir();
  const store = new FileSecretStore({ baseDir: dir });
  store.saveSecret("wemail:account:a1:imap-password", "s3cret!");
  assert.equal(store.getSecret("wemail:account:a1:imap-password"), "s3cret!");
});

test("SecretStore deleteSecret causes getSecret to return undefined", () => {
  const dir = makeTempDir();
  const store = new FileSecretStore({ baseDir: dir });
  store.saveSecret("k", "v");
  store.deleteSecret("k");
  assert.equal(store.getSecret("k"), undefined);
});

test("SecretStore getSecret returns undefined for missing key", () => {
  const dir = makeTempDir();
  const store = new FileSecretStore({ baseDir: dir });
  assert.equal(store.getSecret("never-set"), undefined);
});

test("SecretStore does not write plaintext secret value to backing file", () => {
  const dir = makeTempDir();
  const store = new FileSecretStore({ baseDir: dir });
  const plaintext = "plaintext-password-XYZZY-12345";
  store.saveSecret("k", plaintext);
  const raw = fs.readFileSync(path.join(dir, "secrets.json"), "utf8");
  assert.ok(
    !raw.includes(plaintext),
    "backing file must not contain plaintext secret",
  );
});

test("SecretStore persists across instances against the same baseDir", () => {
  const dir = makeTempDir();
  const a = new FileSecretStore({ baseDir: dir });
  a.saveSecret("k", "v");
  const b = new FileSecretStore({ baseDir: dir });
  assert.equal(b.getSecret("k"), "v");
});

test("SecretStore overwrite: save same key twice, second value wins", () => {
  const dir = makeTempDir();
  const store = new FileSecretStore({ baseDir: dir });
  store.saveSecret("k", "first");
  store.saveSecret("k", "second");
  assert.equal(store.getSecret("k"), "second");
  // And the overwrite persists across instances — no torn file.
  const reopened = new FileSecretStore({ baseDir: dir });
  assert.equal(reopened.getSecret("k"), "second");
});

test("SecretStore recovers from corrupt JSON by quarantining the bad file", () => {
  const dir = makeTempDir();
  const filePath = path.join(dir, "secrets.json");
  // Pre-seed an invalid file (header + non-JSON body).
  fs.writeFileSync(filePath, "# wemail secret placeholder store\n{not valid json\n");

  const logs: string[] = [];
  const store = new FileSecretStore({
    baseDir: dir,
    logger: (m) => logs.push(m),
  });
  // Reads return empty, writes proceed against a fresh file.
  assert.equal(store.getSecret("anything"), undefined);
  store.saveSecret("k", "v");
  assert.equal(store.getSecret("k"), "v");

  // A *.corrupt.<ts> sibling was created.
  const entries = fs.readdirSync(dir);
  const quarantined = entries.filter((e) => e.startsWith("secrets.json.corrupt."));
  assert.equal(quarantined.length, 1, "expected exactly one quarantined file");
  assert.ok(
    logs.some((l) => l.includes("WARN") && l.includes("corrupt")),
    "expected WARN log about corruption",
  );
});

test("SecretStore never logs secret values through its logger seam", () => {
  const dir = makeTempDir();
  const logs: string[] = [];
  const store = new FileSecretStore({
    baseDir: dir,
    logger: (msg) => logs.push(msg),
  });
  const plaintext = "unique-secret-leak-check-ABC";
  store.saveSecret("k", plaintext);
  store.getSecret("k");
  store.deleteSecret("k");
  for (const line of logs) {
    assert.ok(!line.includes(plaintext), "logger must not receive secret");
  }
});
