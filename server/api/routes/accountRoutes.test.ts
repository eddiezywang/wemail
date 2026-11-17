import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import type { AccountConfig } from "../../../shared/wemail/account.js";
import { AccountService } from "../../wemail/account/AccountService.js";
import {
  createAccountServiceTestClient,
  createMutableSecretStore,
} from "../../wemail/account/AccountService.test-support.js";
import {
  imapPasswordKey,
  smtpPasswordKey,
} from "../../wemail/account/AccountTypes.js";
import type { MailSyncErrorLogEntry } from "../../wemail/telemetry/MailSyncErrorLog.js";
import { buildAccountRoutes } from "./accountRoutes.js";

function makeApp(options: Parameters<typeof buildAccountRoutes>[0] extends infer T
  ? Partial<T extends object ? T : never>
  : never = {}) {
  const database = createAccountServiceTestClient();
  const secrets = createMutableSecretStore();
  const service = new AccountService({ mailDatabase: database.client, secrets });
  const app = new Hono();
  app.route("/api/account", buildAccountRoutes({ service, ...options }));
  return { app, service, database, secrets };
}

function sampleConfig(): AccountConfig {
  return {
    id: "acct-r1",
    displayName: "Route User",
    emailAddress: "route@example.com",
    imap: { host: "imap.example.com", port: 993, secure: true, username: "route@example.com" },
    smtp: { host: "smtp.example.com", port: 587, secure: true, username: "route@example.com" },
    createdAt: "2026-04-23T00:00:00.000Z",
    updatedAt: "2026-04-23T00:00:00.000Z",
  };
}

test("GET /api/account/current returns null when nothing saved", async () => {
  const { app } = makeApp();
  const res = await app.request("/api/account/current");
  assert.equal(res.status, 200);
  const body = (await res.json()) as { account: unknown };
  assert.equal(body.account, null);
});

test("POST /api/account/login stores config and secrets, never echoes password", async () => {
  const { app, secrets } = makeApp();
  const res = await app.request("/api/account/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      config: sampleConfig(),
      secrets: { imapPassword: "p@ss-1", smtpPassword: "p@ss-2" },
    }),
  });
  assert.equal(res.status, 200);
  const raw = await res.text();
  assert.ok(!raw.includes("p@ss-1"), "response must not contain imap password");
  assert.ok(!raw.includes("p@ss-2"), "response must not contain smtp password");
  const body = JSON.parse(raw) as { ok: boolean; account: AccountConfig };
  assert.equal(body.ok, true);
  assert.equal(body.account.id, "acct-r1");
  assert.equal(secrets.getSecret(imapPasswordKey("acct-r1")), "p@ss-1");
  assert.equal(secrets.getSecret(smtpPasswordKey("acct-r1")), "p@ss-2");
});

test("POST /api/account/login verifies IMAP before saving account credentials", async () => {
  const logs: Array<{ event: string; fields?: Record<string, unknown> }> = [];
  const syncErrors: MailSyncErrorLogEntry[] = [];
  const { app, database, secrets } = makeApp({
    imapVerifier: async () => {
      const error = new Error("imap.login: Command failed status=NO response=LOGIN user in black list");
      error.name = "MailProviderCommandError";
      throw error;
    },
    logger: {
      error: (event, fields) => logs.push({ event, fields }),
    },
    syncErrorLog: {
      filePath: "D:\\logs\\mail-sync-errors.log",
      record: (entry) => syncErrors.push(entry),
    },
    errorIdFactory: () => "err-login-1",
  });

  const res = await app.request("/api/account/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      config: sampleConfig(),
      secrets: { imapPassword: "bad-imap", smtpPassword: "bad-smtp" },
    }),
  });

  assert.equal(res.status, 401);
  const raw = await res.text();
  assert.ok(!raw.includes("bad-imap"));
  assert.ok(!raw.includes("bad-smtp"));
  const body = JSON.parse(raw) as {
    ok: boolean;
    error: string;
    errorId: string;
    stage: string;
    detail: string;
    providerMessage: string;
    logFile: string;
    code: string;
  };
  assert.equal(body.ok, false);
  assert.equal(body.errorId, "err-login-1");
  assert.equal(body.stage, "imap.login");
  assert.equal(body.code, "MAIL_CREDENTIAL_INVALID");
  assert.equal(body.providerMessage, "LOGIN user in black list");
  assert.match(body.error, /163|IMAP|LOGIN user in black list|邮箱服务器拒绝登录/);
  assert.equal(body.logFile, "D:\\logs\\mail-sync-errors.log");
  assert.equal(database.records().length, 0);
  assert.equal(secrets.getSecret(imapPasswordKey("acct-r1")), undefined);
  assert.equal(secrets.getSecret(smtpPasswordKey("acct-r1")), undefined);
  assert.equal(logs[0]?.event, "account.imap.verify.failed");
  assert.equal(syncErrors[0]?.errorId, "err-login-1");
});

test("POST /api/account/login times out a stalled IMAP verifier before saving account credentials", async () => {
  const { app, database, secrets } = makeApp({
    imapVerifierTimeoutMs: 5,
    imapVerifier: async () => new Promise<void>(() => {}),
    errorIdFactory: () => "err-login-timeout-1",
  });

  const res = await app.request("/api/account/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      config: sampleConfig(),
      secrets: { imapPassword: "slow-imap", smtpPassword: "slow-smtp" },
    }),
  });

  assert.equal(res.status, 503);
  const raw = await res.text();
  assert.ok(!raw.includes("slow-imap"));
  assert.ok(!raw.includes("slow-smtp"));
  const body = JSON.parse(raw) as {
    ok: boolean;
    error: string;
    errorId: string;
    stage: string;
    detail: string;
  };
  assert.equal(body.ok, false);
  assert.equal(body.errorId, "err-login-timeout-1");
  assert.equal(body.stage, "imap.login");
  assert.match(body.error, /超时|无法建立邮箱连接/);
  assert.equal(database.records().length, 0);
  assert.equal(secrets.getSecret(imapPasswordKey("acct-r1")), undefined);
  assert.equal(secrets.getSecret(smtpPasswordKey("acct-r1")), undefined);
});

test("POST /api/account/login reports TLS connection failures separately from rejected login", async () => {
  const { app } = makeApp({
    imapVerifier: async () => {
      const error = new Error(
        "imap.login: Client network socket disconnected before secure TLS connection was established code=ECONNRESET",
      );
      error.name = "MailProviderCommandError";
      throw error;
    },
    errorIdFactory: () => "err-tls-1",
  });

  const res = await app.request("/api/account/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      config: sampleConfig(),
      secrets: { imapPassword: "pw", smtpPassword: "pw2" },
    }),
  });

  assert.equal(res.status, 503);
  const body = (await res.json()) as {
    ok: boolean;
    error: string;
    errorId: string;
    providerMessage: string;
    code?: string;
  };
  assert.equal(body.ok, false);
  assert.equal(body.errorId, "err-tls-1");
  assert.match(body.error, /无法建立邮箱安全连接/);
  assert.doesNotMatch(body.error, /拒绝登录/);
  assert.match(body.providerMessage, /ECONNRESET/);
  assert.equal(body.code, undefined);
});

test("POST /api/account/login rejects payload missing imapPassword", async () => {
  const { app } = makeApp();
  const res = await app.request("/api/account/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ config: sampleConfig(), secrets: {} }),
  });
  assert.equal(res.status, 400);
  const body = (await res.json()) as { ok: boolean; error: string; field: string };
  assert.equal(body.ok, false);
  assert.equal(body.field, "secrets.imapPassword");
});

test("POST /api/account/login accepts a well-formed payload", async () => {
  const { app } = makeApp();
  const res = await app.request("/api/account/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      config: sampleConfig(),
      secrets: { imapPassword: "pw", smtpPassword: "pw2" },
    }),
  });
  assert.equal(res.status, 200);
});

test("POST /api/account/login rejects malformed port", async () => {
  const { app } = makeApp();
  const config = sampleConfig();
  (config.imap as unknown as { port: unknown }).port = 70000; // out of [1,65535]
  const res = await app.request("/api/account/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      config,
      secrets: { imapPassword: "pw", smtpPassword: "pw2" },
    }),
  });
  assert.equal(res.status, 400);
  const body = (await res.json()) as { ok: boolean; field: string };
  assert.equal(body.field, "config.imap.port");
});

test("GET /api/account/current returns the saved account after login", async () => {
  const { app } = makeApp();
  await app.request("/api/account/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      config: sampleConfig(),
      secrets: { imapPassword: "pw", smtpPassword: "pw2" },
    }),
  });
  const res = await app.request("/api/account/current");
  const body = (await res.json()) as { account: AccountConfig | null };
  assert.ok(body.account);
  assert.equal(body.account!.emailAddress, "route@example.com");
});

test("PATCH /api/account/current updates the active sender display name", async () => {
  const { app, database } = makeApp();
  await app.request("/api/account/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      config: sampleConfig(),
      secrets: { imapPassword: "pw", smtpPassword: "pw2" },
    }),
  });

  const res = await app.request("/api/account/current", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ displayName: "  新发件人  " }),
  });

  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean; account: AccountConfig };
  assert.equal(body.ok, true);
  assert.equal(body.account.displayName, "新发件人");
  assert.equal(database.records()[0]?.account.displayName, "新发件人");
});

test("PATCH /api/account/current rejects an empty sender display name", async () => {
  const { app } = makeApp();
  const res = await app.request("/api/account/current", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ displayName: "   " }),
  });
  assert.equal(res.status, 400);
  assert.equal(((await res.json()) as { field: string }).field, "displayName");
});

test("POST /api/account/login reuses the existing account id for the same email", async () => {
  const { app, database, secrets } = makeApp();
  await app.request("/api/account/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      config: sampleConfig(),
      secrets: { imapPassword: "old", smtpPassword: "old-smtp" },
    }),
  });

  const next = sampleConfig();
  next.id = "acct-new-client-id";
  next.displayName = "Updated Route User";
  const res = await app.request("/api/account/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      config: next,
      secrets: { imapPassword: "new", smtpPassword: "new-smtp" },
    }),
  });

  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean; account: AccountConfig };
  assert.equal(body.ok, true);
  assert.equal(body.account.id, "acct-r1");
  assert.equal(body.account.displayName, "Updated Route User");
  assert.equal(secrets.getSecret(imapPasswordKey("acct-r1")), "new");
  assert.equal(secrets.getSecret(smtpPasswordKey("acct-r1")), "new-smtp");
  assert.equal(
    database.records().filter((record) => record.account.emailAddress === "route@example.com").length,
    1,
  );
});

test("POST /api/account/logout deletes secrets but preserves account row", async () => {
  const { app, database, secrets } = makeApp();
  await app.request("/api/account/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      config: sampleConfig(),
      secrets: { imapPassword: "pw", smtpPassword: "pw2" },
    }),
  });

  const res = await app.request("/api/account/logout", { method: "POST" });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean };
  assert.equal(body.ok, true);

  assert.equal(secrets.getSecret(imapPasswordKey("acct-r1")), undefined);
  assert.equal(secrets.getSecret(smtpPasswordKey("acct-r1")), undefined);
  assert.equal(database.records()[0]?.account.id, "acct-r1");
});

test("GET /api/account/current returns null after logout even when account row remains", async () => {
  const { app } = makeApp();
  await app.request("/api/account/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      config: sampleConfig(),
      secrets: { imapPassword: "pw", smtpPassword: "pw2" },
    }),
  });
  await app.request("/api/account/logout", { method: "POST" });

  const res = await app.request("/api/account/current");
  assert.equal(res.status, 200);
  const body = (await res.json()) as { account: AccountConfig | null };

  assert.equal(body.account, null);
});
