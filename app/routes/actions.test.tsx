// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Renderer tests for the Action Center feed (Route C / WP 3H).
 *
 * The route shell (`actions.tsx`) is a thin wrapper around `WorkbenchShell`
 * which transitively pulls in EmailPanel, AgentSidebar, etc. — exercising
 * those in jsdom would just test plumbing. So these tests render the
 * `ActionCenterFeed` component directly and mock the API + account hook.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ActionCenterFeed } from "~/components/actions/ActionCenterFeed";

vi.mock("~/services/api", async (importOriginal) => {
	const actual = await importOriginal<typeof import("~/services/api")>();
	return {
		...actual,
		default: {
			...actual.default,
			getActionCenter: vi.fn(),
			completeTodo: vi.fn(),
			resolvePendingAction: vi.fn(),
		},
	};
});

vi.mock("~/queries/currentAccount", async () => {
	return { useCurrentAccount: vi.fn() };
});

import apiMod from "~/services/api";
import * as accountMod from "~/queries/currentAccount";

function mockAccount(id: string | null) {
	vi.mocked(accountMod.useCurrentAccount).mockReturnValue({
		isLoading: false,
		isError: false,
		data: id
			? { account: { id, emailAddress: `${id}@x.com` } }
			: { account: null },
	} as unknown as ReturnType<typeof accountMod.useCurrentAccount>);
}

function renderFeed() {
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	const utils = render(
		<QueryClientProvider client={client}>
			<MemoryRouter initialEntries={["/actions"]}>
				<ActionCenterFeed />
			</MemoryRouter>
		</QueryClientProvider>,
	);
	return { ...utils, client };
}

describe("ActionCenterFeed", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockAccount("acct-1");
	});

	it("shows the empty state when there are no todos, learnings, or insights", async () => {
		vi.mocked(apiMod.getActionCenter).mockResolvedValue({
			todos: [],
			smartTagActions: [],
			smartTagPromptRevisions: [],
			curatorInsights: null,
			generatedAt: "2026-04-28T12:00:00.000Z",
		});
		renderFeed();
		expect(
			await screen.findByTestId("action-center-empty"),
		).toBeInTheDocument();
		expect(screen.getByTestId("action-center-page")).toBeInTheDocument();
		expect(
			screen.getByRole("heading", { name: "行动中心" }),
		).toBeInTheDocument();
		expect(
			screen.getByText("邮件待办和智能标签学习会集中出现在这里。确认操作始终保留在原对话中。"),
		).toBeInTheDocument();
		expect(screen.getByText("当前没有待处理事项")).toBeInTheDocument();
		expect(screen.queryByTestId("action-center-curator-empty")).toBeNull();
	});

	it("renders open todos and triggers complete mutation on click", async () => {
		vi.mocked(apiMod.getActionCenter).mockResolvedValue({
			todos: [
				{
					id: "todo-1",
					emailId: "email-1",
					accountId: "acct-1",
					title: "Reply by Friday",
					done: false,
					status: "confirmed",
					source: "user",
					createdAt: "2026-04-28T10:00:00.000Z",
					updatedAt: "2026-04-28T10:00:00.000Z",
					agentStatus: "to-respond",
				},
			],
			smartTagActions: [],
			smartTagPromptRevisions: [],
			curatorInsights: null,
			generatedAt: "2026-04-28T12:00:00.000Z",
		});
		vi.mocked(apiMod.completeTodo).mockResolvedValue({ ok: true });

		const user = userEvent.setup();
		renderFeed();
		expect(
			await screen.findByTestId("action-center-todo-title"),
		).toHaveTextContent("Reply by Friday");
		expect(screen.getByTestId("action-center-todo-status")).toHaveTextContent(
			"待回复",
		);

		await user.click(screen.getByTestId("action-center-todo-complete"));
		await waitFor(() => {
			expect(apiMod.completeTodo).toHaveBeenCalledWith("todo-1");
		});
	});

	it("renders curator insights when present", async () => {
		vi.mocked(apiMod.getActionCenter).mockResolvedValue({
			todos: [],
			smartTagActions: [],
			smartTagPromptRevisions: [],
			curatorInsights: {
				date: "2026-04-27",
				content: "# What I learned\n\n- Replies are getting shorter.\n",
			},
			generatedAt: "2026-04-28T12:00:00.000Z",
		});
		renderFeed();
		expect(
			await screen.findByTestId("action-center-curator-date"),
		).toHaveTextContent("2026-04-27");
		const pre = screen.getByTestId("action-center-curator-content");
		expect(pre.tagName.toLowerCase()).toBe("pre");
		expect(pre.textContent).toContain("Replies are getting shorter.");
	});

	it("renders smart tag feedback as queued batch learning instead of prompt text", async () => {
		vi.mocked(apiMod.getActionCenter).mockResolvedValue({
			todos: [],
			smartTagActions: [
				{
					id: "sta-1",
					accountId: "acct-1",
					emailId: "email-1",
					tagName: "newsletter",
					actionType: "remove",
					feedbackType: "negative",
					reason: "不是订阅内容",
					createdAt: "2026-04-28T11:00:00.000Z",
				},
			],
			smartTagPromptRevisions: [
				{
					id: "rev-1",
					accountId: "acct-1",
					tagId: "tag-1",
					tagName: "newsletter",
					oldPrompt: "old",
					newPrompt: "new",
					summary: "根据 1 条纠偏更新",
					actionCount: 1,
					createdAt: "2026-04-28T12:00:00.000Z",
				},
			],
			smartTagLearningRuns: [
				{
					id: "run-1",
					accountId: "acct-1",
					tagId: "tag-1",
					tagName: "newsletter",
					status: "activated",
					sampleCount: 24,
					positiveCount: 12,
					negativeCount: 12,
					optimizationCount: 16,
					validationCount: 8,
					currentCorrect: 5,
					candidateCorrect: 8,
					correctedCount: 3,
					regressionCount: 0,
					createdAt: "2026-04-28T12:00:00.000Z",
					completedAt: "2026-04-28T12:10:00.000Z",
					activatedAt: "2026-04-28T12:10:00.000Z",
				},
			],
			curatorInsights: null,
			generatedAt: "2026-04-28T12:00:00.000Z",
		});
		renderFeed();
		expect(
			await screen.findByTestId("action-center-smart-tags"),
		).toBeInTheDocument();
		expect(screen.getByTestId("smart-tag-action-row")).toHaveTextContent(
			"等待批量优化",
		);
		expect(screen.getByTestId("smart-tag-action-row")).not.toHaveTextContent(
			"不是订阅内容",
		);
		expect(screen.getByTestId("smart-tag-learning-run-row")).toHaveTextContent(
			"验证 5/8 → 8/8",
		);
		expect(screen.getByTestId("smart-tag-revision-row")).toHaveTextContent(
			"根据 1 条纠偏更新",
		);
	});

	it("shows the no-account placeholder when the user is not signed in", async () => {
		mockAccount(null);
		renderFeed();
		expect(
			await screen.findByTestId("action-center-no-account"),
		).toBeInTheDocument();
		// API must not be called without an account — the hook is gated on
		// `enabled: !!accountId`.
		expect(apiMod.getActionCenter).not.toHaveBeenCalled();
	});
});
