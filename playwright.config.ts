// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { defineConfig } from "@playwright/test";

/**
 * Playwright configuration for the WeMail Electron E2E suite.
 *
 * The Electron harness lives in `tests/e2e/helpers/electronApp.ts`; the
 * config here only has to locate the specs and tune reporters. There is
 * no browser `use.*` config because the Playwright `_electron` driver
 * launches Chromium under Electron directly — the `chromium` browser
 * binary is not involved.
 */
export default defineConfig({
  testDir: "./tests/e2e",
  // Cold desktop boot forks the DB Service (7 worker lanes) and Mail Core
  // before the API port is advertised; a 2-core CI runner needs well over
  // the previous 60s for specs that relaunch the app (05 re-opens it).
  timeout: 180_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  outputDir: "test-results/",
  projects: [
    {
      name: "electron",
      testMatch: /.*\.spec\.ts$/,
    },
  ],
  webServer: {
    command: "node scripts/serve-built-renderer.mjs --root . --port 14175",
    port: 14175,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
