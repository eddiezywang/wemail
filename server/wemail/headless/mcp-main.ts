#!/usr/bin/env node
/**
 * Headless wemail MCP server (dbx-style thin shell).
 *
 * Boots the same `composeApp()` graph the Electron desktop uses, then
 * serves ONLY the MCP streamable-HTTP listener — no renderer local API,
 * no curator ticker, no IMAP account runtime. Reads the same auth files
 * as the desktop (`<dataDir>/secrets/`, FileSecretStore) so one set of
 * credentials serves every shell.
 *
 * Environment (same conventions as the desktop):
 *   WEMAIL_DATA_DIR    data directory (default: ~/.wemail-mcp)
 *   WEMAIL_MCP_PORT    listener port   (default: 43129)
 *   WEMAIL_MCP_EMERGENCY_DISABLE=1  boot without the listener
 *
 * Usage:
 *   node dist-electron/server/wemail/headless/mcp-main.js [--data-dir D] [--port P]
 *
 * Configure an account by pointing `--data-dir` at a data directory the
 * desktop already logged into (or start the desktop once with the same
 * WEMAIL_DATA_DIR). MCP access tokens live in the shared database, so
 * tokens minted by the desktop work here unchanged.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { composeApp, type AppComposition } from "../bootstrap/AppComposition.js";
import { McpListenerController } from "../mcp/McpListenerController.js";
import { FileSecretStore } from "../security/SecretStore.js";
import { InProcessMailDatabaseClient } from "../database/InProcessMailDatabaseClient.js";
import { openOrCreateMailDatabase, type MailDatabase } from "../database/Database.js";
import { MailDatabaseWriter } from "../database/MailDatabaseWriter.js";
import { MailCoreAccountRuntime } from "../mail-core/MailCoreAccountRuntime.js";
import { imapPasswordKey, smtpPasswordKey } from "../account/AccountTypes.js";
import { fileURLToPath } from "node:url";

export interface HeadlessMcpOptions {
  dataDir: string;
  port: number;
}

export interface HeadlessMcpHandle {
  endpoint?: string;
  composition: AppComposition;
  close: () => Promise<void>;
}

export async function startHeadlessMcp(options: HeadlessMcpOptions): Promise<HeadlessMcpHandle> {
  const { dataDir } = options;
  const logsDir = path.join(dataDir, "logs");
  fs.mkdirSync(logsDir, { recursive: true });

  const db: MailDatabase = openOrCreateMailDatabase(path.join(dataDir, "wemail.sqlite"));
  const mailDatabase = new InProcessMailDatabaseClient(db);
  const secrets = new FileSecretStore({ baseDir: path.join(dataDir, "secrets") });

  const composition = await composeApp({
    dataDir,
    logsDir,
    mailDatabase: mailDatabase.asClient(),
    // The desktop opts into the same file-backed store (WEMAIL_SECRET_STORE
    // defaults to "file" now), so accounts and MCP tokens configured on the
    // desktop resolve identically here.
    overrides: {
      secretStore: secrets,
    },
  });

  // Mail Core account runtime: drains the outbox (real SMTP send) and syncs
  // IMAP inside this process via a worker_threads account worker — the same
  // worker the desktop's Mail Core utility process runs.
  let mailCore: MailCoreAccountRuntime | null = null;
  const currentAccount = composition.accountService.getCurrentAccount();
  if (currentAccount) {
    const imapKey = imapPasswordKey(currentAccount.id);
    const imapPassword = secrets.getSecret(imapKey);
    if (imapPassword) {
      const smtpPassword = secrets.getSecret(smtpPasswordKey(currentAccount.id));
      const generation = secrets.getSecretGeneration?.(imapKey) ?? 0;
      const entryPath = path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "../../../electron/mail-core/account-worker-entry.js",
      );
      const writer = mailDatabase.writer;
      const dbWriter = {
        enqueueJob: (input: Parameters<MailDatabaseWriter["enqueueJob"]>[0]) =>
          Promise.resolve(writer.enqueueJob(input)),
        claimJob: (owner: string, leaseMs?: number, filter?: unknown) =>
          Promise.resolve(writer.claimJob({ owner, leaseMs, filter } as never)),
        completeJob: (id: number, owner: string) =>
          Promise.resolve(writer.completeJob(id, owner)),
        failJob: (id: number, owner: string, error: string, retryDelayMs?: number) =>
          Promise.resolve(writer.failJob(id, owner, error, retryDelayMs)),
        terminalJob: (id: number, owner: string, error: string) =>
          Promise.resolve(writer.terminalJob(id, owner, error)),
        deferJob: (id: number, owner: string, reason: string, delayMs: number) =>
          Promise.resolve(writer.deferJob(id, owner, reason, delayMs)),
        claimSend: (owner: string, leaseMs?: number) =>
          Promise.resolve(writer.claimSend(currentAccount.id, owner, leaseMs)),
        completeSend: (input: Parameters<MailDatabaseWriter["completeSend"]>[0]) =>
          Promise.resolve(writer.completeSend(input)),
        failSend: (id: number, owner: string, error: string, retryDelayMs?: number) =>
          Promise.resolve(writer.failSend(id, owner, error, retryDelayMs)),
        // Remote operations (bot channels) are not part of the headless
        // deployment; claimOutbox always null keeps that branch unreachable.
        claimOutbox: () => Promise.resolve(null),
        failOutbox: () => Promise.resolve(false),
        nextMailDue: () => writer.nextMailDue(currentAccount.id),
        persistMailMetadata: (input: Parameters<MailDatabaseWriter["persistMetadata"]>[0]) =>
          Promise.resolve(writer.persistMetadata(input)),
        resolveRemoteOperation: async () => {
          throw new Error("remote operations are not supported in headless mode");
        },
        completeRemoteOperation: async () => {
          throw new Error("remote operations are not supported in headless mode");
        },
      };
      mailCore = new MailCoreAccountRuntime({
        entryPath,
        dataDir,
        accountId: currentAccount.id,
        credential: {
          version: 1,
          generation,
          account: currentAccount,
          imapPassword,
          ...(smtpPassword !== undefined ? { smtpPassword } : {}),
        },
        persistBody: async (message, job) => {
          const result = writer.persistBody({
            message,
            completedAt: new Date().toISOString(),
            jobId: job.id,
            jobOwner: job.owner,
          });
          return { jobCompleted: result.value.jobCompleted };
        },
        persistBodyFailure: async (failure) => {
          const inner = writer.failBody({
            accountId: failure.accountId,
            emailId: failure.emailId,
            errorCode: failure.errorCode,
            failedAt: failure.failedAt,
            ...(failure.retryAt !== undefined ? { retryAt: failure.retryAt } : {}),
            retryable: failure.retryable,
            jobId: failure.job.id,
            jobOwner: failure.job.owner,
          });
          return { attempts: inner.value.attempts, nextRetryAt: inner.value.nextRetryAt ?? "", jobCompleted: inner.value.jobCompleted };
        },
        dbWriter: dbWriter as never,
      });
      await mailCore.start();
      console.log(JSON.stringify({ phase: "wemail-mcp-mailcore-started", accountId: currentAccount.id }));
    } else {
      console.log(JSON.stringify({ phase: "wemail-mcp-no-mail-credentials" }));
    }
  }

  const controller = new McpListenerController(composition.mcp, composition.accountService, {
    // Headless has no per-account managed-credential vault; bearer tokens
    // from the shared database still gate every call.
    requireManagedCredential: false,
  });
  composition.mcp.settings.save({ enabled: true, port: options.port });
  await controller.boot();

  const endpoint = controller.view().listenerState === "listening"
    ? controller.view().endpoint
    : undefined;

  const close = async () => {
    await controller.close();
    if (mailCore) await mailCore.stop();
    await composition.stop();
    db.close();
  };
  return { endpoint, composition, close };
}

function parseArgs(argv: string[]): HeadlessMcpOptions {
  const options: HeadlessMcpOptions = {
    dataDir: process.env.WEMAIL_DATA_DIR ?? path.join(os.homedir(), ".wemail-mcp"),
    port: Number.parseInt(process.env.WEMAIL_MCP_PORT ?? "43129", 10),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--data-dir") options.dataDir = argv[++index];
    else if (argument === "--port") options.port = Number.parseInt(argv[++index], 10);
    else if (argument === "--help" || argument === "-h") {
      console.log("Usage: wemail-mcp [--data-dir <dir>] [--port <n>]");
      console.log("  WEMAIL_DATA_DIR / WEMAIL_MCP_PORT set the same values.");
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${argument}`);
      process.exit(2);
    }
  }
  if (!Number.isInteger(options.port) || options.port <= 0 || options.port > 65_535) {
    console.error(`Invalid port: ${options.port}`);
    process.exit(2);
  }
  return options;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const options = parseArgs(argv);
  const handle = await startHeadlessMcp(options);
  if (!handle.endpoint) {
    console.error("wemail-mcp: listener did not start (check for emergency disable or port conflicts).");
    await handle.close();
    process.exit(1);
  }
  console.log(JSON.stringify({ phase: "wemail-mcp-listening", endpoint: handle.endpoint, dataDir: options.dataDir }));

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    console.log(JSON.stringify({ phase: "wemail-mcp-shutdown", signal }));
    await handle.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  // Hold the event loop open: composition workers may all be idle between
  // polls, and an empty loop would exit the process silently.
  setInterval(() => {}, 60 * 60 * 1000);
}

if (process.argv[1] && path.resolve(process.argv[1]).endsWith("mcp-main.js")) {
  await main();
}
