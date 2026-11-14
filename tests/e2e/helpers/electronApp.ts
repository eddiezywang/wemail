// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { _electron as electron, type ElectronApplication } from "@playwright/test";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface ElectronLaunch {
  electronApp: ElectronApplication;
  apiBaseUrl: string;
  dataDir: string;
  logsDir: string;
  mockLlmUrl: string | null;
  close: () => Promise<void>;
}

export interface LaunchOptions {
  /** When provided, pre-populates `<dataDir>/mock-inbox/` with these JSON files. */
  inboxFixtures?: string[];
  /** Reuse an existing data directory (e.g. for the logout-preserves-db spec). */
  reuseDataDir?: string;
  /**
   * Supply a responder for every LLM call. Return a string of JSON — it
   * is served verbatim as `choices[0].message.content`.
   */
  llmResponder?: (body: unknown) => string;
  /** Load the real renderer instead of the API-only data URL harness. */
  rendererUrl?: string;
}

const PROJECT_ROOT = path.resolve(__dirname, "..", "..", "..");
const ELECTRON_ENTRY = path.join(
  PROJECT_ROOT,
  "dist-electron",
  "electron",
  "main",
  "app.js",
);

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
 * content of the first choice. When `responder` is not supplied the
 * server serves an empty JSON object, which the intelligence processors
 * will reject as a parse error — safe and deterministic.
 */
async function startMockLlm(
  responder: LaunchOptions["llmResponder"],
): Promise<{ url: string; close: () => Promise<void> }> {
  return await new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.method === "GET" && req.url === "/v1/models") {
        // LLM probe / model discovery endpoint.
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          object: "list",
          data: [{ id: "mock-model", object: "model" }],
        }));
        return;
      }
      if (req.url !== "/v1/chat/completions") {
        res.writeHead(404);
        res.end();
        return;
      }
      let buf = "";
      req.on("data", (c) => (buf += c));
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
      const port =
        typeof addr === "object" && addr ? addr.port : 0;
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
 * Read the `WEMAIL_API_PORT=<n>` line that `electron/main/app.ts` emits
 * on stdout in E2E mode. We listen via Playwright's `process()` handle.
 */
async function waitForApiPort(
  electronApp: ElectronApplication,
): Promise<number> {
  const proc = electronApp.process();
  return await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("timeout waiting for WEMAIL_API_PORT from electron stdout"));
    }, 30_000);
    const onData = (chunk: Buffer | string) => {
      const text = chunk.toString();
      const match = /WEMAIL_API_PORT=(\d+)/.exec(text);
      if (match) {
        clearTimeout(timer);
        proc.stdout?.off("data", onData);
        resolve(Number(match[1]));
      }
    };
    proc.stdout?.on("data", onData);
  });
}

/**
 * Launch the packaged Electron main process with the file-backed mail
 * provider and a local LLM mock. The renderer URL is intentionally
 * absent — the hermetic suite drives the app through the local HTTP API.
 */
export async function launchElectron(
  opts: LaunchOptions = {},
): Promise<ElectronLaunch> {
  const dataDir = opts.reuseDataDir ?? makeTmpDir("wemail-e2e-data-");
  const logsDir = path.join(dataDir, "logs");
  fs.mkdirSync(logsDir, { recursive: true });
  if (opts.inboxFixtures?.length) {
    copyFixturesInto(dataDir, opts.inboxFixtures);
  }

  const llm = await startMockLlm(opts.llmResponder);

  const electronApp = await electron.launch({
    args: [ELECTRON_ENTRY],
    env: {
      ...process.env,
      WEMAIL_E2E_MODE: "1",
      WEMAIL_DATA_DIR: dataDir,
      WEMAIL_LLM_BASE_URL: llm.url,
      WEMAIL_LLM_MODEL: "mock-model",
      WEMAIL_LLM_API_KEY: "test-key",
      // Suppress the dev renderer URL. A data URL avoids Chromium's unsafe-port
      // blocking for port 1 and keeps Electron alive while API-only specs run.
      VITE_DEV_SERVER_URL:
        opts.rendererUrl ?? "data:text/html,<html><body>WeMail E2E harness</body></html>",
    },
    timeout: 30_000,
  });

  const runtimeLog = path.join(logsDir, "electron-runtime.log");
  electronApp.process().stdout?.on("data", (chunk) => fs.appendFileSync(runtimeLog, chunk));
  electronApp.process().stderr?.on("data", (chunk) => fs.appendFileSync(runtimeLog, chunk));
  const port = await waitForApiPort(electronApp);
  const apiBaseUrl = `http://127.0.0.1:${port}`;

  return {
    electronApp,
    apiBaseUrl,
    dataDir,
    logsDir,
    mockLlmUrl: llm.url,
    close: async () => {
      let closed = false;
      try {
        await Promise.race([
          electronApp.close().then(() => {
            closed = true;
          }),
          new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 5_000);
            timer.unref?.();
          }),
        ]);
      } catch {
        // best-effort
      }
      if (!closed) {
        const processId = electronApp.process().pid;
        if (process.platform === "win32" && processId) {
          spawnSync("taskkill", ["/pid", String(processId), "/T", "/F"], {
            windowsHide: true,
            stdio: "ignore",
          });
        } else {
          electronApp.process().kill("SIGKILL");
        }
      }
      await llm.close();
    },
  };
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
 * Built-in LLM responder that dispatches on the system prompt's text to
 * distinguish summary / tag / reply-draft calls. Returns the bundled
 * canned response JSON for each lane.
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
    const b = body as {
      messages?: Array<{ role: string; content: string }>;
    };
    const system = b.messages?.find((m) => m.role === "system")?.content ?? "";
    if (system.includes("summarization")) return summary;
    if (system.includes("tag")) return tags;
    if (system.includes("reply-decision")) return replyDecision;
    if (system.includes("reply-draft")) return replyDraft;
    return "{}";
  };
}

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
