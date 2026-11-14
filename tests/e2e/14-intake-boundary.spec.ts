// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Mail intake boundary regression: the file-injected provider must skip
// corrupt fixtures, deduplicate identical messages, and survive refresh
// calls for unknown accounts — the real account runtime stays intact.
import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { launchElectron, loginWithFixture } from "./helpers/electronApp";

const PRISTINE = "mail-001-question.json";

test("intake boundaries: corrupt fixtures, duplicates, unknown accounts", async () => {
  test.setTimeout(150_000);
  const app = await launchElectron({
    rendererUrl: "http://127.0.0.1:14175/",
    inboxFixtures: [PRISTINE],
  });
  const inboxDir = path.join(app.dataDir, "mock-inbox");
  try {
    const window = await app.electronApp.firstWindow();
    await loginWithFixture(app.apiBaseUrl);
    await expect(window.getByTestId("workbench")).toBeVisible();
    await expect.poll(() =>
      window.evaluate(async () =>
        (await window.wemailDesktop?.mailCore?.health())?.accountRuntime?.accountId ?? null,
      ),
    ).toBe("acct-e2e");
    const refresh = () =>
      window.evaluate(() => window.wemailDesktop?.mailCore?.refreshMail("acct-e2e"));
    expect((await refresh())?.status).toBe("queued");
    await expect(
      window.getByTestId("mail-item").filter({ hasText: "Quick question" }),
    ).toBeVisible({ timeout: 20_000 });
    await expect(window.getByTestId("mail-item")).toHaveCount(1);

    // 1. Corrupt JSON + valid-JSON-invalid-message fixtures are skipped.
    fs.writeFileSync(path.join(inboxDir, "broken.json"), "not-json{{{");
    fs.writeFileSync(path.join(inboxDir, "empty.json"), "{}");
    expect((await refresh())?.status).toBe("queued");
    await expect(window.getByTestId("mail-item")).toHaveCount(1, { timeout: 15_000 });
    await expect
      .poll(() =>
        window.evaluate(async () =>
          (await window.wemailDesktop?.mailCore?.health())?.accountRuntime?.accountId ?? null,
        ),
      )
      .toBe("acct-e2e");

    // 2. The same message injected under a second filename deduplicates.
    const pristine = fs.readFileSync(path.join(inboxDir, "mail-001-question.json"), "utf8");
    fs.writeFileSync(path.join(inboxDir, "duplicate-copy.json"), pristine);
    expect((await refresh())?.status).toBe("queued");
    await expect(window.getByTestId("mail-item")).toHaveCount(1, { timeout: 15_000 });

    // 3. refreshMail for an unknown account must not disturb the real one.
    const ghost = await window.evaluate(() =>
      window.wemailDesktop?.mailCore?.refreshMail("acct-ghost"),
    );
    expect(["queued", "error", "account-unavailable", null, undefined]).toContain(
      ghost === undefined ? undefined : ghost.status,
    );
    await expect.poll(() =>
      window.evaluate(async () =>
        (await window.wemailDesktop?.mailCore?.health())?.accountRuntime?.accountId ?? null,
      ),
    ).toBe("acct-e2e");
    await expect(window.getByTestId("mail-item")).toHaveCount(1);

    // 4. Cleanup of the hostile fixtures, then one more healthy cycle.
    fs.rmSync(path.join(inboxDir, "broken.json"), { force: true });
    fs.rmSync(path.join(inboxDir, "empty.json"), { force: true });
    fs.rmSync(path.join(inboxDir, "duplicate-copy.json"), { force: true });
    expect((await refresh())?.status).toBe("queued");
    await expect(window.getByTestId("mail-item")).toHaveCount(1, { timeout: 15_000 });
  } finally {
    await app.close();
  }
});
