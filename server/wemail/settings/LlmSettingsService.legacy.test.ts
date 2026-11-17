import assert from "node:assert/strict";
import test from "node:test";
import type { MailDatabase } from "../database/Database.js";
import { openOrCreateMailDatabase } from "../database/Database.js";
import type { SecretStore } from "../security/SecretStore.js";
import { LlmSettingsService } from "./LlmSettingsService.js";

const main = "wemail:settings:llm:api-key";
const backup = "wemail:settings:llm:api-key:custom-backup";
const free = "wemail:settings:llm:api-key:free-trial";

function store(initial: Record<string, string>): SecretStore {
  const values = new Map(Object.entries(initial));
  return {
    getSecret: (key) => values.get(key),
    saveSecret: (key, value) => { values.set(key, value); },
    deleteSecret: (key) => { values.delete(key); },
    isEncryptionAvailable: () => true,
  };
}

test("legacy migration preserves an ambiguous backup", () => {
  const secrets = store({ [main]: "unknown", [backup]: "custom" });
  new LlmSettingsService({ db: {} as MailDatabase, secrets });
  assert.equal(secrets.getSecret(main), "unknown");
  assert.equal(secrets.getSecret(backup), "custom");
});

test("an ambiguous legacy key stays unavailable after saving other settings", () => {
  const db = openOrCreateMailDatabase(":memory:");
  const secrets = store({ [main]: "unknown", [backup]: "custom" });
  try {
    const service = new LlmSettingsService({ db, secrets });
    service.save({ provider: "openai", defaultModel: "old-model" });
    db.prepare("UPDATE llm_settings SET free_trial = 1 WHERE id = 'default'").run();
    assert.equal(service.get()?.hasApiKey, false);
    assert.equal(service.getRuntimeSettings(), null);
    service.save({ provider: "openai", defaultModel: "updated-model" });
    assert.equal(service.get()?.hasApiKey, false);
    assert.equal(service.getRuntimeSettings(), null);
    assert.equal(secrets.getSecret(backup), "custom");
  } finally { db.close(); }
});

test("legacy migration restores a backup over a known retired key", () => {
  const secrets = store({ [main]: "retired", [free]: "retired", [backup]: "custom" });
  new LlmSettingsService({ db: {} as MailDatabase, secrets });
  assert.equal(secrets.getSecret(main), "custom");
  assert.equal(secrets.getSecret(backup), undefined);
});

test("a failed secret write cannot make the retired key usable", () => {
  const db = openOrCreateMailDatabase(":memory:");
  const secrets = store({ [main]: "retired", [free]: "retired" });
  try {
    const service = new LlmSettingsService({ db, secrets });
    service.save({ provider: "openai", defaultModel: "old-model" });
    db.prepare("UPDATE llm_settings SET free_trial=1 WHERE id='default'").run();
    secrets.saveSecret = () => { throw new Error("secret-store-unavailable"); };
    assert.throws(
      () => service.save({ provider: "openai", defaultModel: "new-model", apiKey: "replacement" }),
      /secret-store-unavailable/,
    );
    assert.equal(service.getRuntimeSettings(), null);
    assert.equal(service.get()?.hasApiKey, false);
    assert.equal(service.get()?.defaultModel, "old-model");
  } finally {
    db.close();
  }
});

test("a known retired key is rejected even if its legacy flag was cleared", () => {
  const db = openOrCreateMailDatabase(":memory:");
  const secrets = store({ [main]: "retired", [free]: "retired" });
  try {
    const service = new LlmSettingsService({ db, secrets });
    service.save({ provider: "openai", defaultModel: "model" });
    assert.equal(service.get()?.hasApiKey, false);
    assert.equal(service.getRuntimeSettings(), null);
    service.save({ provider: "openai", defaultModel: "model", apiKey: "custom" });
    assert.equal(service.get()?.hasApiKey, true);
    assert.equal(service.getRuntimeSettings()?.apiKey, "custom");
  } finally { db.close(); }
});

test("a failed database write does not replace the key for the previous endpoint", () => {
  const db = openOrCreateMailDatabase(":memory:");
  const secrets = store({});
  try {
    const service = new LlmSettingsService({ db, secrets });
    service.save({ provider: "openai", defaultModel: "old-model", baseUrl: "https://old.example", apiKey: "old-key" });
    db.exec("CREATE TRIGGER reject_llm_update BEFORE UPDATE ON llm_settings BEGIN SELECT RAISE(ABORT, 'settings-write-failed'); END");
    assert.throws(
      () => service.save({ provider: "openai", defaultModel: "new-model", baseUrl: "https://new.example", apiKey: "new-key" }),
      /settings-write-failed/,
    );
    assert.equal(secrets.getSecret(main), "old-key");
    assert.equal(service.getRuntimeSettings()?.baseUrl, "https://old.example");
    assert.equal(service.getRuntimeSettings()?.apiKey, "old-key");
  } finally {
    db.close();
  }
});
