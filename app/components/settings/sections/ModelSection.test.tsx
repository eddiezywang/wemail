import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import api from "~/services/api";
import { ModelSection } from "./ModelSection";

function renderSection() {
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	return render(
		<QueryClientProvider client={client}>
			<ModelSection />
		</QueryClientProvider>,
	);
}

describe("ModelSection discovery", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
		vi.spyOn(api, "getLlmSettings").mockResolvedValue({
			llm: {
				provider: "openai",
				baseUrl: "https://models.example.com/v1",
				defaultModel: "current-model",
				hasApiKey: true,
			},
		});
		vi.spyOn(api, "getLlmStatus").mockResolvedValue({
			configured: true,
			provider: "openai",
			model: "current-model",
		});
		vi.spyOn(api, "discoverLlmModels").mockResolvedValue({
			ok: true,
			provider: "openai",
			models: [{ id: "current-model" }, { id: "other-model", ownedBy: "example" }],
		});
		vi.spyOn(api, "saveLlmSettings").mockResolvedValue({
			ok: true,
			runtimeReloaded: true,
			probe: { ok: true },
			llm: {
				provider: "openai",
				baseUrl: "https://models.example.com/v1",
				defaultModel: "other-model",
				hasApiKey: true,
			},
		});

	});

	it("automatically discovers with the stored key and saves a selected id", async () => {
		const user = userEvent.setup();
		renderSection();

		await waitFor(() => {
			expect(api.discoverLlmModels).toHaveBeenCalledWith({
				provider: "openai",
				baseUrl: "https://models.example.com/v1",
			});
		});
		expect(await screen.findByText("已发现 2 个模型")).toBeInTheDocument();
		// No quality-tier labels on the discovered models. ("推荐" is excluded
		// from the pattern: the default-select now offers 自动（推荐）.)
		expect(screen.queryByText(/高质量|经济|性能更强/)).not.toBeInTheDocument();

		await user.click(screen.getAllByRole("button", { name: "显示模型列表" })[0]!);
		await user.click(screen.getByRole("option", { name: /other-model/ }));
		const advanced = screen.getByText("高级设置").closest("details");
		expect(advanced).not.toHaveAttribute("open");
		await user.click(screen.getByText("高级设置"));
		// The reasoning-effort control is a Radix Select whose listbox cannot
		// mount under jsdom, so the save below carries the default "auto".
		await user.click(screen.getByRole("button", { name: "保存" }));

		await waitFor(() => {
			expect(api.saveLlmSettings).toHaveBeenCalledWith({
				baseUrl: "https://models.example.com/v1",
				defaultModel: "other-model",
				summaryModel: undefined,
				draftModel: undefined,
				agentModel: undefined,
				reasoningEffort: "auto",
			});
		});
	});

	it("shows the unconfigured warning", async () => {
		vi.mocked(api.getLlmSettings).mockResolvedValue({ llm: null });
		vi.mocked(api.getLlmStatus).mockResolvedValue({ configured: false });
		renderSection();
		expect(await screen.findByText(/未配置或无可用密钥/)).toBeInTheDocument();
	});

	it("shows the latest model outage and HTTP status", async () => {
		vi.mocked(api.getLlmStatus).mockResolvedValue({
			configured: true,
			provider: "openai",
			model: "current-model",
			health: {
				availability: "unreachable",
				lastSuccessAt: null,
				lastError: {
					code: "rate_limited",
					status: 429,
					message: "too many requests",
					occurredAt: "2026-08-06T00:00:00.000Z",
				},
			},
		});
		renderSection();

		expect(await screen.findByText(/模型不可达/)).toBeInTheDocument();
		expect(screen.getByText(/HTTP 429/)).toBeInTheDocument();
		expect(screen.getByText(/too many requests/)).toBeInTheDocument();
	});
});
