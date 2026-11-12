import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("~/services/api", async (importOriginal) => {
	const actual = await importOriginal<typeof import("~/services/api")>();
	return {
		...actual,
		default: {
			...actual.default,
			loginAccount: vi.fn(),
			getCurrentAccount: vi.fn(),
			syncMail: vi.fn(),
			saveLlmSettings: vi.fn(),
			discoverLlmModels: vi.fn(),
			getEditionInfo: vi.fn(),
		},
	};
});

import api from "~/services/api";

let OnboardingRoute: typeof import("./onboarding").default;

function renderOnboarding(initialEntry = "/onboarding") {
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	return render(
		<QueryClientProvider client={client}>
			<MemoryRouter initialEntries={[initialEntry]}>
				<OnboardingRoute />
				<LocationProbe />
			</MemoryRouter>
		</QueryClientProvider>,
	);
}

function LocationProbe() {
	const location = useLocation();
	return <span data-testid="location-path">{location.pathname}</span>;
}

async function pickProvider(user: ReturnType<typeof userEvent.setup>) {
	await user.click(screen.getByText("163 邮箱"));
}

describe("OnboardingRoute", () => {
	beforeAll(async () => {
		vi.stubEnv("VITE_DEV_EMAIL", "");
		vi.stubEnv("VITE_DEV_DISPLAY_NAME", "");
		vi.stubEnv("VITE_DEV_PASSWORD", "");
		vi.stubEnv("VITE_DEV_AUTOLOGIN", "");
		OnboardingRoute = (await import("./onboarding")).default;
	}, 30_000);

	afterAll(() => {
		vi.unstubAllEnvs();
	});

	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(api.getEditionInfo).mockResolvedValue({
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
		vi.mocked(api.loginAccount).mockResolvedValue({
			ok: true,
			account: {
				id: "acct-1",
				emailAddress: "eddiewang@163.com",
			},
		});
		vi.mocked(api.syncMail).mockResolvedValue({
			queued: true,
			synced: true,
			inserted: 0,
			updated: 0,
		});
		vi.mocked(api.saveLlmSettings).mockResolvedValue({
			ok: true,
			llm: {
				provider: "openai",
				baseUrl: "http://127.0.0.1:8317",
				defaultModel: "gpt-test",
				hasApiKey: true,
			},
		});
		vi.mocked(api.getCurrentAccount).mockResolvedValue({ account: null });
		vi.mocked(api.discoverLlmModels).mockResolvedValue({
			ok: true,
			provider: "openai",
			models: [],
		});
	});

	it("defaults to the provider picker with no pre-selected vendor", () => {
		renderOnboarding();
		expect(screen.getByText("配置邮箱")).toBeInTheDocument();
		expect(screen.getByText("配置 AI")).toBeInTheDocument();
		const progress = screen.getByRole("list", { name: "设置进度" });
		expect(progress.querySelectorAll("li")).toHaveLength(2);
		expect(progress).not.toHaveTextContent("连接邮箱");

		expect(
			screen.getByRole("heading", { name: "选择邮箱服务商" }),
		).toBeInTheDocument();
		expect(screen.getByText("163 邮箱")).toBeInTheDocument();
		expect(screen.queryByLabelText("邮箱用户名")).not.toBeInTheDocument();
		expect(screen.queryByLabelText("密码")).not.toBeInTheDocument();
		expect(screen.queryByLabelText("IMAP 服务器")).not.toBeInTheDocument();
	});

	it("returns to the workbench when an account is already configured", async () => {
		vi.mocked(api.getCurrentAccount).mockResolvedValueOnce({
			account: {
				id: "acct-existing",
				emailAddress: "alice@163.com",
				imap: { host: "imap.163.com", port: 993, secure: true, username: "alice@163.com" },
				smtp: { host: "smtp.163.com", port: 465, secure: true, username: "alice@163.com" },
			},
		});
		renderOnboarding();

		await waitFor(() => {
			expect(screen.getByTestId("location-path")).toHaveTextContent("/");
		});
	});

	it("restores text input focus after the credentials page mounts", async () => {
		const rafSpy = vi
			.spyOn(window, "requestAnimationFrame")
			.mockImplementation((callback) => {
				callback(0);
				return 1;
			});
		const user = userEvent.setup();

		renderOnboarding();
		await pickProvider(user);

		expect(rafSpy).toHaveBeenCalled();
		expect(screen.getByLabelText("邮箱用户名")).toHaveFocus();
	});

	it("submits preset credentials with fixed IMAP and SMTP defaults", async () => {
		const user = userEvent.setup();
		renderOnboarding();
		await pickProvider(user);

		await user.type(screen.getByLabelText("邮箱用户名"), "eddiewang");
		await user.type(screen.getByLabelText("密码"), "secret-password");
		await user.click(screen.getByRole("button", { name: "连接邮箱" }));

		await waitFor(() => {
			expect(api.loginAccount).toHaveBeenCalledWith({
				config: {
					id: expect.stringMatching(/^acct-/),
					emailAddress: "eddiewang@163.com",
					displayName: "eddiewang",
					imap: {
						host: "imap.163.com",
						port: 993,
						secure: true,
						username: "eddiewang@163.com",
					},
					smtp: {
						host: "smtp.163.com",
						port: 465,
						secure: true,
						username: "eddiewang@163.com",
					},
				},
				secrets: {
					imapPassword: "secret-password",
					smtpPassword: "secret-password",
				},
			});
		});
	});

	it("shows AI model configuration immediately after mailbox connection without syncing first", async () => {
		const user = userEvent.setup();
		renderOnboarding();
		await pickProvider(user);

		await user.type(screen.getByLabelText("邮箱用户名"), "eddiewang");
		await user.type(screen.getByLabelText("密码"), "secret-password");
		await user.click(screen.getByRole("button", { name: "连接邮箱" }));

		expect(
			await screen.findByRole("heading", { name: "配置 AI 模型" }),
		).toBeInTheDocument();
		expect(api.syncMail).not.toHaveBeenCalled();
		expect(
			screen.queryByText("正在同步您的收件箱，下一步将配置 AI 模型…"),
		).not.toBeInTheDocument();
	});

	it("does not start a duplicate initial sync after users skip AI model setup", async () => {
		const user = userEvent.setup();
		renderOnboarding();
		await pickProvider(user);

		await user.type(screen.getByLabelText("邮箱用户名"), "eddiewang");
		await user.type(screen.getByLabelText("密码"), "secret-password");
		await user.click(screen.getByRole("button", { name: "连接邮箱" }));
		expect(
			await screen.findByRole("heading", { name: "配置 AI 模型" }),
		).toBeInTheDocument();
		expect(
			screen.getByText("请先完成 AI 模型配置，然后再正式进入邮箱。也可以先跳过，稍后在设置中配置。"),
		).toBeInTheDocument();
		expect(api.syncMail).not.toHaveBeenCalled();

		await user.click(screen.getByRole("button", { name: "暂时跳过" }));

		await waitFor(() => {
			expect(screen.getByTestId("location-path")).toHaveTextContent("/");
		});
		expect(api.syncMail).not.toHaveBeenCalled();
		expect(screen.queryByText("正在同步您的收件箱…")).not.toBeInTheDocument();
	});

	it("discovers a single model and uses it without speculative labels", async () => {
		const user = userEvent.setup();
		vi.mocked(api.discoverLlmModels).mockResolvedValueOnce({
			ok: true,
			provider: "openai",
			models: [{ id: "private-chat-model", ownedBy: "local" }],
		});
		renderOnboarding();
		await pickProvider(user);

		await user.type(screen.getByLabelText("邮箱用户名"), "eddiewang");
		await user.type(screen.getByLabelText("密码"), "secret-password");
		await user.click(screen.getByRole("button", { name: "连接邮箱" }));
		await screen.findByRole("heading", { name: "配置 AI 模型" });
		await user.type(screen.getByLabelText("API Key"), "model-secret");

		await waitFor(() => {
			expect(api.discoverLlmModels).toHaveBeenCalledWith({
				baseUrl: undefined,
				apiKey: "model-secret",
			});
		});
		await waitFor(() => {
			expect(screen.getByLabelText("默认模型")).toHaveValue("private-chat-model");
		});
		expect(screen.queryByText(/推荐|高质量|经济|性能更强/)).not.toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: "保存并进入" }));
		await waitFor(() => {
			expect(api.saveLlmSettings).toHaveBeenCalledWith({
				baseUrl: undefined,
				apiKey: "model-secret",
				defaultModel: "private-chat-model",
			});
		});
	});

	it("locks built-in provider domain and server settings outside custom IMAP", async () => {
		const user = userEvent.setup();
		renderOnboarding();
		await pickProvider(user);

		expect(
			screen.getByRole("heading", { name: "配置 163 邮箱" }),
		).toBeInTheDocument();
		expect(screen.getByText("@163.com")).toBeInTheDocument();
		expect(screen.queryByLabelText("邮箱地址")).not.toBeInTheDocument();
		expect(screen.queryByLabelText("IMAP 服务器")).not.toBeInTheDocument();
		expect(screen.queryByLabelText("SMTP 服务器")).not.toBeInTheDocument();
		expect(screen.queryByText("服务器配置（内置，不可编辑）")).not.toBeInTheDocument();
		expect(screen.queryByTestId("fixed-imap-server")).not.toBeInTheDocument();
		expect(screen.queryByTestId("fixed-smtp-server")).not.toBeInTheDocument();

		await user.type(screen.getByLabelText("邮箱用户名"), "alice");
		await user.type(screen.getByLabelText("密码"), "auth-code");
		await user.click(screen.getByRole("button", { name: "连接邮箱" }));

		await waitFor(() => {
			expect(api.loginAccount).toHaveBeenCalledWith({
				config: {
					id: expect.stringMatching(/^acct-/),
					emailAddress: "alice@163.com",
					displayName: "alice",
					imap: {
						host: "imap.163.com",
						port: 993,
						secure: true,
						username: "alice@163.com",
					},
					smtp: {
						host: "smtp.163.com",
						port: 465,
						secure: true,
						username: "alice@163.com",
					},
				},
				secrets: {
					imapPassword: "auth-code",
					smtpPassword: "auth-code",
				},
			});
		});
	});

	it("shows a readable message when the local API is unavailable", async () => {
		const user = userEvent.setup();
		vi.mocked(api.loginAccount).mockRejectedValueOnce(
			new Error("Request failed: 500"),
		);
		renderOnboarding();
		await pickProvider(user);

		await user.type(screen.getByLabelText("邮箱用户名"), "eddiewang");
		await user.type(screen.getByLabelText("密码"), "secret-password");
		await user.click(screen.getByRole("button", { name: "连接邮箱" }));

		// The raw transport error must be mapped to a readable user-facing
		// message instead of leaking the implementation detail.
		expect(await screen.findByText(/失败|重试/)).toBeInTheDocument();
		expect(screen.queryByText("Request failed: 500")).not.toBeInTheDocument();
		expect(api.syncMail).not.toHaveBeenCalled();
	});

	it("keeps the user's picker choice when edition info resolves after an interaction", async () => {
		const user = userEvent.setup();
		let resolveEdition!: (value: Awaited<ReturnType<typeof api.getEditionInfo>>) => void;
		vi.mocked(api.getEditionInfo).mockImplementation(
			() => new Promise((resolve) => { resolveEdition = resolve; }),
		);
		renderOnboarding();

		// The user picks a provider and returns to the picker before the
		// edition request ever answers.
		await pickProvider(user);
		await user.click(screen.getByRole("button", { name: "切换其他邮箱" }));
		expect(
			screen.getByRole("heading", { name: "选择邮箱服务商" }),
		).toBeInTheDocument();

		resolveEdition({
			providerPresets: [{
				id: "corp",
				label: "Corp 邮箱",
				domains: ["corp.example"],
				imap: { host: "imap.corp.example", port: 993, secure: true },
				smtp: { host: "smtp.corp.example", port: 465, secure: true },
			}],
			preferredPresetId: "corp",
			bootToCredentials: true,
			signatureBrandUrl: "",
			features: {
				wecli: false,
				allowanceInvoice: false,
				enterpriseDirectory: false,
				officeSceneDetection: false,
			},
		});

		// The late edition response enriches the picker (extra preset shows
		// up) but must NOT auto-jump to the preferred credentials screen —
		// the user has already interacted with the flow.
		await waitFor(() => {
			expect(screen.getByText("Corp 邮箱")).toBeInTheDocument();
		});
		expect(
			screen.getByRole("heading", { name: "选择邮箱服务商" }),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("heading", { name: "配置 Corp 邮箱" }),
		).not.toBeInTheDocument();
	});
});
