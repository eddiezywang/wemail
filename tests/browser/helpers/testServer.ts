// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Standalone Hono API server for browser-based E2E tests.
 *
 * Replaces the Electron-based `launchElectron()` harness. Starts a real
 * `composeApp()` + `createLocalApiApp()` pair with FileInjectedMailProvider
 * and a mock LLM server — no Electron process is launched.
 *
 * The shipped renderer reads mail through `window.wemailDesktop.mailDatabase`
 * (the Electron DB Service MessagePort lane), not through `/api/mail/*`.
 * A browser-only Playwright run has no such lane, so this harness provides
 * two test-only pieces:
 *   - an in-process `MailDatabaseClient` backed by the same SQLite handle
 *     the composition root uses (no Electron utility process, no user data
 *     directory), and
 *   - `/__e2e__/*` routes that let `mockDesktop.ts` proxy that client into
 *     the page and seed the `mock-inbox` fixtures.
 *
 * All of it lives under tests/; production code is untouched.
 */

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { composeApp, type AppComposition } from "../../../server/wemail/bootstrap/AppComposition.js";
import type { LlmProviderConfig } from "../../../server/wemail/bootstrap/composition/settings.js";
import { createLocalApiApp } from "../../../server/api/app.js";
import { closeNodeHttpServer } from "../../../server/api/close-node-http-server.js";
import { FileInjectedMailProvider } from "../../../server/wemail/mail/FileInjectedMailProvider.js";
import { McpListenerController } from "../../../server/wemail/mcp/McpListenerController.js";
import { openOrCreateMailDatabase, type MailDatabase } from "../../../server/wemail/database/Database.js";
import { MailDatabaseWriter } from "../../../server/wemail/database/MailDatabaseWriter.js";
import { MailDatabaseQueryRepository } from "../../../server/wemail/database/MailDatabaseQueryRepository.js";
import { FileSecretStore } from "../../../server/wemail/security/SecretStore.js";
import type { MailDatabaseClient } from "../../../server/wemail/database/MailDatabaseClient.js";
import {
  DEFAULT_BUSINESS_PREFERENCES,
  type BusinessPreferences,
  type BusinessPreferencesSnapshot,
} from "../../../shared/wemail/businessPreferences.js";
import { MAIL_DATABASE_PROTOCOL_VERSION } from "../../../shared/wemail/mailDatabaseProtocol.js";
import { MAIL_DATABASE_SCHEMA_VERSION } from "../../../server/wemail/database/Schema.generated.js";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");

export interface TestServer {
  apiBaseUrl: string;
  composition: AppComposition;
  dataDir: string;
  logsDir: string;
  mockLlmUrl: string;
  close: () => Promise<void>;
}

export interface TestServerOptions {
  /** Pre-populate `<dataDir>/mock-inbox/` with these JSON fixture filenames. */
  inboxFixtures?: string[];
  /**
   * Supply a responder for every LLM call. Return a string of JSON — it
   * is served verbatim as `choices[0].message.content`.
   */
  llmResponder?: (body: unknown) => string;
  /** Model ids returned by the mock OpenAI-compatible `/v1/models` endpoint. */
  llmModels?: string[];
  /** Reuse an existing data directory (e.g. for logout-preserves-db spec). */
  reuseDataDir?: string;
}

function makeTmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function copyFixturesInto(dir: string, sources: string[]) {
  const dest = path.join(dir, "mock-inbox");
  fs.mkdirSync(dest, { recursive: true });
  const fixtures = sources.map((src) => {
    const abs = path.isAbsolute(src)
      ? src
      : path.join(PROJECT_ROOT, "tests", "e2e", "fixtures", src);
    const message = JSON.parse(fs.readFileSync(abs, "utf8")) as {
      receivedAt?: string;
      sync?: { internalDate?: string };
    };
    return { abs, message };
  });
  const newestFixtureTime = Math.max(
    ...fixtures.map(({ message }) => Date.parse(message.receivedAt ?? "")),
  );
  const targetNewestTime = Date.now() - 60 * 60 * 1000;
  const timeShiftMs = Number.isFinite(newestFixtureTime)
    ? targetNewestTime - newestFixtureTime
    : 0;

  for (const { abs, message } of fixtures) {
    const receivedAt = Date.parse(message.receivedAt ?? "");
    if (Number.isFinite(receivedAt)) {
      message.receivedAt = new Date(receivedAt + timeShiftMs).toISOString();
    }
    const internalDate = Date.parse(message.sync?.internalDate ?? "");
    if (message.sync && Number.isFinite(internalDate)) {
      message.sync.internalDate = new Date(
        internalDate + timeShiftMs,
      ).toISOString();
    }
    fs.writeFileSync(
      path.join(dest, path.basename(abs)),
      `${JSON.stringify(message, null, 2)}\n`,
      "utf8",
    );
  }
}

/**
 * Start a local HTTP server that pretends to be an OpenAI-compatible
 * Chat Completions endpoint. Every call returns `responder(body)` as the
 * content of the first choice.
 */
async function startMockLlm(
  responder: TestServerOptions["llmResponder"],
  models: string[] = ["mock-model", "mock-model-alt"],
): Promise<{ url: string; close: () => Promise<void> }> {
  return await new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.method === "GET" && req.url === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          object: "list",
          data: models.map((id) => ({ id, object: "model", owned_by: "browser-test" })),
        }));
        return;
      }
      if (req.url !== "/v1/chat/completions") {
        res.writeHead(404);
        res.end();
        return;
      }
      let buf = "";
      req.on("data", (c: Buffer) => (buf += c));
      req.on("end", () => {
        let parsed: unknown = {};
        try {
          parsed = buf ? JSON.parse(buf) : {};
        } catch {
          // ignore — responder may still want to run
        }
        const content = responder ? responder(parsed) : "{}";
        const payload = {
          id: "mock-cmpl",
          object: "chat.completion",
          choices: [
            {
              index: 0,
              finish_reason: "stop",
              message: { role: "assistant", content },
            },
          ],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise<void>((r) => {
            server.close(() => r());
          }),
      });
    });
  });
}

/**
 * Built-in LLM responder that dispatches on the system prompt's text to
 * distinguish summary / tag / reply-draft calls.
 */
export function bundledLlmResponder(): (body: unknown) => string {
  const root = path.join(PROJECT_ROOT, "tests", "e2e", "fixtures", "llm-responses");
  const summary = fs.readFileSync(path.join(root, "summary.json"), "utf8");
  const tags = fs.readFileSync(path.join(root, "tags.json"), "utf8");
  const replyDecision = fs.readFileSync(
    path.join(root, "reply-decision.json"),
    "utf8",
  );
  const replyDraft = fs.readFileSync(path.join(root, "reply-draft.json"), "utf8");
  return (body: unknown) => {
    const b = body as { messages?: Array<{ role: string; content: string }> };
    const system = b.messages?.find((m) => m.role === "system")?.content ?? "";
    if (system.includes("summarization")) return summary;
    if (system.includes("tag")) return tags;
    if (system.includes("reply-decision")) return replyDecision;
    if (system.includes("reply-draft")) return replyDraft;
    return "{}";
  };
}

function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function readLlmFixture(name: string): Record<string, unknown> {
  return readJson(
    path.join(PROJECT_ROOT, "tests", "e2e", "fixtures", "llm-responses", name),
  ) as Record<string, unknown>;
}

/** Canned intelligence artifacts for a seeded fixture message. */
function seededArtifacts(): Record<string, Record<string, unknown>> {
  const summary = readLlmFixture("summary.json");
  const tags = readLlmFixture("tags.json");
  const decision = readLlmFixture("reply-decision.json");
  const draft = readLlmFixture("reply-draft.json");
  return {
    summary: {
      type: "summary",
      bullets: summary.bullets,
      actionItems: summary.actionItems,
      urgency: summary.urgency,
    },
    tags: {
      type: "tags",
      tags: (tags.tags as Array<Record<string, unknown>>).map((tag) => ({
        ...tag,
        tier: "auto",
      })),
    },
    replyDecision: {
      type: "replyDecision",
      shouldReply: decision.shouldReply,
      reason: decision.reason,
      confidence: decision.confidence,
      priorityScore: 0.8,
      level: "high",
      replyRequired: true,
    },
    replyDraft: {
      type: "replyDraft",
      draftMarkdown: draft.draftMarkdown,
      language: "en",
      // The detail panel renders QuickReplyChips only for results that carry
      // variants, so the canned draft ships one.
      variants: [
        { tone: "neutral", length: "medium", draftMarkdown: draft.draftMarkdown },
      ],
    },
  };
}

function pendingIntelligenceState(emailId: string): Record<string, unknown> {
  const pending = { status: "pending" };
  return {
    emailId,
    summary: pending,
    tags: pending,
    replyDecision: pending,
    replyDraft: pending,
    todoExtraction: { status: "skipped" },
    linkExtraction: { status: "skipped" },
  };
}

/**
 * In-process `MailDatabaseClient` for the browser-only harness.
 *
 * The composition root now requires this seam (`composeApp` throws without
 * it). The Electron app supplies a MessagePort producer into the DB Service;
 * here we reuse the canonical writer/query repositories against the very
 * same SQLite handle `composeApp` opens, so no Electron worker, real user
 * data directory, or second database is involved.
 */
class InProcessMailDatabase {
  readonly writer: MailDatabaseWriter;
  private readonly queries: MailDatabaseQueryRepository;
  private readonly listeners = new Set<(event: unknown) => void>();
  private preferences: BusinessPreferencesSnapshot = {
    stored: true,
    preferences: { ...DEFAULT_BUSINESS_PREFERENCES },
  };

  constructor(readonly db: MailDatabase) {
    this.writer = new MailDatabaseWriter(db, { replyDecisionEnabled: true });
    this.queries = new MailDatabaseQueryRepository(db);
  }

  asClient(): MailDatabaseClient {
    return this as unknown as MailDatabaseClient;
  }

  emitChange(): void {
    const event = { changes: [{ entityType: "message", entityPublicId: "*", operation: "update" }] };
    for (const listener of [...this.listeners]) listener(event);
  }

  commitVersion(): number {
    return this.queries.commitVersion();
  }

  async health() {
    return {
      protocolVersion: MAIL_DATABASE_PROTOCOL_VERSION,
      state: "ready",
      pid: process.pid,
      uptimeMs: 0,
      schemaVersion: MAIL_DATABASE_SCHEMA_VERSION,
      commitVersion: this.commitVersion(),
      lanes: [],
    };
  }

  async checkIntegrity() {
    return { valid: true, schemaVersion: MAIL_DATABASE_SCHEMA_VERSION };
  }

  async listAccounts() {
    return this.queries.listAccounts();
  }

  async configureAccount(params: unknown) {
    const result = this.writer.configureAccount(params as never);
    this.emitChange();
    return result;
  }

  async getMailSnapshot(id: string) {
    return this.queries.getSnapshot(id);
  }

  async getIntelligenceState(id: string) {
    try {
      return this.queries.getIntelligenceState(id);
    } catch {
      // The standalone Hono server has no Canonical AI worker pool. Fixture
      // messages get canned artifacts at seed time; anything else stays
      // pending rather than throwing a 500 into the renderer.
      return pendingIntelligenceState(id);
    }
  }

  async requestIntelligence(params: unknown) {
    return this.writer.requestIntelligence(params as never);
  }

  async listMail(params: unknown) {
    return this.queries.list(params as never);
  }

  async listFolders(accountId: string) {
    return this.queries.listFolders(accountId);
  }

  async listCategories(accountId: string) {
    return this.queries.listCategories(accountId);
  }

  async search(params: unknown) {
    return this.queries.search(params as never);
  }

  async mutateMail(params: unknown, idempotencyKey: string) {
    const result = this.writer.mutate({ ...(params as object), idempotencyKey } as never);
    this.emitChange();
    return result;
  }

  async saveDraft(params: unknown) {
    const result = this.writer.saveDraft(params as never);
    this.emitChange();
    return result;
  }

  async getDraft(params: { accountId: string; id: string }) {
    return this.queries.getDraft(params.accountId, params.id);
  }

  async listDrafts(params: { accountId: string; limit?: number }) {
    return this.queries.listDrafts(params.accountId, params.limit);
  }

  async listSnoozed(accountId: string) {
    return this.queries.listSnoozed(accountId);
  }

  async deleteDraft(params: { accountId: string; id: string }) {
    const result = this.writer.deleteDraft(params.accountId, params.id);
    this.emitChange();
    return result;
  }

  async setSnooze(params: unknown) {
    const result = this.writer.setSnooze(params as never);
    this.emitChange();
    return result;
  }

  async enqueueSend(params: unknown) {
    return this.writer.enqueueSend(params as never);
  }

  async listScheduled(accountId: string) {
    return this.queries.listScheduled(accountId);
  }

  async listScheduledPage(accountId: string, page?: number, limit?: number) {
    return this.queries.listScheduledPage(accountId, page ?? 1, limit ?? 50);
  }

  async cancelScheduled(accountId: string, id: string) {
    return this.writer.cancelScheduled(accountId, id);
  }

  async deleteScheduled(accountId: string, id: string) {
    return this.writer.deleteScheduled(accountId, id);
  }

  async getBusinessPreferences() {
    return this.preferences;
  }

  async saveBusinessPreferences(patch: Partial<BusinessPreferences>) {
    this.preferences = {
      stored: true,
      preferences: { ...this.preferences.preferences, ...patch },
    };
    this.emitChange();
    return {
      value: this.preferences.preferences,
      commitVersion: this.commitVersion(),
      changes: [{ entityType: "setting", entityPublicId: "business-preferences", operation: "update" }],
    };
  }

  async listPendingActions() {
    return [];
  }

  onChanged(listener: (event: unknown) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

/** Methods the browser bridge is allowed to call through `/__e2e__/db/:method`. */
const BRIDGE_METHODS = new Set([
  "health",
  "listAccounts",
  "getMailSnapshot",
  "getIntelligenceState",
  "requestIntelligence",
  "listMail",
  "listFolders",
  "listCategories",
  "search",
  "mutateMail",
  "saveDraft",
  "getDraft",
  "listDrafts",
  "listSnoozed",
  "deleteDraft",
  "setSnooze",
  "enqueueSend",
  "listScheduled",
  "listScheduledPage",
  "cancelScheduled",
  "deleteScheduled",
  "getBusinessPreferences",
  "saveBusinessPreferences",
  "listPendingActions",
]);

/** JSON replacer: SQLite rows can carry BigInt for numeric ids/counts. */
function jsonSafe(value: unknown): string {
  return JSON.stringify(value, (_key, entry) =>
    typeof entry === "bigint" ? Number(entry) : entry,
  );
}

/**
 * Seed `<dataDir>/mock-inbox/*.json` into the canonical SQLite schema and
 * attach canned AI artifacts. The browser-only harness has no Mail Core or
 * Canonical AI worker, so this stands in for the sync + intelligence path.
 */
function seedInbox(db: MailDatabase, client: InProcessMailDatabase, dataDir: string): string[] {
  const inboxDir = path.join(dataDir, "mock-inbox");
  if (!fs.existsSync(inboxDir)) return [];
  const files = fs.readdirSync(inboxDir).filter((name) => name.endsWith(".json")).sort();
  const messages = files.map((name) =>
    readJson(path.join(inboxDir, name)) as Record<string, unknown>,
  );
  if (messages.length === 0) return [];
  const accountId = String(messages[0].accountId);
  const persisted = client.writer.persistMetadata({
    accountId,
    origin: "manual",
    messages: messages as never,
  });
  const publicIds = [
    ...persisted.value.insertedIds,
    ...persisted.value.updatedIds,
  ];

  const artifacts = seededArtifacts();
  const now = Date.now();
  const insertArtifact = db.prepare(`
    INSERT INTO mail_ai_artifacts (
      public_id, account_id, scope_kind, message_id, thread_id,
      artifact_kind, source_content_sha256, source_version,
      processor_version, prompt_version, model_id, state, json_value,
      created_at_ms, completed_at_ms, row_version
    ) VALUES (?, ?, 'message', ?, NULL, ?, ?, ?, 'browser-e2e', 'browser-e2e',
              'mock-model', 'ready', ?, ?, ?, 1)
  `);
  const setCurrent = db.prepare(`
    INSERT INTO mail_message_ai_current (message_id, artifact_kind, artifact_id, row_version)
    VALUES (?, ?, ?, 1)
    ON CONFLICT(message_id, artifact_kind) DO UPDATE SET
      artifact_id = excluded.artifact_id, row_version = row_version + 1
  `);

  for (const publicId of publicIds) {
    const row = db.prepare(`
      SELECT messages.id, accounts.id AS account_id, content.content_version
      FROM mail_messages messages
      JOIN mail_accounts accounts ON accounts.id = messages.account_id
      LEFT JOIN mail_message_content content ON content.message_id = messages.id
      WHERE messages.public_id = ?
    `).get(publicId) as { id: bigint; account_id: bigint; content_version: bigint | null } | undefined;
    if (!row) continue;
    const bodyText = typeof (messages.find((m) => m.id === publicId) ?? {})["bodyText"] === "string"
      ? String((messages.find((m) => m.id === publicId) ?? {})["bodyText"])
      : publicId;
    const sha = createHash("sha256").update(bodyText).digest("hex");
    db.prepare(`
      UPDATE mail_message_content
      SET state = 'ready', content_sha256 = ?, byte_size = ?, text_plain = ?,
          fetched_at_ms = ?, row_version = row_version + 1
      WHERE message_id = ?
    `).run(sha, Buffer.byteLength(bodyText), bodyText, now, row.id);
    for (const [kind, result] of Object.entries(artifacts)) {
      const artifactPublicId = `browser-e2e:${randomUUID()}:${publicId}:${kind}`;
      const inserted = insertArtifact.run(
        artifactPublicId,
        row.account_id,
        row.id,
        kind,
        sha,
        Number(row.content_version ?? 0),
        jsonSafe(result),
        now,
        now,
      );
      setCurrent.run(row.id, kind, Number(inserted.lastInsertRowid));
    }
  }
  client.emitChange();
  return publicIds;
}

/**
 * Start a standalone Hono API server with FileInjectedMailProvider and
 * a mock LLM server. No Electron process is launched.
 */
export async function startTestServer(
  opts: TestServerOptions = {},
): Promise<TestServer> {
  const dataDir = opts.reuseDataDir ?? makeTmpDir("wemail-browser-e2e-");
  const logsDir = path.join(dataDir, "logs");
  fs.mkdirSync(logsDir, { recursive: true });

  if (opts.inboxFixtures?.length) {
    copyFixturesInto(dataDir, opts.inboxFixtures);
  }

  // Everything is created up front so teardown can close whatever exists
  // even if a later boot phase throws (see `close` below).
  const resources: {
    llm?: { close: () => Promise<void> };
    db?: MailDatabase;
    nodeServer?: { close: (cb: (e?: Error) => void) => unknown; closeIdleConnections?: () => void; closeAllConnections?: () => void };
    mcpController?: McpListenerController;
    composition?: AppComposition;
  } = {};

  const close = async () => {
    if (resources.nodeServer) await closeNodeHttpServer(resources.nodeServer);
    await resources.mcpController?.close();
    await resources.composition?.stop();
    // composition.stop() owns db.close(); only close it ourselves when the
    // composition never got far enough to take ownership.
    if (!resources.composition && resources.db) {
      try {
        resources.db.close();
      } catch {
        /* best-effort */
      }
    }
    await resources.llm?.close();
  };

  try {
    const llm = await startMockLlm(opts.llmResponder, opts.llmModels);
    resources.llm = llm;

    const llmConfig: LlmProviderConfig = {
      provider: "openai",
      apiKey: "test-key",
      baseUrl: llm.url,
      defaultModel: "mock-model",
    };

    const db = openOrCreateMailDatabase(path.join(dataDir, "wemail.sqlite"));
    resources.db = db;
    const client = new InProcessMailDatabase(db);

    const composition = await composeApp({
      dataDir,
      logsDir,
      database: db,
      mailDatabase: client.asClient(),
      llmConfig,
      overrides: {
        secretStore: new FileSecretStore({ baseDir: path.join(dataDir, "secrets") }),
        mailProviderFactory: () =>
          new FileInjectedMailProvider({ baseDir: dataDir }),
        // Short job timeout so tests don't hang the event loop on stop()
        queue: { jobTimeoutMs: 5_000, pollIntervalMs: 100 },
      },
    });
    resources.composition = composition;

    const mcpController = new McpListenerController(composition.mcp, composition.accountService);
    await mcpController.boot();
    resources.mcpController = mcpController;

    const app = createLocalApiApp({
      composition,
      imapVerifier: async () => {},
      mcpController,
    });

    // Test-only seams. The renderer page is served from the Vite preview
    // origin while `apiBaseUrl` is this Hono server, so the bridge needs
    // permissive CORS on its own sub-app.
    const testApp = new Hono();
    testApp.use("*", cors());
    testApp.post("/sync", (c) => {
      try {
        const ids = seedInbox(db, client, dataDir);
        return c.json({ ok: true, insertedIds: ids });
      } catch (error) {
        return c.json(
          { ok: false, error: error instanceof Error ? error.message : String(error) },
          500,
        );
      }
    });
    testApp.get("/version", (c) =>
      c.json({ ok: true, version: client.commitVersion() }),
    );
    testApp.post("/db/:method", async (c) => {
      const method = c.req.param("method");
      if (!BRIDGE_METHODS.has(method)) {
        return c.json({ ok: false, error: `unsupported db method: ${method}` }, 404);
      }
      let args: unknown[] = [];
      try {
        const parsed = await c.req.json();
        args = Array.isArray(parsed) ? parsed : [parsed];
      } catch {
        args = [];
      }
      try {
        const fn = (client as unknown as Record<string, unknown>)[method] as
          | ((...a: unknown[]) => unknown)
          | undefined;
        if (typeof fn !== "function") {
          return c.json({ ok: false, error: `unimplemented db method: ${method}` }, 500);
        }
        const value = await fn.apply(client, args);
        return new Response(jsonSafe({ ok: true, value }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      } catch (error) {
        return c.json(
          { ok: false, error: error instanceof Error ? error.message : String(error) },
          500,
        );
      }
    });
    app.route("/__e2e__", testApp);

    const nodeServer = serve({ fetch: app.fetch, port: 0 });
    resources.nodeServer = nodeServer;
    const address = nodeServer.address();
    const port = typeof address === "object" && address ? address.port : 0;

    return {
      apiBaseUrl: `http://127.0.0.1:${port}`,
      composition,
      dataDir,
      logsDir,
      mockLlmUrl: llm.url,
      close,
    };
  } catch (error) {
    await close().catch(() => undefined);
    throw error;
  }
}

/**
 * Helper: POST an account to `/api/account/login` with the bundled
 * fixture. Resolves to the saved account config.
 */
export async function loginWithFixture(
  apiBaseUrl: string,
): Promise<{ id: string }> {
  const fixture = JSON.parse(
    fs.readFileSync(
      path.join(PROJECT_ROOT, "tests", "e2e", "fixtures", "account.json"),
      "utf8",
    ),
  );
  const { secrets, ...config } = fixture;
  const res = await fetch(`${apiBaseUrl}/api/account/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ config, secrets }),
  });
  if (!res.ok) {
    throw new Error(`login failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()).account;
}

/**
 * Helper: seed the file-injected inbox fixtures into the test-only DB lane.
 *
 * `/api/mail/sync` is no longer part of the desktop API surface — mail
 * sync is driven by the Mail Core worker and the renderer reads through
 * `mailDatabase`. The browser harness seeds the same SQLite schema directly.
 */
export async function syncMail(apiBaseUrl: string): Promise<void> {
  const res = await fetch(`${apiBaseUrl}/__e2e__/sync`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  const body = (await res.json()) as { ok: boolean; error?: string };
  if (!res.ok || !body.ok) {
    throw new Error(`sync failed: ${res.status} ${body.error ?? "unknown error"}`);
  }
}

/**
 * Poll until `fn()` returns a non-null value.
 */
export async function waitFor<T>(
  fn: () => Promise<T | null | undefined>,
  opts: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const intervalMs = opts.intervalMs ?? 200;
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(
    `waitFor(${opts.label ?? "condition"}) timed out after ${timeoutMs}ms${
      lastErr ? `: ${(lastErr as Error).message}` : ""
    }`,
  );
}
