import assert from "node:assert/strict";
import test from "node:test";
import { openOrCreateMailDatabase } from "../database/Database.js";
import type { SecretStore } from "../security/SecretStore.js";
import { ChannelAuditRepository } from "./ChannelAuditRepository.js";
import { ChannelConnectionRepository } from "./ChannelConnectionRepository.js";
import { LangBotConnectionService } from "./LangBotConnectionService.js";

class MemorySecrets implements SecretStore {
  readonly values = new Map<string, string>();
  constructor(private readonly encrypted = true) {}
  saveSecret(key: string, value: string) {
    this.values.set(key, value);
  }
  getSecret(key: string) {
    return this.values.get(key);
  }
  deleteSecret(key: string) {
    this.values.delete(key);
  }
  isEncryptionAvailable() {
    return this.encrypted;
  }
}

test("connection service stores only refs, tests before enablement, rotates, and redacts", async () => {
  const db = openOrCreateMailDatabase(":memory:");
  const secrets = new MemorySecrets();
  const repository = new ChannelConnectionRepository(db);
  const service = new LangBotConnectionService(
    repository,
    secrets,
    new ChannelAuditRepository(db),
    {
      clientFactory: () => ({
        checkCompatibility: async () => ({
          compatible: true,
          profile: "langbot-service-api-v4.9",
          botCount: 1,
          checkedAt: new Date().toISOString(),
        }),
      }),
    },
  );
  const created = service.create({
    id: "connection-1",
    name: "Local",
    baseUrl: "http://127.0.0.1:5300",
    apiKey: "lbk_real_secret",
    trustMode: "loopback",
  });
  assert.equal(created.enabled, false);
  assert.doesNotMatch(JSON.stringify(created), /lbk_real_secret/);
  const raw = db
    .prepare("SELECT * FROM langbot_connections WHERE id = ?")
    .get("connection-1");
  assert.doesNotMatch(JSON.stringify(raw), /lbk_real_secret/);
  assert.throws(() => service.enable("connection-1"), /compatible-test-required/);
  await service.test("connection-1");
  assert.equal(service.enable("connection-1").enabled, true);
  assert.equal(service.rotateApiKey("connection-1", "new-secret").enabled, false);
  assert.equal(service.getApiKey("connection-1"), "new-secret");
  assert.equal(service.delete("connection-1"), true);
  assert.equal(secrets.values.size, 0);
});
