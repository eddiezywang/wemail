import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import api from "~/services/api";
import { McpSection } from "./McpSection";

const state = {
	enabled: true,
	port: 43129,
	defaultBodyCharacters: 6000,
	maxBodyCharacters: 20000,
	defaultPageSize: 25,
	maxPageSize: 100,
	maxRecipients: 200,
	maxBatchMessages: 100,
	maxPendingOperations: 100,
	toolTimeoutSeconds: 30,
	endpoint: "http://127.0.0.1:43129/mcp",
	listenerState: "listening" as const,
	credentialState: "ready" as const,
	protocols: ["2025-11-25" as const],
	tools: [
		{
			name: "list_mail_accounts" as const,
			title: "List accounts",
			description: "List accounts",
			domain: "discovery" as const,
			risk: "read" as const,
			maxResponseBytes: 64000,
			available: true,
		},
	],
	token: {
		id: "managed-1",
		kind: "managed" as const,
		fingerprint: "abc123",
		status: "active" as const,
		createdAt: "2026-07-22T00:00:00.000Z",
	},
	legacyTokens: [],
	sessions: [],
	pendingOperationCount: 0,
	operations: [],
};

function renderSection() {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<MemoryRouter>
			<QueryClientProvider client={client}>
				<McpSection />
			</QueryClientProvider>
		</MemoryRouter>,
	);
}

afterEach(() => {
	vi.restoreAllMocks();
	delete window.wemailDesktop;
});

describe("McpSection", () => {
	it("keeps advanced drafts separate from the enable switch", async () => {
		vi.spyOn(api, "getMcpState").mockResolvedValue({ ok: true, state });
		const configure = vi
			.spyOn(api, "configureMcp")
			.mockImplementation(async (input) => ({
				ok: true,
				state: { ...state, ...input },
			}));
		renderSection();
		await userEvent.click(await screen.findByText("诊断与高级连接信息"));

		const input = await screen.findByRole("spinbutton", {
			name: "正文长度上限",
		});
		await userEvent.clear(input);
		await userEvent.type(input, "50000");
		await userEvent.click(screen.getByRole("switch", { name: "启用本地 MCP" }));
		await waitFor(() => expect(configure).toHaveBeenLastCalledWith({ enabled: false }));
		const save = screen.getByRole("button", { name: "保存高级设置" });
		await waitFor(() => expect(save).toBeEnabled());
		await userEvent.click(save);

		await waitFor(() =>
			expect(configure).toHaveBeenLastCalledWith(expect.objectContaining({
				enabled: false,
				port: 43129,
				maxBodyCharacters: 50000,
			})),
		);
	});

	it("validates advanced limits before saving", async () => {
		vi.spyOn(api, "getMcpState").mockResolvedValue({ ok: true, state });
		const configure = vi.spyOn(api, "configureMcp");
		renderSection();
		await userEvent.click(await screen.findByText("诊断与高级连接信息"));

		const input = screen.getByRole("spinbutton", {
			name: "正文长度上限",
		});
		await userEvent.clear(input);
		await userEvent.type(input, "1000001");

		expect(input).toHaveAttribute("aria-invalid", "true");
		expect(screen.getByText(/请输入 1–1,000,000/)).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "保存高级设置" })).toBeDisabled();
		expect(configure).not.toHaveBeenCalled();
	});

	it("renders the live endpoint and public catalog from the server", async () => {
		vi.spyOn(api, "getMcpState").mockResolvedValue({ ok: true, state });
		renderSection();
		expect(
			await screen.findByRole("button", { name: "复制 MCP 配置" }),
		).toBeEnabled();
		expect(screen.getByText(/Bearer •+/)).toBeInTheDocument();
		expect(screen.queryByText(/创建 Token|我已保存/)).not.toBeInTheDocument();

		const diagnostics = screen.getByText("诊断与高级连接信息");
		expect(diagnostics.closest("details")).not.toHaveAttribute("open");
		await userEvent.click(diagnostics);
		expect(screen.getByText(state.endpoint)).toBeInTheDocument();
		expect(screen.getByText("list_mail_accounts")).toBeInTheDocument();
		expect(screen.getByRole("switch", { name: "启用本地 MCP" })).toBeChecked();
		expect(
			screen.getByText(/持有凭据的客户端可直接发送、删除和批量操作邮件/),
		).toBeInTheDocument();
	});

	it("copies through the privileged desktop bridge without rendering the bearer value", async () => {
		const copyMcpConfiguration = vi.fn().mockResolvedValue({
			ok: true,
			target: "codex",
		});
		window.wemailDesktop = { copyMcpConfiguration };
		vi.spyOn(api, "getMcpState").mockResolvedValue({ ok: true, state });
		renderSection();

		await userEvent.click(
			await screen.findByRole("button", { name: "复制 MCP 配置" }),
		);
		expect(copyMcpConfiguration).toHaveBeenCalledWith("codex");
		expect(document.body.textContent).not.toContain("wmcp_");
	});

	it("switches host format without rotating the credential", async () => {
		const copyMcpConfiguration = vi.fn().mockResolvedValue({
			ok: true,
			target: "claude",
		});
		window.wemailDesktop = { copyMcpConfiguration };
		vi.spyOn(api, "getMcpState").mockResolvedValue({ ok: true, state });
		renderSection();
		await userEvent.selectOptions(
			await screen.findByRole("combobox", { name: "MCP 客户端格式" }),
			"claude",
		);
		expect(screen.getByText(/"mcpServers"/)).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "复制 MCP 配置" }));
		expect(copyMcpConfiguration).toHaveBeenCalledWith("claude");
	});

	it("supports reset, legacy metadata, and per-session termination", async () => {
		const user = userEvent.setup();
		const managed = {
			...state,
			legacyTokens: [
				{
					id: "legacy-1",
					kind: "legacy" as const,
					fingerprint: "old123",
					status: "active" as const,
					createdAt: "2026-07-21T00:00:00.000Z",
				},
			],
			sessions: [
				{
					sessionHash: "session-hash",
					protocolVersion: "2025-11-25" as const,
					initialized: true,
					createdAt: "2026-07-22T00:00:00.000Z",
					lastUsedAt: "2026-07-22T00:01:00.000Z",
					inFlightCalls: 0,
				},
			],
		};
		vi.spyOn(api, "getMcpState").mockResolvedValue({ ok: true, state: managed });
		const reset = vi
			.spyOn(api, "resetMcpCredential")
			.mockResolvedValue({ ok: true, state });
		const terminate = vi
			.spyOn(api, "terminateMcpSession")
			.mockResolvedValue({ ok: true, terminated: true });
		renderSection();

		await user.click(await screen.findByText("诊断与高级连接信息"));
		expect(screen.getByText(/1 个旧版连接凭据/)).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "终止" }));
		await waitFor(() =>
			expect(terminate).toHaveBeenCalledWith("session-hash"),
		);
		await user.click(
			screen.getByRole("button", { name: "重置连接凭据" }),
		);
		expect(screen.getByText("重置 MCP 连接凭据？")).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "重置凭据" }));
		await waitFor(() => expect(reset).toHaveBeenCalled());
	});

	it("shows direct MCP operation status without an Action Center approval link", async () => {
		vi.spyOn(api, "getMcpState").mockResolvedValue({
			ok: true,
			state: {
				...state,
				pendingOperationCount: 1,
				operations: [
					{
						id: "op-1",
						type: "send" as const,
						state: "outcome_unknown" as const,
						preview: "Send message",
						expiresAt: "2026-07-22T00:00:00.000Z",
						updatedAt: "2026-07-22T00:01:00.000Z",
						resultCode: "outcome_unknown",
					},
				],
			},
		});
		renderSection();
		await userEvent.click(await screen.findByText("诊断与高级连接信息"));
		expect(screen.getByText("Send message")).toBeInTheDocument();
		expect(
			screen.queryByRole("link", { name: "前往 Action Center" }),
		).not.toBeInTheDocument();
	});
});
