import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { launchElectron, loginWithFixture } from "./helpers/electronApp";

test("desktop launches the production renderer without a white screen", async () => {
  const app = await launchElectron({ rendererUrl: "http://127.0.0.1:14175" });
  try {
    const window = await app.electronApp.firstWindow();
    await window.waitForLoadState("domcontentloaded");
    await loginWithFixture(app.apiBaseUrl);
    await window.reload();
    await window.waitForLoadState("domcontentloaded");
    await expect(window.getByText("WeMail AI")).toBeVisible({ timeout: 20_000 });

    const visualHealth = await window.evaluate(() => {
      const body = document.body;
      const text = body.innerText.trim();
      const rect = body.getBoundingClientRect();
      const background = getComputedStyle(body).backgroundColor;
      return { textLength: text.length, width: rect.width, height: rect.height, background };
    });
    expect(visualHealth.textLength).toBeGreaterThan(20);
    expect(visualHealth.width).toBeGreaterThan(900);
    expect(visualHealth.height).toBeGreaterThan(600);
    expect(visualHealth.background).not.toBe("rgba(0, 0, 0, 0)");

    const bridge = await window.evaluate(() => ({
      platform: window.wemailDesktop?.platform,
      apiBaseUrl: window.wemailDesktop?.apiBaseUrl,
    }));
    expect(bridge.platform).toBe("win32");
    expect(bridge.apiBaseUrl).toBe(app.apiBaseUrl);

    const startupLog = fs.readFileSync(path.join(app.dataDir, "startup.log"), "utf8");
    expect(startupLog).toContain('"phase":"loadURL-done"');
    expect(startupLog).toContain('"phase":"ready"');
    expect(startupLog).not.toMatch(/loadURL-failed|createMainWindow-threw/);

    await window.screenshot({ path: "workspace/reports/electron-production-renderer-health.png" });
  } finally {
    await app.close();
  }
});
