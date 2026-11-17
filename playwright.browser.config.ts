// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { defineConfig } from "@playwright/test";

const browserExecutablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH;

/**
 * Playwright configuration for browser-based E2E tests.
 *
 * Unlike the Electron-based playwright.config.ts, this config drives a
 * standard Chromium browser against the freshly built production renderer + standalone
 * Hono API. No Electron process is launched.
 *
 * Each test suite starts its own Hono server via testWithServer() in
 * the fixture, so we only need to configure the webServer for the
 * Vite renderer.
 *
 * Browser cache: Set PLAYWRIGHT_BROWSERS_PATH to install browsers
 * outside the default C: drive location (e.g. .playwright-browsers/
 * in the repo root). The npm scripts set this automatically.
 */
export default defineConfig({
  testDir: "./tests/browser",
  timeout: 60_000,
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: [["html", { open: "never" }], ["list"]],
  use: {
    baseURL: "http://127.0.0.1:14173",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    launchOptions: browserExecutablePath
      ? { executablePath: browserExecutablePath }
      : undefined,
  },
  webServer: {
    command: "node scripts/serve-built-renderer.mjs --root . --port 14173",
    port: 14173,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
