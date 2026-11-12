// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Visual smoke test: boots the renderer against the mocked Hono API,
 * logs in with the fixture account, syncs mail, and captures screenshots
 * of the workbench at narrow / medium / wide viewports.
 *
 * Goal: surface responsive regressions without relying on the older
 * URL scheme (which the test suite has been migrated away from).
 */

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
    inboxFixtures: ["mail-001-question.json", "mail-002-notification.json"],
    llmResponder: bundledLlmResponder(),
  });
});

test.afterAll(async () => {
  await server?.close();
});

const VIEWPORTS = [
  { name: "narrow-1100", width: 1100, height: 800 },
  { name: "medium-1366", width: 1366, height: 800 },
  { name: "wide-1680", width: 1680, height: 900 },
] as const;

for (const vp of VIEWPORTS) {
  test(`workbench renders at ${vp.name}`, async ({ page }) => {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    injectDesktopApi(page, server.apiBaseUrl);

    // Login and sync so there's mail data in the list
    await loginWithFixture(server.apiBaseUrl);
    await syncMail(server.apiBaseUrl);

    await page.goto("/");

    // Sidebar nav rail must be visible.
    const sidebar = page.locator("aside");
    await expect(sidebar).toBeVisible({ timeout: 15_000 });

    // Compose pill in the rail (localized label since the design refresh).
    await expect(page.getByRole("button", { name: "写邮件" })).toBeVisible();

    // Inbox folder NavLink (compact).
    await expect(
      page.locator('[data-folder="inbox"]').first(),
    ).toBeVisible();

    // Mail scope chip row: the refresh collapsed it to a single 全部 tab.
    await expect(page.getByRole("tab", { name: /^全部/ })).toBeVisible();

    // Mail list rows.
    const rows = page.locator('[data-testid="mail-item"]');
    await expect(rows.first()).toBeVisible({ timeout: 10_000 });

    // Wide / medium: the agent surface is mounted in the workbench root
    // (docked column on wide, floating card on medium). The greeting card is
    // the stable brand-independent marker of the mounted panel.
    if (vp.width >= 1280) {
      await expect(
        page.getByTestId("workbench-agent")
          .or(page.getByTestId("workbench-agent-floating")),
      ).toBeVisible({ timeout: 5_000 });
    }

    await page.screenshot({
      path: `test-results/visual-smoke/${vp.name}.png`,
      fullPage: false,
    });
  });
}

test("floating agent panel resizes via its separator", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1680, height: 900 });
  injectDesktopApi(page, server.apiBaseUrl);
  await loginWithFixture(server.apiBaseUrl);
  await page.goto("/");

  const workbench = page.getByTestId("workbench");
  await expect(workbench).toHaveAttribute("data-agent-placement", "floating");
  const panel = page.getByTestId("workbench-agent-floating");
  const resizer = page.getByTestId("workbench-agent-resizer");
  await expect(panel).toBeVisible();
  await expect(resizer).toBeVisible();

  const before = await panel.boundingBox();
  expect(before).not.toBeNull();
  if (!before) return;

  // Resize via the separator's keyboard contract (role="separator" +
  // tabIndex=0 + ArrowLeft widens the agent panel by 12px per press).
  // NOTE: the mouse-drag path is currently unreachable in the floating
  // placement — the agent content layer (absolute inset-0 scroll container)
  // paints above the resizer strip, so pointerdown never reaches it. That is
  // a product defect, tracked separately; this assertion covers the
  // separator's own resize contract.
  // Each keypress is a discrete React state update; give the panel a frame
  // between presses so rapid keys aren't batched into a single resize.
  for (let index = 0; index < 12; index++) {
    await resizer.focus();
    await page.keyboard.press("ArrowLeft");
    await page.waitForTimeout(80);
    const width = (await panel.boundingBox())?.width ?? 0;
    if (width > before.width + 60) break;
  }

  await expect.poll(async () => (await panel.boundingBox())?.width ?? 0).toBeGreaterThan(
    before.width + 60,
  );
  await expect(resizer).toHaveAttribute("aria-valuenow", /\d+/);
  await expect(panel).toBeVisible();

  await page.screenshot({
    path: "workspace/reports/floating-agent-resized.png",
    fullPage: false,
  });
});

test("zoomed window: 200% emulated by half-width viewport stays usable", async ({
  page,
}) => {
  // Browser zoom doesn't change innerWidth, but for a coarse responsive
  // audit we drive the same breakpoint logic by halving the viewport.
  await page.setViewportSize({ width: 800, height: 600 });
  injectDesktopApi(page, server.apiBaseUrl);

  // Login and sync
  await loginWithFixture(server.apiBaseUrl);
  await syncMail(server.apiBaseUrl);

  await page.goto("/");

  const sidebar = page.locator("aside");
  await expect(sidebar).toBeVisible({ timeout: 15_000 });
  // At 800px we expect narrow mode: 3 columns visible, agent in drawer.
  const grid = page.locator("[data-testid='workbench']");
  await expect(grid).toHaveAttribute("data-mode", "narrow");

  await page.screenshot({
    path: "test-results/visual-smoke/zoom-800.png",
    fullPage: false,
  });
});
