// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { test, expect } from "@playwright/test";
import {
  startTestServer,
  loginWithFixture,
  syncMail,
  bundledLlmResponder,
  type TestServer,
} from "./helpers/testServer.js";
import { injectDesktopApi } from "./helpers/mockDesktop.js";

let server: TestServer;

test.beforeAll(async () => {
  server = await startTestServer({
    inboxFixtures: ["mail-001-question.json"],
    llmResponder: bundledLlmResponder(),
  });
});

test.afterAll(async () => {
  await server?.close();
});

test("sync → list shows email → click opens detail → summary card appears", async ({
  page,
}) => {
  injectDesktopApi(page, server.apiBaseUrl);

  // Login and sync
  await loginWithFixture(server.apiBaseUrl);
  await syncMail(server.apiBaseUrl);

  // Navigate to inbox
  await page.goto("/");
  await expect(page.locator("[data-testid='workbench']")).toBeVisible({
    timeout: 10_000,
  });

  // The email should appear in the list
  await expect(
    page.locator("[data-testid='mail-item']", { hasText: "Quick question" })
  ).toBeVisible({ timeout: 10_000 });

  // Click the mail item to open the detail panel
  await page.locator("[data-testid='mail-item']", { hasText: "Quick question" }).first().click();

  // Detail should show the email subject header
  await expect(
    page.getByRole("heading", { name: "Quick question about the launch" }),
  ).toBeVisible({ timeout: 5_000 });

  // Wait for the intelligence pipeline to produce a summary
  const summaryCard = page.locator("[data-testid='wemail-intelligence-card']");
  await expect(summaryCard).toBeVisible({ timeout: 25_000 });

  // Verify the summary contains at least one bullet from the mock LLM
  await expect(
    summaryCard.getByText("Alice asks when the launch is", { exact: true }),
  ).toBeVisible();
});
