import { _electron as electron } from "playwright";

const executablePath = process.env.WEMAIL_ELECTRON_EXE;
if (!executablePath) throw new Error("WEMAIL_ELECTRON_EXE is required");

const app = await electron.launch({
  executablePath,
  cwd: process.cwd(),
  args: ["--no-sandbox", "dist-electron/electron/main/app.js"],
  env: {
    ...process.env,
    VITE_DEV_SERVER_URL: "http://127.0.0.1:5173",
    WEMAIL_DEV_TRACE: "1",
  },
  timeout: 60_000,
});

const report = {
  startedAt: new Date().toISOString(),
  desktopPid: app.process().pid,
  categories: [],
  mailOpens: [],
  longTasks: [],
  consoleErrors: [],
  pageErrors: [],
};

try {
  const page = await app.firstWindow({ timeout: 60_000 });
  page.setDefaultTimeout(30_000);
  page.on("console", (message) => {
    if (message.type() === "error") report.consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => report.pageErrors.push(error.message));
  await page.waitForLoadState("domcontentloaded");
  await page.locator("[data-testid='workbench']").waitFor({ state: "visible" });
  await page.locator("[data-testid='mail-item']").first().waitFor({ state: "visible" });
  await page.evaluate(() => {
    window.__wemailLiveLongTasks = [];
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        window.__wemailLiveLongTasks.push({
          startTime: entry.startTime,
          duration: entry.duration,
        });
      }
    }).observe({ type: "longtask", buffered: true });
  });

  const categoryLinks = page.locator("[data-folder^='category:']");
  const categoryCount = await categoryLinks.count();
  for (let index = 0; index < Math.min(categoryCount, 3); index += 1) {
    const link = categoryLinks.nth(index);
    const folder = await link.getAttribute("data-folder");
    const startedAt = performance.now();
    await link.click();
    await page.waitForFunction(
      (expected) => new URL(window.location.href).searchParams.get("category") === expected,
      folder?.slice("category:".length),
    );
    const routeMs = performance.now() - startedAt;
    await page.locator("[data-testid='mail-item']").first().waitFor({ state: "visible" });
    await page.waitForTimeout(50);
    report.categories.push({
      folder,
      routeMs: Math.round(routeMs),
      settledMs: Math.round(performance.now() - startedAt),
      visibleRows: await page.locator("[data-testid='mail-item']").count(),
    });
  }

  const rows = page.locator("[data-testid='mail-item']");
  const rowCount = await rows.count();
  for (let index = 0; index < Math.min(rowCount, 5); index += 1) {
    const row = rows.nth(index);
    const emailId = await row.getAttribute("data-id");
    const startedAt = performance.now();
    await row.click();
    await page.waitForFunction(
      (id) => document.querySelector("[data-testid='email-panel-shell']")?.getAttribute("data-email-id") === id,
      emailId,
    );
    const panelMs = performance.now() - startedAt;
    await page.locator(
      "[data-testid='email-body-content'], [data-testid='email-body-loading'], [data-testid='email-body-error']",
    ).first().waitFor({ state: "visible" });
    report.mailOpens.push({
      emailId,
      panelMs: Math.round(panelMs),
      settledMs: Math.round(performance.now() - startedAt),
      bodyContent: await page.locator("[data-testid='email-body-content']").isVisible().catch(() => false),
      bodyLoading: await page.locator("[data-testid='email-body-loading']").isVisible().catch(() => false),
      bodyError: await page.locator("[data-testid='email-body-error']").isVisible().catch(() => false),
    });
  }

  report.longTasks = await page.evaluate(() => window.__wemailLiveLongTasks ?? []);
  report.completedAt = new Date().toISOString();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  await app.close().catch(() => undefined);
}
