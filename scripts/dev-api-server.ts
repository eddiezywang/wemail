// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Standalone Hono API server for renderer-only dev (`npm run dev:web`).
 *
 * Mirrors what `electron/main/local-api.ts` does inside Electron, but
 * binds to a fixed port (3001 by default) so the Vite dev server's
 * `/api/*` proxy can forward to it. Use `dev:desktop` instead when you
 * need the full Electron shell — that path runs its own composition on
 * an ephemeral port and bypasses this script entirely.
 */

import fs from "node:fs";
import path from "node:path";
import { startLocalApiServer } from "../server/api/app.js";
import {
  composeApp,
  type LlmProviderConfig,
} from "../server/wemail/bootstrap/AppComposition.js";
import { enableSystemCertificateAuthorities } from "../server/wemail/security/SystemCa.js";
import { McpListenerController } from "../server/wemail/mcp/McpListenerController.js";

const DEFAULT_PORT = 3001;

function readLlmConfig(): LlmProviderConfig | undefined {
  const baseUrl = process.env.WEMAIL_LLM_BASE_URL;
  if (!baseUrl) return undefined;
  return {
    provider: "openai",
    apiKey: process.env.WEMAIL_LLM_API_KEY ?? "test-key",
    baseUrl,
    defaultModel: process.env.WEMAIL_LLM_MODEL ?? "mock-model",
  };
}

async function main() {
  enableSystemCertificateAuthorities();
  const port = Number(process.env.WEMAIL_DEV_API_PORT ?? DEFAULT_PORT);
  const dataDir =
    process.env.WEMAIL_DATA_DIR ?? path.join(process.cwd(), ".wemail");
  const logsDir = path.join(dataDir, "logs");

  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(logsDir, { recursive: true });

  console.log(`[dev-api-server] booting (dataDir=${dataDir}, port=${port})…`);
  const composition = await composeApp({
    dataDir,
    logsDir,
    llmConfig: readLlmConfig(),
  });
  const mcpController = new McpListenerController(composition.mcp, composition.accountService);
  await mcpController.boot();
  const server = await startLocalApiServer({ port, composition, mcpController });
  // Vite proxies browser requests without rewriting Origin. Keep this in sync
  // with dev:renderer; custom renderer URLs must be explicitly configured.
  server.setRendererOrigin(process.env.VITE_DEV_SERVER_URL?.trim() || "http://127.0.0.1:5173");

  console.log(
    `[dev-api-server] listening on http://127.0.0.1:${server.port}`,
  );

  const shutdown = async (signal: string) => {
    console.log(`[dev-api-server] received ${signal}, shutting down…`);
    try {
      await server.close();
      await mcpController.close();
      await composition.stop();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("[dev-api-server] fatal:", err);
  process.exit(1);
});
