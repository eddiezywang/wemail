// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, useLocation } from "react-router";
import { digestKeys } from "~/queries/digests";
import { useCurrentAccount } from "~/queries/currentAccount";
import { useUIStore } from "~/hooks/useUIStore";
import api from "~/services/api";
import SettingsDialog from "./SettingsDialog";
import { AccountSection } from "./sections/AccountSection";
import { ComposeSection } from "./sections/ComposeSection";
import { resetAccountSignaturePreferencesForTests } from "~/hooks/useAccountSignaturePreferences";

vi.mock("~/queries/currentAccount", () => ({
	useCurrentAccount: vi.fn(),
}));

const digestSettings = {
	manualEnabled: true,
	manualWindowHours: 24,
	inactivityEnabled: true,
	inactivityHours: 6,
	dailyEnabled: false,
	dailyTime: "09:00",
	dailyWindowMode: "day-start-to-now",
	lastOpenedAt: null,
	lastDailyDigestDate: null,
};

function renderWithClient(ui: ReactElement) {
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	queryClient.setQueryData(digestKeys.settings, digestSettings);
	return render(
		<QueryClientProvider client={queryClient}>
			{ui}
		</QueryClientProvider>,
	);
}

function LocationProbe() {
	const location = useLocation();
	return <div data-testid="location">{`${location.pathname}${location.search}`}</div>;
}

describe("SettingsDialog", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(api, "getUsageStats").mockResolvedValue({
			ok: true,
			period: "365d",
			stats: [
				{ category: "summary", label: "摘要", tokens: 23000, inputTokens: 20000, outputTokens: 3000, calls: 12, details: [], models: [] },
				{ category: "agent_chat", label: "AI 聊天", tokens: 757, inputTokens: 600, outputTokens: 157, calls: 4, details: [], models: [{ provider: "anthropic", model: "claude-3-5-sonnet", tokens: 757, inputTokens: 600, outputTokens: 157, calls: 4 }] },
				{ category: "compose", label: "撰写", tokens: 223, inputTokens: 180, outputTokens: 43, calls: 2, details: [], models: [] },
				{ category: "todo", label: "待办", tokens: 26000, inputTokens: 22000, outputTokens: 4000, calls: 9, details: [], models: [] },
				{ category: "translation", label: "AI 翻译", tokens: 2000, inputTokens: 1700, outputTokens: 300, calls: 3, details: [], models: [{ provider: "openai", model: "gpt-4o-mini", tokens: 2000, inputTokens: 1700, outputTokens: 300, calls: 3 }] },
				{ category: "automation", label: "自动化", tokens: 0, inputTokens: 0, outputTokens: 0, calls: 0, details: [], models: [] },
				{ category: "other", label: "其他", tokens: 6000, inputTokens: 5000, outputTokens: 1000, calls: 3, details: [], models: [] },
			],
		});
		vi.spyOn(api, "getLoggingDiagnostics").mockResolvedValue({
			ok: true,
			debugEnabled: false,
			expiresAt: null,
			remainingSeconds: 0,
			retentionDays: 14,
			maxFileBytes: 20 * 1024 * 1024,
			maxTotalBytes: 200 * 1024 * 1024,
		});
		window.localStorage.clear();
		resetAccountSignaturePreferencesForTests();
		useUIStore.setState({ isSettingsOpen: false, settingsSection: "account" });
	});

	afterEach(() => {
		vi.clearAllMocks();
		useUIStore.setState({ isSettingsOpen: false, settingsSection: "account" });
	});

	it("renders account settings from the current account", () => {
		renderWithClient(
			<AccountSection
				displayName="User Name"
				email="user@example.com"
				currentMailboxId="acct-1"
				connectedMailboxes={[
					{
						id: "acct-1",
						name: "User Name",
						email: "user@example.com",
						settings: { fromName: "User Name" },
					},
				]}
			/>,
		);

		expect(screen.getAllByText("User Name").length).toBeGreaterThan(0);
		expect(screen.getAllByText("user@example.com").length).toBeGreaterThan(0);
		expect(screen.queryByText(/发件人名称会显示在/)).toBeNull();
		expect(screen.getByTestId("account-ai-usage")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "近一年" })).toHaveAttribute(
			"aria-pressed",
			"true",
		);
	});

	it("keeps usage categories visible when the usage request fails", async () => {
		vi.mocked(api.getUsageStats).mockRejectedValueOnce(new Error("request failed"));
		renderWithClient(
			<AccountSection
				displayName="User Name"
				email="user@example.com"
				currentMailboxId="acct-1"
			/>,
		);

		expect(await screen.findByText("当前范围读取失败，请刷新重试"))
			.toBeInTheDocument();
		for (const label of ["摘要", "待办", "AI 聊天", "AI 翻译", "撰写", "自动化", "标签 / 其他"]) {
			expect(screen.getByText(label, { selector: "span" })).toBeInTheDocument();
		}
	});

	it("edits and persists the sender display name", async () => {
		const user = userEvent.setup();
		const updateSpy = vi.spyOn(api, "updateAccountDisplayName").mockResolvedValue({
			ok: true,
			account: {
				id: "acct-1",
				emailAddress: "user@example.com",
				displayName: "新发件人",
				imap: { host: "imap.example.com", port: 993, secure: true, username: "user@example.com" },
				smtp: { host: "smtp.example.com", port: 465, secure: true, username: "user@example.com" },
			},
		});
		renderWithClient(
			<AccountSection
				displayName="User Name"
				email="user@example.com"
				currentMailboxId="acct-1"
				connectedMailboxes={[
					{ id: "acct-1", name: "User Name", email: "user@example.com" },
				]}
			/>,
		);

		await user.click(screen.getByRole("button", { name: "邮箱账户操作" }));
		await user.click(screen.getByRole("menuitem", { name: "编辑发件人名称" }));
		const input = screen.getByLabelText("发件人名称");
		await user.clear(input);
		await user.type(input, "新发件人");
		await user.click(screen.getByRole("button", { name: "保存" }));

		expect(updateSpy).toHaveBeenCalledWith("新发件人");
		await waitFor(() => expect(screen.queryByRole("dialog", { name: "编辑发件人名称" })).toBeNull());
		expect(screen.getAllByText("新发件人").length).toBeGreaterThan(0);
	});

	it("integrates AI usage into account instead of a separate navigation item", async () => {
		vi.mocked(useCurrentAccount).mockReturnValue({
			data: {
				account: {
					id: "acct-1",
					emailAddress: "user@example.com",
					displayName: "User Name",
				},
			},
			isLoading: false,
		} as unknown as ReturnType<typeof useCurrentAccount>);
		useUIStore.getState().openSettings("account");

		renderWithClient(
			<MemoryRouter>
				<SettingsDialog />
			</MemoryRouter>,
		);

		expect(screen.queryByTestId("settings-nav-ai-usage")).toBeNull();
		expect(await screen.findByText("总计：57,980")).toBeInTheDocument();
		expect(screen.getByLabelText("AI 用量合计 57,980 tokens")).toBeInTheDocument();
	});

	it("uses an in-app confirmation before changing mailbox", async () => {
		const user = userEvent.setup();
		const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
		vi.mocked(useCurrentAccount).mockReturnValue({
			data: {
				account: {
					id: "acct-1",
					emailAddress: "user@example.com",
					displayName: "User Name",
				},
			},
			isLoading: false,
		} as unknown as ReturnType<typeof useCurrentAccount>);
		useUIStore.getState().openSettings("account");

		renderWithClient(
			<MemoryRouter>
				<SettingsDialog />
			</MemoryRouter>,
		);

		await user.click(screen.getByRole("button", { name: "更换邮箱" }));

		expect(confirmSpy).not.toHaveBeenCalled();
		expect(
			screen.getByRole("heading", { name: "确认更换邮箱？" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "确认更换" }),
		).toBeInTheDocument();
	});

	it("routes mailbox switching to provider selection onboarding", async () => {
		const user = userEvent.setup();
		vi.spyOn(api, "logoutAccount").mockResolvedValue({ ok: true });
		vi.mocked(useCurrentAccount).mockReturnValue({
			data: {
				account: {
					id: "acct-1",
					emailAddress: "user@example.com",
					displayName: "User Name",
				},
			},
			isLoading: false,
		} as unknown as ReturnType<typeof useCurrentAccount>);
		useUIStore.getState().openSettings("account");

		renderWithClient(
			<MemoryRouter initialEntries={["/"]}>
				<LocationProbe />
				<SettingsDialog />
			</MemoryRouter>,
		);

		await user.click(screen.getByRole("button", { name: "更换邮箱" }));
		await user.click(screen.getByRole("button", { name: "确认更换" }));

		await waitFor(() => {
			expect(screen.getByTestId("location")).toHaveTextContent(
				"/onboarding?chooseProvider=1",
			);
		});
	});

	it("exposes live MCP management as a primary destination", async () => {
		vi.mocked(useCurrentAccount).mockReturnValue({
			data: { account: { id: "acct-1", emailAddress: "user@example.com", displayName: "User" } },
			isLoading: false,
		} as unknown as ReturnType<typeof useCurrentAccount>);
		vi.spyOn(api, "getMcpState").mockResolvedValue({
			ok: true,
			state: {
				enabled: false, port: 43129, defaultBodyCharacters: 6000, maxBodyCharacters: 20000,
				defaultPageSize: 25, maxPageSize: 100, maxRecipients: 200, maxBatchMessages: 100,
				maxPendingOperations: 100, toolTimeoutSeconds: 30,
				endpoint: "http://127.0.0.1:43129/mcp", listenerState: "disabled",
				credentialState: "unavailable", protocols: ["2025-11-25"], tools: [], token: null,
				legacyTokens: [], sessions: [], pendingOperationCount: 0, operations: [],
			},
		});
		useUIStore.getState().openSettings("mcp");
		renderWithClient(<MemoryRouter><SettingsDialog /></MemoryRouter>);
		await waitFor(() => expect(screen.getByTestId("mcp-settings-section")).toBeInTheDocument());
		expect(screen.getByText("MCP 连接", { selector: "h2" })).toBeInTheDocument();
		expect(screen.queryByText("WeCLI")).not.toBeInTheDocument();
	});

	it("enables temporary debug logging from Advanced diagnostics", async () => {
		const user = userEvent.setup();
		vi.mocked(useCurrentAccount).mockReturnValue({
			data: { account: { id: "acct-1", emailAddress: "user@example.com", displayName: "User" } },
			isLoading: false,
		} as unknown as ReturnType<typeof useCurrentAccount>);
		const setDebugLogging = vi.spyOn(api, "setDebugLogging").mockResolvedValue({
			ok: true,
			debugEnabled: true,
			expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
			remainingSeconds: 1800,
			retentionDays: 14,
			maxFileBytes: 20 * 1024 * 1024,
			maxTotalBytes: 200 * 1024 * 1024,
		});
		useUIStore.getState().openSettings("advanced");

		renderWithClient(<MemoryRouter><SettingsDialog /></MemoryRouter>);
		// Advanced panes are lazy-loaded; on a cold CI runner the chunk import
		// can outlast the default 1s find timeout.
		await user.click(await screen.findByRole("button", { name: /诊断/ }, { timeout: 5000 }));
		const debugSwitch = await screen.findByRole("switch", { name: "开启调试日志" });
		expect(screen.getByText(/不会记录邮件正文、密码、令牌或 API Key/)).toBeInTheDocument();
		await user.click(debugSwitch);

		expect(setDebugLogging).toHaveBeenCalledWith(true);
		await waitFor(() => expect(debugSwitch).toBeChecked());
		expect(screen.getByText(/后自动关闭/)).toBeInTheDocument();
	});

	it("shows appearance as a primary nav item and keeps other panes under Advanced", async () => {
		vi.mocked(useCurrentAccount).mockReturnValue({
			data: {
				account: {
					id: "acct-1",
					emailAddress: "user@example.com",
					displayName: "User Name",
				},
			},
			isLoading: false,
		} as unknown as ReturnType<typeof useCurrentAccount>);
		useUIStore.getState().openSettings("account");

		renderWithClient(
			<MemoryRouter initialEntries={["/"]}>
				<LocationProbe />
				<SettingsDialog />
			</MemoryRouter>,
		);

		for (const label of ["账户", "个性化", "AI 模型", "MCP", "连接", "Skill Center", "外观", "关于"]) {
			expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
		}
		expect(screen.getByRole("button", { name: "高级设置" })).toBeInTheDocument();
		expect(screen.getByTestId("settings-nav-appearance")).toBeInTheDocument();
		for (const testId of ["settings-nav-mail", "settings-nav-notifications"]) {
			expect(screen.queryByTestId(testId)).toBeNull();
		}
		expect(screen.queryByRole("button", { name: "历史与回溯" })).toBeNull();
		expect(screen.queryByRole("button", { name: "行动中心" })).toBeNull();
		expect(screen.queryByRole("button", { name: "摘要中心" })).toBeNull();
		expect(screen.queryByRole("button", { name: "学习中心" })).toBeNull();
	});

	it("offers independent notification controls and opens Windows settings", async () => {
		const user = userEvent.setup();
		const openWindowsNotificationSettings = vi.fn(async () => ({
			ok: true,
			supported: true,
		}));
		window.wemailDesktop = {
			...window.wemailDesktop,
			openWindowsNotificationSettings,
		};
		vi.mocked(useCurrentAccount).mockReturnValue({
			data: {
				account: {
					id: "acct-1",
					emailAddress: "user@example.com",
					displayName: "User Name",
				},
			},
			isLoading: false,
		} as unknown as ReturnType<typeof useCurrentAccount>);
		useUIStore.getState().openSettings("advanced");

		renderWithClient(
			<MemoryRouter>
				<SettingsDialog />
			</MemoryRouter>,
		);
		// Advanced panes are lazy-loaded and their buttons carry a description
		// line in the accessible name.
		await user.click(await screen.findByRole("button", { name: /^通知/ }, { timeout: 5000 }));

		expect(
			screen.getByRole("switch", { name: "需要处理的事项" }),
		).toBeChecked();
		expect(screen.getByRole("switch", { name: "新邮件" })).toBeChecked();
		expect(screen.getByRole("switch", { name: "通知声音" })).not.toBeChecked();
		expect(screen.getByText("显示发件人和主题")).toBeInTheDocument();

		await user.click(screen.getByRole("switch", { name: "新邮件" }));
		expect(screen.getByRole("switch", { name: "新邮件" })).not.toBeChecked();
		expect(
			screen.getByRole("switch", { name: "需要处理的事项" }),
		).toBeChecked();

		await user.click(
			screen.getByRole("button", { name: "打开 Windows 通知设置" }),
		);
		expect(openWindowsNotificationSettings).toHaveBeenCalledOnce();
	});

	it("maintains a default-on signature for the current account", async () => {
		const user = userEvent.setup();
		vi.mocked(useCurrentAccount).mockReturnValue({
			data: {
				account: {
					id: "acct-163",
					emailAddress: "173729896@163.com",
					displayName: "V Bank",
				},
			},
			isLoading: false,
		} as unknown as ReturnType<typeof useCurrentAccount>);

		// ComposeSection reads the directory-name cache via React Query.
		renderWithClient(
			<ComposeSection
				account={{
					id: "acct-163",
					emailAddress: "173729896@163.com",
					displayName: "V Bank",
				}}
			/>,
		);

		const signatureSwitch = screen.getByRole("switch", {
			name: "使用签名",
		});
		expect(signatureSwitch).toBeChecked();
		expect(screen.getByText("173729896@163.com")).toBeInTheDocument();
		expect(screen.getAllByText("V Bank")).toHaveLength(1);
		expect(screen.queryByText("发送效果预览")).not.toBeInTheDocument();
		expect(screen.queryByText("品牌尾注固定添加，不属于可编辑签名内容。")).not.toBeInTheDocument();

		await user.type(screen.getByLabelText("自定义签名"), "Custom identity");
		expect(screen.getByLabelText("自定义签名")).toHaveValue("Custom identity");
		await user.click(screen.getByRole("button", { name: "恢复默认" }));
		expect(screen.getByLabelText("自定义签名")).toHaveValue("");

		await user.click(signatureSwitch);
		expect(screen.getByText("发送邮件时不会添加签名或 Sent with Wemail。"))
			.toBeInTheDocument();
	});

});
