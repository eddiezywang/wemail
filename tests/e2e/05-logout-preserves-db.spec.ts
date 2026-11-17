// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Logout must not wipe local mail data ("退出登录不清理本地数据"): the
// canonical database row survives logout + app restart. The mock-inbox
// fixture is deleted before the re-open so a re-login cannot re-inject
// the message — any surviving row proves persistence.
import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { launchElectron, loginWithFixture } from "./helpers/electronApp";

test("logout preserves canonical mail across app re-open", async () => {
  const first = await launchElectron({
    rendererUrl: "http://127.0.0.1:14175/",
    inboxFixtures: ["mail-001-question.json"],
  });
  const dataDir = first.dataDir;
  try {
    const window = await first.electronApp.firstWindow();
    await loginWithFixture(first.apiBaseUrl);
    await expect(window.getByTestId("workbench")).toBeVisible();
    await expect.poll(() =>
      window.evaluate(async () =>
        (await window.wemailDesktop?.mailCore?.health())?.accountRuntime?.accountId ?? null,
      ),
    ).toBe("acct-e2e");
    const refresh = await window.evaluate(() =>
      window.wemailDesktop?.mailCore?.refreshMail("acct-e2e"),
    );
    expect(refresh?.status).toBe("queued");
    await expect(
      window.getByTestId("mail-item").filter({ hasText: "Quick question" }),
    ).toBeVisible({ timeout: 20_000 });
    await expect(window.getByTestId("mail-item")).toHaveCount(1);

    const out = await fetch(`${first.apiBaseUrl}/api/account/logout`, {
      method: "POST",
    });
    expect(out.ok).toBeTruthy();
  } finally {
    await first.close();
  }

  fs.rmSync(path.join(dataDir, "mock-inbox"), { recursive: true, force: true });

  const second = await launchElectron({
    reuseDataDir: dataDir,
    rendererUrl: "http://127.0.0.1:14175/",
  });
  try {
    const window = await second.electronApp.firstWindow();
    await loginWithFixture(second.apiBaseUrl);
    await expect(window.getByTestId("workbench")).toBeVisible();
    await expect.poll(() =>
      window.evaluate(async () =>
        (await window.wemailDesktop?.mailCore?.health())?.accountRuntime?.accountId ?? null,
      ),
    ).toBe("acct-e2e");
    const refresh = await window.evaluate(() =>
      window.wemailDesktop?.mailCore?.refreshMail("acct-e2e"),
    );
    expect(refresh?.status).toBe("queued");
    await expect(
      window.getByTestId("mail-item").filter({ hasText: "Quick question" }),
    ).toBeVisible({ timeout: 20_000 });
    await expect(window.getByTestId("mail-item")).toHaveCount(1);
  } finally {
    await second.close();
  }
});
