// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { test, expect } from "@playwright/test";
import { startTestServer, loginWithFixture, type TestServer } from "./helpers/testServer.js";
import { injectDesktopApi } from "./helpers/mockDesktop.js";

let server: TestServer;

test.beforeAll(async () => {
  server = await startTestServer();
});

test.afterAll(async () => {
  await server?.close();
});

test("login flow: unauthenticated users see onboarding, then inbox after API login", async ({
  page,
}) => {
  injectDesktopApi(page, server.apiBaseUrl);

  // Without an account, the app redirects to /onboarding
  await page.goto("/");
  await page.waitForURL(/\/onboarding/, { timeout: 10_000 });

  // The two-repo split made onboarding picker-first: the credentials form
  // only appears after a provider preset is selected.
  await expect(
    page.getByRole("heading", { name: "选择邮箱服务商" }),
  ).toBeVisible({ timeout: 10_000 });

  // Login via API (simulating the onboarding form submission)
  const saved = await loginWithFixture(server.apiBaseUrl);
  expect(saved.id).toBe("acct-e2e");

  // Navigate to inbox — now the workbench should render
  await page.goto("/");
  await expect(page.locator("[data-testid='workbench']")).toBeVisible({
    timeout: 10_000,
  });

  // The sidebar should show the account display name
  await expect(page.getByTestId("sidebar-identity")).toContainText("E2E Tester", {
    timeout: 5_000,
  });

  // Verify the account is accessible via the API
  const accountRes = await fetch(`${server.apiBaseUrl}/api/account/current`);
  const accountJson = (await accountRes.json()) as {
    account: { id: string; emailAddress: string } | null;
  };
  expect(accountJson.account?.emailAddress).toBe("cqqdy@cqdly.us");
});
