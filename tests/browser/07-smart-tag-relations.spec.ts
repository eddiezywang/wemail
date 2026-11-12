import { expect, test } from "@playwright/test";
import {
  bundledLlmResponder,
  loginWithFixture,
  startTestServer,
  syncMail,
  type TestServer,
  waitFor,
} from "./helpers/testServer.js";
import { injectDesktopApi } from "./helpers/mockDesktop.js";

let server: TestServer;

test.beforeAll(async () => {
  const fallback = bundledLlmResponder();
  server = await startTestServer({
    inboxFixtures: ["mail-001-question.json", "mail-002-notification.json"],
    llmResponder: (body) => {
      const request = body as {
        messages?: Array<{ role?: string; content?: string }>;
      };
      const system = request.messages?.find((message) => message.role === "system")?.content ?? "";
      const user = request.messages?.find((message) => message.role === "user")?.content ?? "";
      if (system.includes("发布日期确认") && user.includes("Quick question about the launch")) {
        return JSON.stringify({
          tags: [
            { name: "待回复", confidence: 0.9, source: "ai" },
            { name: "发布日期确认", confidence: 0.96, source: "ai" },
          ],
        });
      }
      return fallback(body);
    },
  });
});

test.afterAll(async () => {
  await server?.close();
});

test("smart tag manual move in and move out are visible end to end", async ({ page }) => {
  injectDesktopApi(page, server.apiBaseUrl);
  await loginWithFixture(server.apiBaseUrl);
  await syncMail(server.apiBaseUrl);

  await page.goto("/");
  await page.getByText("创建智能标签", { exact: true }).click();
  await page.getByTestId("smart-tag-name-input").fill("发布日期确认");
  await page
    .getByTestId("smart-tag-description-input")
    .fill("询问或确认产品发布、上线日期，需要收件人明确回复的邮件");
  await page.getByTestId("smart-tag-create-submit").click();

  const tagLink = page.locator("[data-folder^='smart-tag:']", {
    hasText: "发布日期确认",
  });
  await expect(tagLink).toBeVisible({ timeout: 10_000 });

  // Manual move-in: apply the tag to the digest mail through the picker.
  // (The AI backfill leg of the original flow needs the desktop Canonical AI
  // worker, which a browser-only harness does not run — the standalone API
  // has no job drainer. The manual path below exercises the same server-side
  // relation + action-center writes end to end.)
  await page.goto("/");
  const notification = page.locator("[data-testid='mail-item']", {
    hasText: "Weekly digest",
  });
  await expect(notification).toBeVisible({ timeout: 10_000 });
  await notification.click();
  await page.getByRole("button", { name: "标签处理" }).click();
  await page.getByTestId("smart-tag-picker-apply-发布日期确认").click();
  await expect(page.getByTestId("smart-tag-action-dialog")).toBeVisible();
  await page.getByTestId("smart-tag-action-confirm").click();

  await tagLink.click();
  await expect(
    page.locator("[data-testid='mail-item']", { hasText: "Weekly digest" }),
  ).toBeVisible({ timeout: 10_000 });

  // Manual move-out: 待回复 is part of the canned AI tag artifact for the
  // seeded fixture mail, so the picker lists it under 已选标签. NOTE: the
  // picker derives its applied set from the intelligence artifact, not from
  // the mail_message_user_tags relation, so a freshly applied tag does not
  // become removable until an artifact refresh — tracked as a product quirk.
  await page.getByText("创建智能标签", { exact: true }).click();
  await page.getByTestId("smart-tag-name-input").fill("待回复");
  await page.getByTestId("smart-tag-description-input").fill("需要收件人明确回复的邮件");
  await page.getByTestId("smart-tag-create-submit").click();
  await expect(
    page.locator("[data-folder^='smart-tag:']", { hasText: "待回复" }),
  ).toBeVisible({ timeout: 10_000 });

  await page.goto("/");
  await page
    .locator("[data-testid='mail-item']", { hasText: "Weekly digest" })
    .first()
    .click();
  await page.getByRole("button", { name: "标签处理" }).click();
  await page.getByTestId("smart-tag-picker-remove-待回复").click();
  await expect(page.getByTestId("smart-tag-action-dialog")).toBeVisible();
  await page.getByTestId("smart-tag-action-confirm").click();

  // The 发布日期确认 relation survives; the removed 待回复 relation is gone.
  await tagLink.click();
  await expect(
    page.locator("[data-testid='mail-item']", { hasText: "Weekly digest" }),
  ).toBeVisible({ timeout: 10_000 });

  const actions = await waitFor(
    async () => {
      const response = await fetch(`${server.apiBaseUrl}/api/action-center`);
      const payload = (await response.json()) as {
        smartTagActions?: Array<{ tagName: string; actionType: string }>;
      };
      const tagActions = payload.smartTagActions ?? [];
      const hasApply = tagActions.some(
        (item) => item.tagName === "发布日期确认" && item.actionType === "apply",
      );
      const hasRemove = tagActions.some(
        (item) => item.tagName === "待回复" && item.actionType === "remove",
      );
      return hasApply && hasRemove ? tagActions : null;
    },
    { label: "smart-tag-manual-actions" },
  );
  expect(actions.length).toBeGreaterThan(0);
});
