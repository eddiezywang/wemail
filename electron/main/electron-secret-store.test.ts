import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { ElectronSecretStore } from "./electron-secret-store.js";

const encryption = {
  isEncryptionAvailable: () => true,
  encryptString: (value: string) =>
    Buffer.from(`encrypted:${Buffer.from(value).toString("base64")}`),
  decryptString: (value: Buffer) =>
    Buffer.from(
      value.toString().replace(/^encrypted:/, ""),
      "base64",
    ).toString(),
};

test("ElectronSecretStore encrypts, persists, rotates, and deletes secrets", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-secret-store-"));
  const store = new ElectronSecretStore(dir, encryption);
  store.saveSecret("wemail:langbot:c1:api-key", "lbk_actual_secret");
  expect(
    new ElectronSecretStore(dir, encryption).getSecret(
      "wemail:langbot:c1:api-key",
    ),
  ).toBe("lbk_actual_secret");
  const raw = fs.readFileSync(
    path.join(dir, "encrypted-secrets.json"),
    "utf8",
  );
  expect(raw).not.toMatch(/lbk_actual_secret/);
  store.saveSecret("wemail:langbot:c1:api-key", "rotated");
  expect(store.getSecret("wemail:langbot:c1:api-key")).toBe("rotated");
  store.deleteSecret("wemail:langbot:c1:api-key");
  expect(store.getSecret("wemail:langbot:c1:api-key")).toBeUndefined();
});

test("ElectronSecretStore rejects writes when safe encryption is unavailable", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-secret-store-"));
  const store = new ElectronSecretStore(dir, {
    ...encryption,
    isEncryptionAvailable: () => false,
  });
  expect(store.isEncryptionAvailable()).toBe(false);
  expect(() => store.saveSecret("key", "value")).toThrow(
    /encrypted-secret-store-unavailable/,
  );
});

test("ElectronSecretStore quarantines malformed state without blocking startup", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-secret-store-"));
  fs.writeFileSync(path.join(dir, "encrypted-secrets.json"), "not-json");
  const store = new ElectronSecretStore(dir, encryption);

  expect(store.getSecret("wemail:settings:llm:api-key")).toBeUndefined();
  expect(
    fs.readdirSync(dir).some((name) =>
      name.startsWith("encrypted-secrets.json.corrupt."),
    ),
  ).toBe(true);
  expect(() => store.saveSecret("new-key", "new-value")).not.toThrow();
});

test("ElectronSecretStore quarantines undecryptable entries without blocking startup", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-secret-store-"));
  fs.writeFileSync(
    path.join(dir, "encrypted-secrets.json"),
    JSON.stringify({
      version: 1,
      entries: {
        broken: "Y2lwaGVydGV4dA==",
        healthy: encryption.encryptString("still-readable").toString("base64"),
      },
    }),
  );
  const store = new ElectronSecretStore(dir, {
    ...encryption,
    decryptString: (value) => {
      if (value.toString() === "ciphertext") throw new Error("decrypt-failed");
      return encryption.decryptString(value);
    },
  });

  expect(store.getSecret("broken")).toBeUndefined();
  expect(store.getSecret("healthy")).toBe("still-readable");
  const active = JSON.parse(
    fs.readFileSync(path.join(dir, "encrypted-secrets.json"), "utf8"),
  ) as { entries: Record<string, string> };
  expect(active.entries.broken).toBeUndefined();
  expect(active.entries.healthy).toBeDefined();
  expect(
    fs.readdirSync(dir).some((name) =>
      name.startsWith("encrypted-secrets.json.corrupt."),
    ),
  ).toBe(true);
});

test("migrateElectronSecretsToFile carries envelope generations into the file store", async () => {
  const { migrateElectronSecretsToFile } = await import("./electron-secret-store.js");
  const { FileSecretStore } = await import("../../server/wemail/security/SecretStore.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-migrate-gen-"));
  const encryption = {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`enc:${value}`),
    decryptString: (value: Buffer) => value.toString().replace(/^enc:/, ""),
  };
  const safeStore = new ElectronSecretStore(dir, encryption);
  safeStore.saveSecret("imap:key", "pw1");
  safeStore.saveSecret("imap:key", "pw2"); // generation 2

  migrateElectronSecretsToFile(dir, encryption);

  const fileStore = new FileSecretStore({ baseDir: dir });
  expect(fileStore.getSecret("imap:key")).toBe("pw2");
  // A flattened generation (e.g. 1) makes Mail Core reject the account
  // with stale-credential-generation; the envelope's generation must ride
  // along with the value.
  expect(fileStore.getSecretGeneration("imap:key")).toBe(2);
});

test("restoreMigratedSecretGenerations repairs flattened generations from the migrated backup", async () => {
  const { restoreMigratedSecretGenerations } = await import("./electron-secret-store.js");
  const { FileSecretStore } = await import("../../server/wemail/security/SecretStore.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-repair-gen-"));
  fs.writeFileSync(
    path.join(dir, "secret-generations.json"),
    JSON.stringify({ "imap:key": 1 }),
  );
  fs.writeFileSync(
    path.join(dir, "encrypted-secrets.json.migrated.1795536716566"),
    JSON.stringify({
      version: 1,
      entries: { "imap:key": "enc:pw" },
      generations: { "imap:key": 3, "smtp:key": 3 },
    }),
  );

  restoreMigratedSecretGenerations(dir);

  const fileStore = new FileSecretStore({ baseDir: dir });
  expect(fileStore.getSecretGeneration("imap:key")).toBe(3);
  expect(fileStore.getSecretGeneration("smtp:key")).toBe(3);
  // Idempotent: re-running never lowers or grows the generation.
  restoreMigratedSecretGenerations(dir);
  expect(fileStore.getSecretGeneration("imap:key")).toBe(3);
});

test("migrateElectronSecretsToFile copies the envelope into the file store", async () => {
  const { migrateElectronSecretsToFile } = await import("./electron-secret-store.js");
  const { FileSecretStore } = await import("../../server/wemail/security/SecretStore.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-migrate-"));
  const encryption = {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`enc:${value}`),
    decryptString: (value: Buffer) => value.toString().replace(/^enc:/, ""),
  };
  const safeStore = new ElectronSecretStore(dir, encryption);
  safeStore.saveSecret("imap:key", "imap-pw");
  safeStore.saveSecret("smtp:key", "smtp-pw");

  migrateElectronSecretsToFile(dir, encryption);

  const fileStore = new FileSecretStore({ baseDir: dir });
  expect(fileStore.getSecret("imap:key")).toBe("imap-pw");
  expect(fileStore.getSecret("smtp:key")).toBe("smtp-pw");
  expect(fileStore.getSecretGeneration("imap:key")).toBeGreaterThan(0);
  // Envelope is kept aside for manual recovery, not deleted.
  expect(fs.readdirSync(dir).some((name) => name.startsWith("encrypted-secrets.json.migrated."))).toBe(true);
  // Migrating twice must not double-apply or fail.
  migrateElectronSecretsToFile(dir, encryption);
  expect(fileStore.getSecret("imap:key")).toBe("imap-pw");
});
