import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
	ChannelBotProfile,
	IntegrationConnectionSnapshot,
} from "../../../../shared/wemail/channels";
import { toast } from "sonner";
import api from "~/services/api";
import { ConnectionsSection } from "./ConnectionsSection";

const statusMock = vi.hoisted(() => ({
	snapshot: {
		loadedAt: "2026-07-29T00:00:00.000Z",
		entries: [
			{ id: "wecli", label: "WeCLI", state: "connected", observedAt: "2026-07-29T00:00:00.000Z" },
			{ id: "feishu", label: "飞书", state: "not_configured", observedAt: null },
			{ id: "wecom", label: "企业微信", state: "connected", observedAt: "2026-07-29T00:00:00.000Z" },
		],
	} as IntegrationConnectionSnapshot,
}));

vi.mock("~/queries/integrationStatus", () => ({
	integrationStatusKey: ["integrations", "status"],
	useDetectIntegrationStatus: () => ({ mutate: vi.fn(), isPending: false }),
	useIntegrationStatus: () => ({ data: statusMock.snapshot }),
}));

vi.mock("sonner", () => ({
	toast: {
		success: vi.fn(),
		error: vi.fn(),
		info: vi.fn(),
	},
}));

describe("ConnectionsSection", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
		// The WeCLI tab is edition-gated (`useEditionFeatures`). Without this
		// mock the panel either performs a real fetch or silently depends on
		// fetch state leaked from an unrelated test file.
		vi.spyOn(api, "getEditionInfo").mockResolvedValue({
			providerPresets: [],
			bootToCredentials: false,
			signatureBrandUrl: "",
			features: {
				wecli: true,
				allowanceInvoice: true,
				enterpriseDirectory: false,
				officeSceneDetection: false,
			},
		});
		// Default feishu observation is `not_configured` so the connectionDown
		// banner does not short-circuit the ready/pairing assertions below.
		statusMock.snapshot = {
			loadedAt: "2026-07-29T00:00:00.000Z",
			entries: [
				{ id: "wecli", label: "WeCLI", state: "connected", observedAt: "2026-07-29T00:00:00.000Z" },
				{ id: "feishu", label: "飞书", state: "not_configured", observedAt: null },
				{ id: "wecom", label: "企业微信", state: "connected", observedAt: "2026-07-29T00:00:00.000Z" },
			],
		};
		vi.spyOn(api, "listChannelProfiles").mockResolvedValue({ profiles: [] });
		// Every panel refresh (and the wecli catalog query) must stay in-process.
		// Without these defaults a mutation's onSuccess refresh falls through to
		// the real fetch(), which on CI resolves to localhost:3000 and produces
		// an unhandled ECONNREFUSED rejection that leaks into other test files.
		vi.spyOn(api, "getIntegrationStatus").mockResolvedValue(statusMock.snapshot);
		vi.spyOn(api, "refreshIntegrationStatus").mockResolvedValue(statusMock.snapshot);
		vi.spyOn(api, "getWecliCatalog").mockResolvedValue({
			ok: true,
			fetchedAt: "2026-07-29T00:00:00.000Z",
			total: 0,
			siteCount: 0,
			sites: [],
		});
	});

	it("keeps all integrations discoverable and shows the selected platform setup flow", async () => {
		const user = userEvent.setup();
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		render(
			<QueryClientProvider client={client}>
				<ConnectionsSection initialSelected="feishu" />
			</QueryClientProvider>,
		);
		// The tab list is edition-gated via useEditionFeatures, so the WeCLI
		// entry only appears once the edition query has resolved.
		expect(await screen.findByRole("button", { name: /WeCLI/ })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /飞书/ })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /企业微信/ })).toBeInTheDocument();
		expect(await screen.findByText("扫码新增 飞书 Bot")).toBeInTheDocument();
		expect(screen.getByRole("tab", { name: "新增 Bot" })).toHaveAttribute(
			"aria-selected",
			"true",
		);
		await user.click(screen.getByRole("tab", { name: "使用现存 Bot" }));
		expect(screen.getByLabelText("飞书 App Secret")).toHaveAttribute(
			"type",
			"password",
		);
		expect(screen.getByRole("button", { name: "保存并连接" })).toBeDisabled();
	});

	it("switches platform details without running a connection detection", async () => {
		const user = userEvent.setup();
		const detectSpy = vi.spyOn(api, "refreshIntegrationStatus");
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		render(
			<QueryClientProvider client={client}>
				<ConnectionsSection initialSelected="feishu" />
			</QueryClientProvider>,
		);
		await user.click(screen.getByRole("button", { name: /企业微信/ }));
		expect(await screen.findByText(/企业微信官方 SDK/)).toBeInTheDocument();
		expect(detectSpy).not.toHaveBeenCalled();
	});

	it("saves Feishu credentials through the redacted platform API and clears the secret", async () => {
		const user = userEvent.setup();
		const save = vi.spyOn(api, "saveBotChannelConfiguration").mockResolvedValue({
			configuration: {
				platform: "feishu",
				connectionId: "connection-1",
				profileId: "profile-1",
				externalBotId: "cli_app",
				displayName: "飞书助手",
				enabled: true,
				hasCredential: true,
				createdAt: "2026-07-29T00:00:00.000Z",
				updatedAt: "2026-07-29T00:00:00.000Z",
			},
		});
		const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		render(
			<QueryClientProvider client={client}>
				<ConnectionsSection initialSelected="feishu" />
			</QueryClientProvider>,
		);
		await user.click(await screen.findByRole("tab", { name: "使用现存 Bot" }));
		await user.type(await screen.findByLabelText("飞书 App ID"), "cli_app");
		const secret = screen.getByLabelText("飞书 App Secret");
		await user.type(secret, "super-secret");
		expect(screen.queryByLabelText("机器人显示名称")).not.toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "保存并连接" }));
		await vi.waitFor(() =>
			expect(save).toHaveBeenCalledWith("feishu", {
				appId: "cli_app",
				appSecret: "super-secret",
			}),
		);
		expect(secret).toHaveValue("");
		expect(screen.queryByText("super-secret")).not.toBeInTheDocument();
	});

	it("saves only the required WeCom Bot ID and secret", async () => {
		const user = userEvent.setup();
		const save = vi.spyOn(api, "saveBotChannelConfiguration").mockResolvedValue({
			configuration: {
				platform: "wecom",
				connectionId: "connection-1",
				profileId: "profile-1",
				externalBotId: "wecom-bot",
				displayName: "企微助手",
				enabled: true,
				hasCredential: true,
				createdAt: "2026-07-29T00:00:00.000Z",
				updatedAt: "2026-07-29T00:00:00.000Z",
			},
		});
		const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		render(
			<QueryClientProvider client={client}>
				<ConnectionsSection initialSelected="wecom" />
			</QueryClientProvider>,
		);
		await user.click(await screen.findByRole("tab", { name: "使用现存 Bot" }));
		await user.type(await screen.findByLabelText("企微 Bot ID"), "wecom-bot");
		await user.type(screen.getByLabelText("企微 Bot Secret"), "bot-secret");
		expect(screen.queryByLabelText("机器人显示名称")).not.toBeInTheDocument();
		expect(screen.queryByLabelText("企微 WebSocket 地址")).not.toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "保存并连接" }));
		await vi.waitFor(() =>
			expect(save).toHaveBeenCalledWith("wecom", {
				botId: "wecom-bot",
				botSecret: "bot-secret",
			}),
		);
	});

	it("keeps setup resumable when Bot Core configuration save fails", async () => {
		const user = userEvent.setup();
		const save = vi
			.spyOn(api, "saveBotChannelConfiguration")
			.mockRejectedValue(new Error("platform-authentication-failed"));
		const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		render(
			<QueryClientProvider client={client}>
				<ConnectionsSection initialSelected="wecom" />
			</QueryClientProvider>,
		);
		await user.click(await screen.findByRole("tab", { name: "使用现存 Bot" }));
		await user.type(await screen.findByLabelText("企微 Bot ID"), "bad-bot");
		await user.type(screen.getByLabelText("企微 Bot Secret"), "bad-secret");
		await user.click(screen.getByRole("button", { name: "保存并连接" }));
		await vi.waitFor(() => expect(save).toHaveBeenCalled());
		expect(screen.getByLabelText("企微 Bot ID")).toHaveValue("bad-bot");
		expect(screen.getByLabelText("企微 Bot Secret")).toHaveValue("bad-secret");
	});

	it("confirms owner replacement before pausing the connection and keeps disconnect available", async () => {
		const user = userEvent.setup();
		vi.mocked(api.listChannelProfiles).mockResolvedValue({
			profiles: [profile({ onboardingState: "ready", enabled: true })],
		});
		vi.spyOn(api, "listChannelDestinations").mockResolvedValue({ destinations: [] });
		vi.spyOn(api, "listChannelDependentRules").mockResolvedValue({ rules: [] });
		vi.spyOn(api, "createOwnerPairing").mockResolvedValue({
			pairing: {
				profileId: "profile-1",
				code: "abcdefghijkl",
				command: "/wemail connect abcdefghijkl",
				expiresAt: "2026-07-29T00:10:00.000Z",
			},
		});
		const disconnect = vi.spyOn(api, "disconnectChannelProfile").mockResolvedValue({
			profile: profile({ onboardingState: "bot_selected", enabled: false }),
		});
		const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		render(
			<QueryClientProvider client={client}>
				<ConnectionsSection initialSelected="feishu" />
			</QueryClientProvider>,
		);
		expect(await screen.findByText("主人：张三")).toBeInTheDocument();
		expect(screen.getByText(/OWNER v2/)).toBeInTheDocument();
		expect(screen.queryByText("邮箱绑定")).not.toBeInTheDocument();
		expect(await screen.findByText("默认仅向主人发送")).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "更换主人" }));
		expect(await screen.findByText("/wemail connect abcdefghijkl")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "保留当前主人" })).toBeEnabled();
		await user.click(screen.getByRole("button", { name: "断开连接" }));
		const disconnectDialog = await screen.findByRole("dialog", { name: "断开机器人连接？" });
		await user.click(within(disconnectDialog).getByRole("button", { name: "断开连接" }));
		await vi.waitFor(() => expect(disconnect).toHaveBeenCalledWith("profile-1"));
	});

	it("lets a stuck owner replacement exit and restore the current owner", async () => {
		const user = userEvent.setup();
		vi.mocked(api.listChannelProfiles).mockResolvedValue({
			profiles: [profile({ onboardingState: "owner_pairing", enabled: false })],
		});
		vi.spyOn(api, "listChannelDependentRules").mockResolvedValue({ rules: [] });
		const cancel = vi.spyOn(api, "cancelOwnerPairing").mockResolvedValue({
			profile: profile({ onboardingState: "ready", enabled: true }),
		});
		const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		render(
			<QueryClientProvider client={client}>
				<ConnectionsSection initialSelected="feishu" />
			</QueryClientProvider>,
		);

		expect(await screen.findByText("重新绑定等待中")).toBeInTheDocument();
		expect(screen.getByText(/原主人仍被保留/)).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "保留当前主人" }));
		await vi.waitFor(() => expect(cancel).toHaveBeenCalledWith("profile-1"));
	});

	it("offers a guarded cleanup when Bot lifecycle data is inconsistent", async () => {
		const user = userEvent.setup();
		vi.mocked(api.listChannelProfiles).mockResolvedValue({
			profiles: [
				profile({
					onboardingState: "bot_selected",
					enabled: true,
				}),
			],
		});
		vi.spyOn(api, "listChannelDependentRules").mockResolvedValue({ rules: [] });
		const reset = vi.spyOn(api, "resetChannelProfile").mockResolvedValue({
			profile: profile({
				onboardingState: "bot_selected",
				enabled: true,
				owner: undefined,
				initializedAt: undefined,
			}),
		});
		const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		render(
			<QueryClientProvider client={client}>
				<ConnectionsSection initialSelected="feishu" />
			</QueryClientProvider>,
		);

		expect(await screen.findByText("连接状态需要重置")).toBeInTheDocument();
		expect(screen.queryByText("正在完成初始化")).not.toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "重置连接" }));
		expect(await screen.findByText("重置连接？")).toBeInTheDocument();
		expect(await screen.findByText(/Bot 凭据会保留/)).toBeInTheDocument();
		expect(reset).not.toHaveBeenCalled();
		await user.click(screen.getByRole("button", { name: "重置并重新绑定" }));
		await vi.waitFor(() => expect(reset).toHaveBeenCalledWith("profile-1"));
	});

	it("presents initialization failure as resumable and queues an explicit retry", async () => {
		const user = userEvent.setup();
		vi.mocked(api.listChannelProfiles).mockResolvedValue({
			profiles: [
				profile({
					onboardingState: "initialization_pending",
					enabled: false,
					lastErrorCode: "platform-connection-failed",
				}),
			],
		});
		vi.spyOn(api, "listChannelDependentRules").mockResolvedValue({ rules: [] });
		const retry = vi.spyOn(api, "retryChannelInitialization").mockResolvedValue({
			delivery: { id: "delivery-1", state: "pending" },
		});
		const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		render(
			<QueryClientProvider client={client}>
				<ConnectionsSection initialSelected="feishu" />
			</QueryClientProvider>,
		);
		expect(await screen.findByText("初始化消息发送失败。连接不会显示为已连接，重试成功后会自动进入就绪状态。")).toBeInTheDocument();
		expect(screen.getByText("失败原因：platform-connection-failed")).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "重试初始化消息" }));
		await vi.waitFor(() => expect(retry).toHaveBeenCalledWith("profile-1"));
	});

	it("keeps a deliberately disconnected profile stopped until reconfiguration", async () => {
		vi.mocked(api.listChannelProfiles).mockResolvedValue({
			profiles: [
				profile({
					onboardingState: "bot_selected",
					enabled: false,
					lastErrorCode: "channel-disconnected-by-user",
				}),
			],
		});
		vi.spyOn(api, "listChannelDependentRules").mockResolvedValue({ rules: [] });
		const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		render(
			<QueryClientProvider client={client}>
				<ConnectionsSection initialSelected="feishu" />
			</QueryClientProvider>,
		);
		expect(await screen.findByText("Bot 已断开")).toBeInTheDocument();
		expect(screen.getByText(/更换凭据或重置前不会接收或发送消息/)).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "更换 Bot 凭据" })).toBeEnabled();
		expect(screen.queryByRole("button", { name: "重试初始化消息" })).not.toBeInTheDocument();
	});

	it("shows stage-specific failure guidance from the retained observation", async () => {
		statusMock.snapshot = {
			loadedAt: "2026-07-29T00:00:00.000Z",
			entries: [
				{ id: "wecli", label: "WeCLI", state: "unknown", observedAt: null },
				{
					id: "feishu",
					label: "飞书",
					state: "disconnected",
					observedAt: "2026-07-29T00:00:00.000Z",
					reasonCode: "platform-connection-failed",
					nextAction: "请检查平台机器人凭据与长连接状态",
				},
				{ id: "wecom", label: "企业微信", state: "not_configured", observedAt: null },
			],
		};
		const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		render(
			<QueryClientProvider client={client}>
				<ConnectionsSection initialSelected="feishu" />
			</QueryClientProvider>,
		);
		expect(screen.getByText("连接异常")).toBeInTheDocument();
		expect(screen.getByText("请检查平台机器人凭据与长连接状态")).toBeInTheDocument();
	});

	it("surfaces a clear message when a pairing check finds no owner yet", async () => {
		const user = userEvent.setup();
		vi.spyOn(api, "getIntegrationStatus").mockResolvedValue(statusMock.snapshot);
		vi.mocked(api.listChannelProfiles).mockResolvedValue({
			profiles: [profile({ onboardingState: "owner_pairing", enabled: false, owner: undefined })],
		});
		vi.spyOn(api, "listChannelDependentRules").mockResolvedValue({ rules: [] });
		const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		render(
			<QueryClientProvider client={client}>
				<ConnectionsSection initialSelected="feishu" />
			</QueryClientProvider>,
		);
		await user.click(await screen.findByRole("button", { name: "检查配对结果" }));
		await vi.waitFor(() =>
			expect(toast.info).toHaveBeenCalledWith("暂未检测到配对，请确认命令已在私聊中发出"),
		);
	});

	it("confirms a completed pairing when a check finds the bot ready", async () => {
		const user = userEvent.setup();
		vi.spyOn(api, "getIntegrationStatus").mockResolvedValue(statusMock.snapshot);
		vi.mocked(api.listChannelProfiles)
			.mockResolvedValueOnce({
				profiles: [profile({ onboardingState: "owner_pairing", enabled: false, owner: undefined })],
			})
			.mockResolvedValue({ profiles: [profile({ onboardingState: "ready", enabled: true })] });
		vi.spyOn(api, "listChannelDependentRules").mockResolvedValue({ rules: [] });
		const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		render(
			<QueryClientProvider client={client}>
				<ConnectionsSection initialSelected="feishu" />
			</QueryClientProvider>,
		);
		await user.click(await screen.findByRole("button", { name: "检查配对结果" }));
		await vi.waitFor(() =>
			expect(toast.success).toHaveBeenCalledWith("配对完成，机器人已就绪"),
		);
	});

	it("resets the progress bar to the Bot step while reconfiguring credentials", async () => {
		const user = userEvent.setup();
		vi.mocked(api.listChannelProfiles).mockResolvedValue({
			profiles: [profile({ onboardingState: "ready", enabled: true })],
		});
		vi.spyOn(api, "listChannelDestinations").mockResolvedValue({ destinations: [] });
		vi.spyOn(api, "listChannelDependentRules").mockResolvedValue({ rules: [] });
		const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		render(
			<QueryClientProvider client={client}>
				<ConnectionsSection initialSelected="feishu" />
			</QueryClientProvider>,
		);
		expect((await screen.findByTestId("stage-ready")).getAttribute("data-state")).toBe("complete");
		await user.click(screen.getByRole("button", { name: "更换 Bot 凭据" }));
		expect(screen.getByTestId("stage-bot").getAttribute("data-state")).toBe("current");
		expect(screen.getByTestId("stage-ready").getAttribute("data-state")).toBe("pending");
	});

	it("shows a blocking banner instead of the ready view when the live platform connection is down", async () => {
		statusMock.snapshot = {
			loadedAt: "2026-07-29T00:00:00.000Z",
			entries: [
				{ id: "wecli", label: "WeCLI", state: "connected", observedAt: "2026-07-29T00:00:00.000Z" },
				{
					id: "feishu",
					label: "飞书",
					state: "disconnected",
					observedAt: "2026-07-29T00:00:00.000Z",
					reasonCode: "platform-connection-failed",
					nextAction: "无法连接企业微信长连接服务，请检查网络",
				},
				{ id: "wecom", label: "企业微信", state: "not_configured", observedAt: null },
			],
		};
		vi.mocked(api.listChannelProfiles).mockResolvedValue({
			profiles: [profile({ onboardingState: "ready", enabled: true })],
		});
		vi.spyOn(api, "listChannelDestinations").mockResolvedValue({ destinations: [] });
		vi.spyOn(api, "listChannelDependentRules").mockResolvedValue({ rules: [] });
		const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		render(
			<QueryClientProvider client={client}>
				<ConnectionsSection initialSelected="feishu" />
			</QueryClientProvider>,
		);
		expect(await screen.findByText("机器人连接未建立")).toBeInTheDocument();
		expect(screen.getByText(/配对命令暂时无法接收/)).toBeInTheDocument();
		// Non-credential reason → re-detect is the primary corrective action.
		expect(screen.getByRole("button", { name: "重新检测连接" })).toBeInTheDocument();
		// The ready view is suppressed while the connection is down.
		expect(screen.queryByText("运行中")).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "发送测试消息" })).not.toBeInTheDocument();
	});

	it("points to credential re-entry when the connection failed on credentials", async () => {
		statusMock.snapshot = {
			loadedAt: "2026-07-29T00:00:00.000Z",
			entries: [
				{ id: "wecli", label: "WeCLI", state: "connected", observedAt: "2026-07-29T00:00:00.000Z" },
				{
					id: "feishu",
					label: "飞书",
					state: "disconnected",
					observedAt: "2026-07-29T00:00:00.000Z",
					reasonCode: "platform-authentication-failed",
					nextAction: "Bot 凭据无效或已过期，请重新填写 Bot ID 与 Secret",
				},
				{ id: "wecom", label: "企业微信", state: "not_configured", observedAt: null },
			],
		};
		vi.mocked(api.listChannelProfiles).mockResolvedValue({
			profiles: [profile({ onboardingState: "ready", enabled: true })],
		});
		vi.spyOn(api, "listChannelDestinations").mockResolvedValue({ destinations: [] });
		vi.spyOn(api, "listChannelDependentRules").mockResolvedValue({ rules: [] });
		const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		render(
			<QueryClientProvider client={client}>
				<ConnectionsSection initialSelected="feishu" />
			</QueryClientProvider>,
		);
		expect(await screen.findByText("机器人连接未建立")).toBeInTheDocument();
		// Credential reason → credential re-entry is the primary action.
		expect(screen.getByRole("button", { name: "更换 Bot 凭据" })).toBeInTheDocument();
	});

	it("keeps a user-initiated disconnect distinct from a platform failure", async () => {
		statusMock.snapshot = {
			loadedAt: "2026-07-29T00:00:00.000Z",
			entries: [
				{ id: "wecli", label: "WeCLI", state: "connected", observedAt: "2026-07-29T00:00:00.000Z" },
				{
					id: "feishu",
					label: "飞书",
					state: "disconnected",
					observedAt: "2026-07-29T00:00:00.000Z",
					reasonCode: "channel-disconnected-by-user",
				},
				{ id: "wecom", label: "企业微信", state: "not_configured", observedAt: null },
			],
		};
		vi.mocked(api.listChannelProfiles).mockResolvedValue({
			profiles: [
				profile({
					onboardingState: "bot_selected",
					enabled: false,
					lastErrorCode: "channel-disconnected-by-user",
				}),
			],
		});
		vi.spyOn(api, "listChannelDependentRules").mockResolvedValue({ rules: [] });
		const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		render(
			<QueryClientProvider client={client}>
				<ConnectionsSection initialSelected="feishu" />
			</QueryClientProvider>,
		);
		expect(await screen.findByText("Bot 已断开")).toBeInTheDocument();
		expect(screen.queryByText("机器人连接未建立")).not.toBeInTheDocument();
	});

	it("shows the wecli version and catalog, and copies a command on click", async () => {
		const user = userEvent.setup();
		statusMock.snapshot = {
			loadedAt: "2026-07-29T00:00:00.000Z",
			entries: [
				{
					id: "wecli",
					label: "WeCLI",
					state: "connected",
					observedAt: "2026-07-29T00:00:00.000Z",
					meta: {
						version: "1.9.97",
						binary: "C:\\tools\\wecli.cmd",
						daemon: { running: true, port: 19825, version: "1.9.97" },
						extension: { connected: true, version: "1.0.2" },
					},
				},
				{ id: "feishu", label: "飞书", state: "not_configured", observedAt: null },
				{ id: "wecom", label: "企业微信", state: "not_configured", observedAt: null },
			],
		} as IntegrationConnectionSnapshot;
		const writeText = vi.fn().mockResolvedValue(undefined);
		Object.defineProperty(navigator, "clipboard", {
			value: { writeText },
			configurable: true,
		});
		vi.spyOn(api, "getWecliCatalog").mockResolvedValue({
			ok: true,
			fetchedAt: "2026-07-29T00:00:00.000Z",
			total: 1,
			siteCount: 1,
			sites: [
				{
					name: "allowance",
					count: 1,
					commands: [
						{
							command: "allowance/ls",
							site: "allowance",
							name: "ls",
							description: "查询月度补贴发票",
							strategy: "cookie",
							browser: true,
							deprecated: false,
							replacedBy: null,
						},
					],
				},
			],
		});
		const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		render(
			<QueryClientProvider client={client}>
				<ConnectionsSection initialSelected="wecli" />
			</QueryClientProvider>,
		);

		expect(await screen.findByText(/v1\.9\.97/)).toBeInTheDocument();
		const commandButton = (await screen.findByText("查询月度补贴发票")).closest("button")!;
		await user.click(commandButton);
		await vi.waitFor(() =>
			expect(writeText).toHaveBeenCalledWith("wecli allowance/ls"),
		);
	});

	it("offers a one-click install when wecli is not installed", async () => {
		const user = userEvent.setup();
		statusMock.snapshot = {
			loadedAt: "2026-07-29T00:00:00.000Z",
			entries: [
				{
					id: "wecli",
					label: "WeCLI",
					state: "disconnected",
					observedAt: "2026-07-29T00:00:00.000Z",
					reasonCode: "wecli-not-installed",
				},
				{ id: "feishu", label: "飞书", state: "not_configured", observedAt: null },
				{ id: "wecom", label: "企业微信", state: "not_configured", observedAt: null },
			],
		} as IntegrationConnectionSnapshot;
		const setup = vi
			.spyOn(api, "setupWecli")
			.mockResolvedValue({
				succeeded: true,
				cli: { status: "ok" },
				pmCli: { status: "ok" },
				skill: { status: "ok", registered: true },
			});
		vi.spyOn(api, "refreshIntegrationStatus").mockResolvedValue(statusMock.snapshot);
		vi.spyOn(api, "getWecliCatalog").mockResolvedValue({
			ok: true,
			fetchedAt: "2026-07-29T00:00:00.000Z",
			total: 0,
			siteCount: 0,
			sites: [],
		});
		const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		render(
			<QueryClientProvider client={client}>
				<ConnectionsSection initialSelected="wecli" />
			</QueryClientProvider>,
		);

		expect(await screen.findByText("未检测到 WeCLI")).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "安装 WeCLI" }));
		await vi.waitFor(() => expect(setup).toHaveBeenCalled());
	});

	it("hides the WeCLI connection entirely when the edition feature is off", async () => {
		// P2.5: WeCLI is edition-only. With features.wecli === false the open
		// build must expose no WeCLI tab, pane or API call at all.
		vi.spyOn(api, "getEditionInfo").mockResolvedValue({
			providerPresets: [],
			bootToCredentials: false,
			signatureBrandUrl: "",
			features: {
				wecli: false,
				allowanceInvoice: false,
				enterpriseDirectory: false,
				officeSceneDetection: false,
			},
		});
		const catalog = vi.spyOn(api, "getWecliCatalog");
		const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		render(
			<QueryClientProvider client={client}>
				<ConnectionsSection initialSelected="wecli" />
			</QueryClientProvider>,
		);

		expect(screen.queryByRole("button", { name: /WeCLI/ })).not.toBeInTheDocument();
		expect(await screen.findByText("扫码新增 飞书 Bot")).toBeInTheDocument();
		await vi.waitFor(() => expect(catalog).not.toHaveBeenCalled());
	});
});

function profile(overrides: Partial<ChannelBotProfile> = {}): ChannelBotProfile {
	return { ...profileBase(), ...overrides };
}

function profileBase(): ChannelBotProfile {
	return {
		id: "profile-1",
		connectionId: "connection-1",
		botUuid: "bot-1",
		platform: "feishu" as const,
		displayName: "飞书助手",
		adapterName: "lark",
		enabled: true,
		onboardingState: "ready" as const,
		owner: {
			profileId: "profile-1",
			connectionId: "connection-1",
			botUuid: "bot-1",
			platform: "feishu" as const,
			userId: "ou_owner_123456",
			displayName: "张三",
			bindingVersion: 2,
			verifiedAt: "2026-07-29T00:00:00.000Z",
		},
		initializationVersion: 1,
		initializedAt: "2026-07-29T00:00:00.000Z",
		createdAt: "2026-07-29T00:00:00.000Z",
		updatedAt: "2026-07-29T00:00:00.000Z",
	};
}
