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

test("settings dialog exposes the simplified primary destinations", async ({ page }) => {
  injectDesktopApi(page, server.apiBaseUrl);

  // Login first
  await loginWithFixture(server.apiBaseUrl);

  // Navigate to settings
  await page.goto("/settings");
  const dialog = page.getByRole("dialog", { name: "设置" });
  await expect(dialog).toBeVisible({ timeout: 10_000 });

  await expect(dialog.getByRole("heading", { name: "账户", exact: true })).toBeVisible();
  await expect(dialog.getByText("cqqdy@cqdly.us").first()).toBeVisible();
  await expect(dialog.getByText(/发件人名称会显示在/)).toHaveCount(0);
  await dialog.getByRole("button", { name: "邮箱账户操作" }).click();
  await page.getByRole("menuitem", { name: "编辑发件人名称" }).click();
  const senderEditor = page.getByRole("dialog", { name: "编辑发件人名称" });
  const senderName = senderEditor.getByRole("textbox", { name: "发件人名称" });
  await senderName.fill("浏览器测试发件人");
  await senderEditor.getByRole("button", { name: "保存" }).click();
  await expect(senderEditor).not.toBeVisible();
  await expect(dialog.getByText("浏览器测试发件人").first()).toBeVisible();

  const updatedAccount = await fetch(`${server.apiBaseUrl}/api/account/current`);
  expect(((await updatedAccount.json()) as { account: { displayName: string } }).account.displayName)
    .toBe("浏览器测试发件人");

  await expect(dialog.getByTestId("account-ai-usage")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "近一年" })).toHaveAttribute("aria-pressed", "true");
  await expect(dialog.getByTestId("settings-nav-ai-usage")).toHaveCount(0);
  const usage = dialog.getByTestId("account-ai-usage");
  for (const label of ["摘要", "待办", "AI 聊天", "AI 翻译", "撰写", "自动化", "标签 / 其他"]) {
    await expect(usage.getByText(label, { exact: true })).toBeVisible();
  }
  await expect(usage.getByText("总计：0")).toBeVisible();
  await expect(usage.getByText("当前范围读取失败，请刷新重试")).toHaveCount(0);

  for (const section of ["账户", "个性化", "AI 模型", "MCP", "连接", "Skill Center", "关于", "高级设置"]) {
    await expect(dialog.getByRole("button", { name: section, exact: true })).toBeVisible();
  }
  await expect(dialog.getByText("自定义 AI", { exact: true })).toHaveCount(0);
  await expect(dialog.getByTestId("settings-nav-mail")).toHaveCount(0);
  await expect(dialog.getByTestId("settings-nav-notifications")).toHaveCount(0);
  await expect(dialog.getByTestId("settings-nav-appearance")).toHaveCount(0);

  await dialog.getByTestId("settings-nav-advanced").click();
  await expect(dialog.getByRole("heading", { name: "签名" })).toBeVisible();

  // 外观 is a pane card inside 高级设置; its accessible name concatenates the
  // card label and description.
  await dialog.getByRole("button", { name: /外观/ }).click();
  await expect(dialog.getByRole("heading", { name: "外观" })).toBeVisible();
  await expect(dialog.getByTestId("theme-selector")).toBeVisible();
  await expect(dialog.getByRole("tab", { name: "跟随系统" })).toBeVisible();

  // Verify the settings API is reachable
  const settingsRes = await fetch(`${server.apiBaseUrl}/api/settings/llm`);
  expect(settingsRes.ok).toBeTruthy();
});

test("settings discovers endpoint models and saves a selected model id", async ({ page }, testInfo) => {
  injectDesktopApi(page, server.apiBaseUrl);
  await loginWithFixture(server.apiBaseUrl);

  const configured = await fetch(`${server.apiBaseUrl}/api/settings/llm`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      baseUrl: server.mockLlmUrl,
      apiKey: "test-key",
      defaultModel: "mock-model",
    }),
  });
  expect(configured.ok).toBeTruthy();

  await page.goto("/settings");
  const dialog = page.getByRole("dialog", { name: "设置" });
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  await dialog.getByTestId("settings-nav-model").click();

  await expect(dialog.getByText("已发现 2 个模型")).toBeVisible({ timeout: 10_000 });
  await dialog.getByRole("button", { name: "显示模型列表" }).first().click();
  await expect(page.getByRole("option", { name: /mock-model-alt/ })).toBeVisible();
  // The legacy suite asserted the picker carries no recommendation labels;
  // the model picker now ships tier copy (e.g. 自动（推荐）), so only assert
  // that model selection itself works.

  await page.getByRole("option", { name: /mock-model-alt/ }).click();
  await dialog.getByRole("button", { name: "保存" }).click();

  await expect.poll(async () => {
    const response = await fetch(`${server.apiBaseUrl}/api/settings/llm`);
    const body = (await response.json()) as { llm: { defaultModel: string } };
    return body.llm.defaultModel;
  }).toBe("mock-model-alt");

  await page.screenshot({
    path: testInfo.outputPath("model-discovery-settings.png"),
    fullPage: true,
  });
});

test("settings close button exits without saving", async ({ page }) => {
  injectDesktopApi(page, server.apiBaseUrl);

  await loginWithFixture(server.apiBaseUrl);
  await page.goto("/settings");
  const dialog = page.getByRole("dialog", { name: "设置" });
  await expect(dialog).toBeVisible({ timeout: 10_000 });

  await dialog.getByRole("button", { name: "关闭" }).click();
  await expect(dialog).not.toBeVisible({ timeout: 5_000 });
});

test("settings exposes the secure local MCP connection without enabling it implicitly", async ({ page }) => {
  injectDesktopApi(page, server.apiBaseUrl);
  await loginWithFixture(server.apiBaseUrl);

  await page.goto("/settings");
  const dialog = page.getByRole("dialog", { name: "设置" });
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  await dialog.getByTestId("settings-nav-mcp").click();

  const section = dialog.getByTestId("mcp-settings-section");
  await expect(section).toBeVisible();
  await expect(section.getByRole("heading", { name: "MCP 连接" })).toBeVisible();
  await expect(section.getByRole("switch", { name: "启用本地 MCP" })).not.toBeChecked();
  const diagnostics = section.getByText("诊断与高级连接信息");
  await expect(diagnostics).toBeVisible();
  await diagnostics.click();
  await expect(section.getByText("http://127.0.0.1:43129/mcp").first()).toBeVisible();
  await expect(section.getByText(/公开工具 · \d+/)).toBeVisible();
  await expect(section.getByRole("button", { name: "复制 MCP 配置" })).toBeDisabled();
  await expect(section.getByText(/创建 Token|我已保存/)).toHaveCount(0);
  await expect(section.getByText("WeCLI", { exact: true })).toHaveCount(0);
});

test("Escape key exits settings", async ({ page }) => {
  injectDesktopApi(page, server.apiBaseUrl);

  await loginWithFixture(server.apiBaseUrl);
  await page.goto("/settings");
  const dialog = page.getByRole("dialog", { name: "设置" });
  await expect(dialog).toBeVisible({ timeout: 10_000 });

  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible({ timeout: 5_000 });
});

test("legacy feature settings deep links migrate to product destinations", async ({ page }) => {
  injectDesktopApi(page, server.apiBaseUrl);
  await loginWithFixture(server.apiBaseUrl);

  await page.goto("/settings?section=automation");
  await expect(page).toHaveURL(/\/automation$/);
  await expect(page.getByRole("heading", { name: "自动化", exact: true })).toBeVisible();

  await page.goto("/settings?section=writing-style");
  await expect(page).toHaveURL(/\/\?compose=styles$/);
  await expect(page.getByRole("dialog", { name: "管理写作风格" })).toBeVisible();

  await page.goto("/settings?section=ai-summary");
  await expect(page).toHaveURL(/\/digests$/);
  await expect(page.getByRole("heading", { name: "智能中心" })).toBeVisible();

  await page.goto("/settings?section=ai-learning");
  await expect(page).toHaveURL(/\/workspace$/);
  await expect(page.getByRole("heading", { name: "工作空间", exact: true })).toBeVisible();
});

test("unknown settings deep links safely fall back to Account", async ({ page }) => {
  injectDesktopApi(page, server.apiBaseUrl);
  await loginWithFixture(server.apiBaseUrl);
  await page.goto("/settings?section=not-real");
  const dialog = page.getByRole("dialog", { name: "设置" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "账户", exact: true })).toBeVisible();
});
