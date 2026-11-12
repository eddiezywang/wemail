import { expect, test } from "@playwright/test";
import { launchElectron, loginWithFixture } from "./helpers/electronApp";

test("unified Automation Center is reachable and shows built-in templates", async () => {
  const app = await launchElectron({ rendererUrl: "http://127.0.0.1:14175" });
  try {
    const window = await app.electronApp.firstWindow();
    await window.waitForLoadState("domcontentloaded");
    await loginWithFixture(app.apiBaseUrl);
    await window.reload();
    await window.waitForLoadState("domcontentloaded");

    await window.getByText("自动化", { exact: true }).first().click();
    await expect(window.getByTestId("automation-center")).toBeVisible({
      timeout: 20_000,
    });
    await expect(
      window.getByRole("heading", { name: "自动化", exact: true }),
    ).toBeVisible();
    await expect(window.getByText("推荐模板")).toBeVisible();
    await expect(window.getByText("邮箱速览")).toBeVisible();
    await expect(window.getByText("还没有自动化")).toBeVisible();

    await window.screenshot({
      path: "workspace/reports/electron-unified-automation-center.png",
    });
  } finally {
    await app.close();
  }
});
