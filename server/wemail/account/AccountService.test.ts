import assert from "node:assert/strict";
import { test } from "node:test";
import type { AccountConfig } from "../../../shared/wemail/account.js";
import { AccountService } from "./AccountService.js";
import {
  createAccountServiceTestClient,
  createMutableSecretStore,
} from "./AccountService.test-support.js";
import { imapPasswordKey, smtpPasswordKey } from "./AccountTypes.js";

function makeConfig(overrides: Partial<AccountConfig> = {}): AccountConfig {
  const base: AccountConfig = {
    id: "acct-1",
    displayName: "Test User",
    emailAddress: "test@example.com",
    imap: { host: "imap.example.com", port: 993, secure: true, username: "test@example.com" },
    smtp: { host: "smtp.example.com", port: 587, secure: true, username: "test@example.com" },
    createdAt: "2026-04-23T00:00:00.000Z",
    updatedAt: "2026-04-23T00:00:00.000Z",
  };
  return {
    ...base,
    ...overrides,
    imap: { ...base.imap, ...(overrides.imap ?? {}) },
    smtp: { ...base.smtp, ...(overrides.smtp ?? {}) },
  };
}

function makeHarness() {
  const database = createAccountServiceTestClient();
  const secrets = createMutableSecretStore();
  const service = new AccountService({ mailDatabase: database.client, secrets });
  return { database, secrets, service };
}

test("AccountService saves credentials before committing the canonical account", async () => {
  const { database, secrets, service } = makeHarness();
  const configure = database.client.configureAccount.bind(database.client);
  let expectedImapPassword = "imap-pw";
  database.client.configureAccount = async (input, timeoutMs) => {
    assert.equal(secrets.getSecret(imapPasswordKey(input.account.id)), expectedImapPassword);
    return configure(input, timeoutMs);
  };
  const stored = await service.saveAccount({
    config: makeConfig(),
    secrets: { imapPassword: "imap-pw", smtpPassword: "smtp-pw" },
  });

  assert.equal(stored.id, "acct-1");
  assert.equal(stored.emailAddress, "test@example.com");
  const record = database.records()[0];
  assert.equal(record?.account.id, "acct-1");
  assert.equal(record?.credentialGeneration, 1);
  assert.equal(JSON.stringify(record).includes("imap-pw"), false);
  assert.equal(JSON.stringify(record).includes("smtp-pw"), false);
  assert.equal(secrets.getSecret(imapPasswordKey("acct-1")), "imap-pw");
  assert.equal(secrets.getSecret(smtpPasswordKey("acct-1")), "smtp-pw");

  expectedImapPassword = "imap-pw-rotated";
  await service.saveAccount({
    config: makeConfig(),
    secrets: { imapPassword: "imap-pw-rotated", smtpPassword: "smtp-pw-rotated" },
  });
  assert.equal(database.records()[0]?.credentialGeneration, 2);
});

test("AccountService reads its DB Service snapshot and updates it after commit", async () => {
  const { service } = makeHarness();
  assert.equal(service.getCurrentAccount(), null);
  await service.saveAccount({ config: makeConfig(), secrets: { imapPassword: "pw" } });
  assert.equal(service.getCurrentAccount()?.emailAddress, "test@example.com");
  const updated = await service.updateAccount({ displayName: "Renamed" });
  assert.equal(updated?.displayName, "Renamed");
});

test("AccountService logout deletes credentials but preserves the canonical account", async () => {
  const { database, secrets, service } = makeHarness();
  await service.saveAccount({
    config: makeConfig(),
    secrets: { imapPassword: "imap-pw", smtpPassword: "smtp-pw" },
  });
  service.logout();
  assert.equal(secrets.getSecret(imapPasswordKey("acct-1")), undefined);
  assert.equal(secrets.getSecret(smtpPasswordKey("acct-1")), undefined);
  assert.equal(database.records()[0]?.account.id, "acct-1");
});

test("AccountService treats the most recent account with credentials as current", async () => {
  const { service } = makeHarness();
  await service.saveAccount({
    config: makeConfig({ id: "acct-1", emailAddress: "first@example.com" }),
    secrets: { imapPassword: "first-pw" },
  });
  service.logout();
  await service.saveAccount({
    config: makeConfig({ id: "acct-2", emailAddress: "second@example.com" }),
    secrets: { imapPassword: "second-pw" },
  });
  assert.equal(service.getCurrentAccount()?.id, "acct-2");
});
