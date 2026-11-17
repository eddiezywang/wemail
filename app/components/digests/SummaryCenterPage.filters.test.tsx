// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * SummaryCenterPage — health filters, search and folder scoping (split part
 * 2 of 3; see `SummaryCenterPage.test.tsx` for the split rationale).
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

	it("keeps aggregate metrics independent from the default attention task filter", () => {
		const aggregateResult = {
			isLoading: false,
			isError: false,
			data: makeHealth({
				total: 20,
				succeeded: 20,
				failed: 0,
				missing: 0,
				invalid: 0,
				pending: 0,
				running: 0,
				skipped: 0,
				retryable: 0,
				items: [
					makeHealthItem({
						emailId: "email-done",
						subject: "已完成摘要",
						state: "succeeded",
					}),
				],
			}),
			refetch: vi.fn(),
		} as unknown as ReturnType<typeof useSummaryHealth>;
		const attentionResult = {
			data: { pages: [makeHealth({
				total: 0,
				succeeded: 0,
				failed: 0,
				missing: 0,
				invalid: 0,
				pending: 0,
				running: 0,
				skipped: 0,
				retryable: 0,
				items: [],
			})], pageParams: [0] },
			fetchNextPage: vi.fn(),
			hasNextPage: false,
			isFetchingNextPage: false,
			refetch: vi.fn(),
		} as unknown as ReturnType<typeof useInfiniteSummaryHealth>;

		vi.mocked(useSummaryHealth).mockReturnValue(aggregateResult);
		vi.mocked(useInfiniteSummaryHealth).mockReturnValue(attentionResult);

		renderPage();

		expect(screen.getByText("没有匹配的智能任务")).toBeInTheDocument();
		expect(useSummaryHealth).toHaveBeenCalledWith(
			"acct-1",
			{ scopeKind: "view", scopeKey: "account-summary-work" },
			true,
		);
		expect(useInfiniteSummaryHealth).toHaveBeenCalledWith(
			"acct-1",
			{ scopeKind: "view", scopeKey: "account-summary-work" },
			true,
			expect.objectContaining({ query: "", state: "attention" }),
		);
	});

	it("updates summary health filters from task controls", async () => {
		const user = userEvent.setup();
		renderPage();

		expect(useInfiniteSummaryHealth).toHaveBeenLastCalledWith(
			"acct-1",
			{ scopeKind: "view", scopeKey: "account-summary-work" },
			true,
			expect.objectContaining({ query: "", state: "attention" }),
		);
		expect(
			screen.getByRole("combobox", { name: "智能任务状态" }),
		).toHaveValue("attention");

		await user.type(
			screen.getByRole("searchbox", { name: "搜索智能任务" }),
			"EHR",
		);
		await user.selectOptions(
			screen.getByRole("combobox", { name: "智能任务状态" }),
			"succeeded",
		);

		expect(useInfiniteSummaryHealth).toHaveBeenLastCalledWith(
			"acct-1",
			{ scopeKind: "view", scopeKey: "account-summary-work" },
			true,
			expect.objectContaining({ query: "EHR", state: "succeeded" }),
		);
	});

	it("keeps the selected task visible when filtered data refreshes", async () => {
		const user = userEvent.setup();
		const item = makeHealthItem({
			emailId: "email-1",
			subject: "EHR系统验证码",
			state: "failed",
		});
		const baseHealth = makeHealth({ items: [item] });
		const filteredHealth = { ...baseHealth, items: [{ ...item }] };
		// The page's `useEffect` keyed on `taskHealth.data` always writes a new
		// Set, so a mock returning a FRESH object per call drives an infinite
		// render loop that kills the vitest fork. Real React Query keeps a
		// stable identity between renders, so cache one result object per
		// filter variant — the data still flips with the query, as in the
		// real refresh this test simulates.
		const resultsByVariant = new Map<string, unknown>();
		vi.mocked(useInfiniteSummaryHealth).mockImplementation(
			(_accountId, _scope, _enabled, filters) => {
				const variant = filters?.query ? "filtered" : "base";
				let result = resultsByVariant.get(variant);
				if (!result) {
					result = {
						data: {
							pages: [variant === "filtered" ? filteredHealth : baseHealth],
							pageParams: [0],
						},
						fetchNextPage: vi.fn(),
						hasNextPage: false,
						isFetchingNextPage: false,
						refetch: vi.fn(),
					};
					resultsByVariant.set(variant, result);
				}
				return result as unknown as ReturnType<typeof useInfiniteSummaryHealth>;
			},
		);

		renderPage();
		await user.click(screen.getAllByText("EHR系统验证码")[0]);
		// The table renders both a mobile card list and the desktop table; in
		// jsdom (no stylesheet) both are visible, so scope to the table — the
		// same approach the retry-selection test uses.
		const table = within(screen.getByRole("table"));
		await user.click(table.getByRole("checkbox", { name: "选择 EHR系统验证码" }));
		await user.type(
			screen.getByRole("searchbox", { name: "搜索智能任务" }),
			"EHR",
		);

		expect(screen.getByTestId("summary-task-inspector")).toHaveTextContent(
			"EHR系统验证码",
		);
		expect(screen.getByRole("button", { name: "重试选中 1" })).toBeInTheDocument();
	});

	it("switches health and retry operations to a selected folder scope", async () => {
		const user = userEvent.setup();
		renderPage();

		await user.selectOptions(
			screen.getByRole("combobox", { name: "智能任务范围" }),
			"folder:告警",
		);

		expect(useInfiniteSummaryHealth).toHaveBeenLastCalledWith(
			"acct-1",
			{ scopeKind: "folder", scopeKey: "告警" },
			true,
			expect.objectContaining({ state: "attention" }),
		);
		expect(useRetryAllSummaries).toHaveBeenLastCalledWith(
			"acct-1",
			{ scopeKind: "folder", scopeKey: "告警" },
		);
	});
});
