// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * SummaryCenterPage — retry actions, task diagnostics and the inspector
 * (split part 3 of 3; see `SummaryCenterPage.test.tsx` for the split
 * rationale).
 */
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useCurrentAccount } from "~/queries/currentAccount";
import { useFolders } from "~/queries/folders";
import {
	useInfiniteSummaryHealth,
	useRetryAllSummaries,
	useSummaryHealth,
} from "~/queries/digests";
import {
	makeHealth,
	makeHealthItem,
	mockDigestHooks,
	renderPage,
} from "./SummaryCenterPage.test-helpers";

const { selectEmailMock } = vi.hoisted(() => ({
	selectEmailMock: vi.fn(),
}));

vi.mock("~/queries/currentAccount", () => ({
	useCurrentAccount: vi.fn(),
}));

vi.mock("~/queries/folders", () => ({
	useFolders: vi.fn(),
}));

vi.mock("~/queries/digests", () => ({
	useInfiniteSummaryHealth: vi.fn(),
	useRetryAllSummaries: vi.fn(),
	useSummaryHealth: vi.fn(),
}));

vi.mock("~/hooks/useUIStore", () => ({
	// SummaryCenterPage consumes the hook through a selector
	// (useUIStore((state) => state.selectEmail)), so the mock must apply it
	// instead of returning the whole state object.
	useUIStore: (selector?: (state: { selectEmail: unknown }) => unknown) => {
		const state = { selectEmail: selectEmailMock };
		return typeof selector === "function" ? selector(state) : state;
	},
}));

// echarts + ResizeObserver are unavailable in jsdom; the throughput panel is
// covered by its backend contract, not this page-level suite.
vi.mock("~/components/digests/SummaryThroughputPanel", () => ({
	__esModule: true,
	SummaryThroughputPanel: () => null,
	default: () => null,
}));

vi.mock("~/queries/usageStats", () => ({
	useUsageTimeseries: vi.fn().mockReturnValue({ data: undefined, isError: false }),
	useUsageStats: vi.fn().mockReturnValue({ data: undefined }),
	useEmailUsage: vi.fn().mockReturnValue({ data: undefined }),
}));

describe("SummaryCenterPage", () => {
	beforeEach(() => {
		vi.clearAllMocks();

		vi.mocked(useCurrentAccount).mockReturnValue({
			data: { account: { id: "acct-1", emailAddress: "user@example.com" } },
		} as unknown as ReturnType<typeof useCurrentAccount>);
		vi.mocked(useFolders).mockReturnValue({
			data: [
				{ id: "inbox", name: "Inbox", unreadCount: 2, totalCount: 3 },
				{ id: "告警", name: "告警", unreadCount: 5, totalCount: 8 },
			],
		} as unknown as ReturnType<typeof useFolders>);

		mockDigestHooks();
	});

	it("selects retryable summary tasks and retries the selected emails", async () => {
		const user = userEvent.setup();
		const retryMutate = vi.fn((_input, options?: { onSuccess?: (result: unknown) => void }) => {
			options?.onSuccess?.({
				queued: 2,
				inserted: 0,
				reset: 0,
				skipped: 0,
			});
		});
		mockDigestHooks({
			retryMutate,
			health: makeHealth({
				items: [
					makeHealthItem({
						emailId: "email-1",
						subject: "EHR系统验证码",
						state: "failed",
					}),
					makeHealthItem({
						emailId: "email-2",
						subject: "绩效管理",
						state: "missing",
					}),
					makeHealthItem({
						emailId: "email-3",
						subject: "已完成摘要",
						state: "succeeded",
					}),
				],
			}),
		});
		renderPage();

		const table = within(screen.getByRole("table"));
		expect(table.getByRole("checkbox", { name: "选择 已完成摘要" })).toBeDisabled();
		expect(table.getByLabelText("任务状态：失败")).toHaveClass(
			"inline-flex",
			"whitespace-nowrap",
		);
		expect(table.getByLabelText("任务状态：未生成")).toHaveClass(
			"inline-flex",
			"whitespace-nowrap",
		);
		expect(table.getByLabelText("任务状态：已完成")).toHaveClass(
			"inline-flex",
			"whitespace-nowrap",
			"text-green",
		);

		await user.click(table.getByRole("checkbox", { name: "选择 EHR系统验证码" }));
		await user.click(table.getByRole("checkbox", { name: "选择 绩效管理" }));

		await user.click(screen.getByRole("button", { name: "重试选中 2" }));

		expect(retryMutate).toHaveBeenCalledWith(
			{ emailIds: ["email-1", "email-2"] },
			expect.objectContaining({
				onSuccess: expect.any(Function),
				onError: expect.any(Function),
			}),
		);
	});

	it("retries all retryable tasks from the header action", async () => {
		const user = userEvent.setup();
		const retryMutate = vi.fn((_input, options?: { onSuccess?: (result: unknown) => void }) => {
			options?.onSuccess?.({ queued: 3, inserted: 0, reset: 0, skipped: 0 });
		});
		mockDigestHooks({
			retryMutate,
			health: makeHealth({
				items: [
					makeHealthItem({ emailId: "email-1", state: "failed" }),
					makeHealthItem({ emailId: "email-2", state: "pending" }),
				],
			}),
		});
		renderPage();

		// Header "重试" opens the scope dialog. It shares its accessible name
		// with per-email row retry buttons, so pick the first (header renders
		// before the table in DOM order), then confirm the default scope.
		const retryButtons = screen.getAllByRole("button", { name: "重试" });
		await user.click(retryButtons[0]);
		await user.click(screen.getByRole("button", { name: /入队/ }));

		expect(retryMutate).toHaveBeenCalledWith(
			{ mode: "missing", limit: 500 },
			expect.objectContaining({ onSuccess: expect.any(Function) }),
		);
	});

	it("surfaces real reasons for stuck pending tasks in the table", () => {
		mockDigestHooks({
			health: makeHealth({
				items: [
					makeHealthItem({
						emailId: "email-1",
						subject: "待处理邮件",
						state: "pending",
						error: "llm-not-configured",
						job: {
							id: "job-1",
							status: "pending",
							attempts: 0,
							maxAttempts: 2,
							createdAt: "2026-07-03T08:00:00.000Z",
							updatedAt: "2026-07-03T08:01:00.000Z",
						},
					}),
				],
			}),
		});
		renderPage();

		expect(screen.getAllByText(/排队中：模型未配置/).length).toBeGreaterThan(0);
		expect(screen.getAllByText("0/2").length).toBeGreaterThan(0);
	});

	it("opens source mail from the selected summary task inspector", async () => {
		const user = userEvent.setup();
		mockDigestHooks({
			health: makeHealth({
				items: [
					makeHealthItem({
						emailId: "email-1",
						subject: "EHR系统验证码",
						state: "failed",
						error: "model-credential-cooldown",
						diagnostic: {
							source: "job",
							errorCode: "model-credential-cooldown",
							errorMessage: "All credentials are cooling down",
							updatedAt: "2026-07-03T06:57:00.000Z",
						},
					}),
				],
			}),
		});
		renderPage();

		await user.click(screen.getAllByText("EHR系统验证码")[0]);

		expect(screen.getByTestId("summary-task-inspector")).toHaveTextContent(
			"模型凭证冷却中",
		);

		await user.click(screen.getByRole("button", { name: "打开邮件" }));

		expect(selectEmailMock).toHaveBeenCalledWith("email-1");
	});
});
