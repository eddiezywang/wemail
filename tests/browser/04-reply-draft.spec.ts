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

test("reply draft lands in the detail panel quick-reply chips and prefills a compose", async ({
  page,
}) => {
  injectDesktopApi(page, server.apiBaseUrl);

  // Login and seed the inbox
  await loginWithFixture(server.apiBaseUrl);
  await syncMail(server.apiBaseUrl);

  // Navigate to inbox and click the email
  await page.goto("/");
  await expect(
    page.locator("[data-testid='mail-item']", { hasText: "Quick question" })
  ).toBeVisible({ timeout: 10_000 });
  await page.locator("[data-testid='mail-item']", { hasText: "Quick question" }).first().click();

  // The canned reply draft ships one variant, so the detail panel renders the
  // quick-reply surface (the SmartDraftPanel component was retired from the
  // product shell).
  const chips = page.locator("[data-testid='wemail-quick-reply-chips']");
  await expect(chips).toBeVisible({ timeout: 20_000 });
  await expect(chips.getByText("Launch is confirmed for 2026-05-01.")).toBeVisible();

  // Accepting hands the draft to the composer (TipTap body, not a textarea).
  await page.locator("[data-testid='wemail-quick-reply-accept']").click();
  const composeBody = page.locator("[data-testid='compose-window']");
  await expect(composeBody).toBeVisible({ timeout: 10_000 });
  await expect(composeBody.locator(".ProseMirror")).toContainText(
    "Launch is confirmed for 2026-05-01.",
    { timeout: 10_000 },
  );

  // The seeded message stays queryable through the desktop DB bridge
  // (the legacy `/api/mail/messages` HTTP surface was removed with the
  // two-repo split; mail reads go through `mailDatabase`).
  const listRes = await fetch(`${server.apiBaseUrl}/__e2e__/db/listMail`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify([{ accountId: "acct-e2e", folder: "INBOX" }]),
  });
  expect(listRes.ok).toBeTruthy();
  const listJson = (await listRes.json()) as {
    value: { messages: Array<{ id: string; subject: string }> };
  };
  expect(listJson.value.messages.length).toBe(1);
  expect(listJson.value.messages[0].subject).toContain("Quick question");
});
