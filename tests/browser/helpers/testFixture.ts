// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Playwright test fixture for browser-based E2E tests.
 *
 * Extends the base `test` with:
 * - `apiBaseUrl` — the local Hono API server URL
 * - `dataDir` — the temp data directory (for assertions on files)
 * - `login()` — log in with the standard fixture account
 * - `syncMail()` — trigger a mail sync and wait
 */

import { test as base, expect } from "@playwright/test";
import { startTestServer, loginWithFixture, syncMail, type TestServer } from "./testServer.js";
import { injectDesktopApi } from "./mockDesktop.js";

type TestFixture = {
  apiBaseUrl: string;
  dataDir: string;
  login: () => Promise<void>;
  syncMailAction: () => Promise<void>;
};

let server: TestServer | null = null;

export const test = base.extend<TestFixture>({
  apiBaseUrl: async ({}, use) => {
    if (!server) {
      throw new Error("Test server not started. Use testWithServer() instead.");
    }
    await use(server.apiBaseUrl);
  },

  dataDir: async ({}, use) => {
    if (!server) {
      throw new Error("Test server not started. Use testWithServer() instead.");
    }
    await use(server.dataDir);
  },

  login: async ({ apiBaseUrl }, use) => {
    await use(async () => {
      await loginWithFixture(apiBaseUrl);
    });
  },

  syncMailAction: async ({ apiBaseUrl }, use) => {
    await use(async () => {
      await syncMail(apiBaseUrl);
    });
  },
});

export { expect };

/**
 * Create a test group with a shared server instance.
 *
 * Usage:
 * ```ts
 * const test = testWithServer({ inboxFixtures: ["mail-001-question.json"] });
 *
 * test("my test", async ({ page, apiBaseUrl }) => {
 *   injectDesktopApi(page, apiBaseUrl);
 *   await page.goto("/");
 * });
 * ```
 */
export function testWithServer(opts?: Parameters<typeof startTestServer>[0]) {
  const t = test.extend<TestFixture>({});

  t.beforeAll(async () => {
    server = await startTestServer(opts);
  });

  t.afterAll(async () => {
    if (server) {
      await server.close();
      server = null;
    }
  });

  return t;
}
