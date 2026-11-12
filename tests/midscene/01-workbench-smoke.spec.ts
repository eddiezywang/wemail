// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Midscene-powered smoke test of the WeMail workbench.
 *
 * Boots the production renderer against a mocked Hono API + LLM, logs in via the
 * existing test fixture, then drives the UI with natural-language
 * prompts (`ai.aiAction`, `ai.aiQuery`, `ai.aiAssert`). Captures
 * Midscene's report so visual / interaction regressions surface as a
 * plain-language transcript instead of brittle CSS selectors.
 */

import { test as base, expect } from "@playwright/test";
import { PlaywrightAiFixture } from "@midscene/web/playwright";
import {
	startTestServer,
	loginWithFixture,
	type TestServer,
} from "../browser/helpers/testServer.js";
import { injectDesktopApi } from "../browser/helpers/mockDesktop.js";

const test = base.extend(PlaywrightAiFixture());

let server: TestServer;

test.beforeAll(async () => {
	server = await startTestServer({
		inboxFixtures: ["mail-001-question.json", "mail-002-notification.json"],
	});
	await loginWithFixture(server.apiBaseUrl);
});

test.afterAll(async () => {
	await server.close();
});

test("workbench shell is laid out like the design mockup", async ({
	page,
	ai,
	aiAssert,
	aiQuery,
}) => {
	injectDesktopApi(page, server.apiBaseUrl);
	await page.goto("/");
	await page.waitForLoadState("networkidle");

	await aiAssert(
		"窗口左侧是完整的邮件导航栏，顶部有写邮件，下面能看到收件箱、待办、行动中心、摘要中心和工作空间，底部还有邮件文件夹入口",
	);
	await aiAssert(
		"中间区域是邮件列表，顶部有搜索框和分类或筛选入口，页面没有加载失败、白屏或明显错位",
	);
	await aiAssert(
		"右侧有独立的 WeMail AI 面板，标题栏、对话区域和底部输入框层级清楚，没有遮挡邮件列表",
	);

	const layout = await aiQuery<{
		hasMailNavigation: boolean;
		hasAgentPanel: boolean;
		mailRowCount: number;
	}>(
		"返回 { hasMailNavigation: 左侧是否有完整邮件导航, hasAgentPanel: 右侧是否有 WeMail AI 面板, mailRowCount: 列表里能看到的邮件数 }",
	);
	expect(layout.hasMailNavigation).toBe(true);
	expect(layout.hasAgentPanel).toBe(true);
	expect(layout.mailRowCount).toBeGreaterThan(0);
});

test("clicking a mail row opens the detail pane with toolbar", async ({
	page,
	ai,
	aiAssert,
}) => {
	injectDesktopApi(page, server.apiBaseUrl);
	await page.goto("/");
	await page.waitForLoadState("networkidle");

	await ai("点击邮件列表里的第一封邮件");
	await aiAssert(
		"邮件详情区域出现邮件主题、正文和回复、转发、加星或删除等操作入口，同时 WeMail AI 面板仍保持独立可用",
	);
});

test("toggling the agent panel from the header works", async ({
	page,
	ai,
	aiAssert,
}) => {
	injectDesktopApi(page, server.apiBaseUrl);
	await page.goto("/");
	await page.waitForLoadState("networkidle");

	await ai("点击顶部的机器人图标按钮，关闭右侧的 AI 面板");
	await aiAssert("右侧的 WeMail AI 面板已经看不到了");

	await ai("再次点击机器人图标按钮，把 AI 面板打开");
	await aiAssert(
		"右侧重新出现 WeMail AI 面板，顶部显示 WeMail AI，底部有圆角输入框，空会话区域有欢迎信息或建议操作",
	);
});
