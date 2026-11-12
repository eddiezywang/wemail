import { expect, test } from "@playwright/test";
import {
  launchElectron,
  loginWithFixture,
} from "./helpers/electronApp";

test("canonical DB Service keeps cached detail clicks responsive", async () => {
  const app = await launchElectron({
    rendererUrl: "http://127.0.0.1:14175/",
    inboxFixtures: [
      "mail-001-question.json",
      "mail-002-notification.json",
    ],
  });
  try {
    const window = await app.electronApp.firstWindow();
    await window.waitForLoadState("domcontentloaded");
    await loginWithFixture(app.apiBaseUrl);
    await expect(window.locator("[data-testid='workbench']")).toBeVisible();
    await expect.poll(
      () => window.evaluate(async () => {
        const health = await window.wemailDesktop?.mailCore?.health();
        return health?.accountRuntime?.accountId ?? null;
      }),
      { timeout: 10_000 },
    ).toBe("acct-e2e");
    const refresh = await window.evaluate(() =>
      window.wemailDesktop?.mailCore?.refreshMail("acct-e2e"),
    );
    expect(refresh?.status).toBe("queued");

    const questionRow = window.locator("[data-testid='mail-item']", {
      hasText: "Quick question",
    }).first();
    const digestRow = window.locator("[data-testid='mail-item']", {
      hasText: "Weekly digest",
    }).first();
    await expect(questionRow).toBeVisible({ timeout: 15_000 });
    await expect(digestRow).toBeVisible({ timeout: 15_000 });

    const open = async (row: typeof questionRow, subject: string) => {
      const startedAt = performance.now();
      await row.click();
      await expect(window.getByRole("heading", { name: subject })).toBeVisible({
        timeout: 2_000,
      });
      return performance.now() - startedAt;
    };

    // Warm both Detail Reader/cache paths before collecting cached-click data.
    await open(questionRow, "Quick question about the launch");
    await open(digestRow, "Weekly digest");

    const samples: number[] = [];
    for (let index = 0; index < 20; index += 1) {
      samples.push(index % 2 === 0
        ? await open(questionRow, "Quick question about the launch")
        : await open(digestRow, "Weekly digest"));
    }
    const ordered = [...samples].sort((left, right) => left - right);
    const p50 = ordered[Math.ceil(ordered.length * 0.5) - 1];
    const p95 = ordered[Math.ceil(ordered.length * 0.95) - 1];
    console.log(JSON.stringify({
      metric: "cached-click-to-detail-visible",
      sampleCount: samples.length,
      p50Ms: Math.round(p50),
      p95Ms: Math.round(p95),
      maxMs: Math.round(ordered.at(-1) ?? 0),
    }));
    expect(p95).toBeLessThan(300);

    // A stale detail must not win after the user immediately selects another row.
    await questionRow.click();
    const rapidStartedAt = performance.now();
    await digestRow.click();
    await expect(window.getByRole("heading", { name: "Weekly digest" })).toBeVisible({
      timeout: 2_000,
    });
    expect(performance.now() - rapidStartedAt).toBeLessThan(500);
  } finally {
    await app.close();
  }
});
