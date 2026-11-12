// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * SummaryCenterPage — page shell, deep links and infinite scroll.
 *
 * This suite was split out of a single 13-case file whose jsdom worker fork
 * died after ~7 cases ("Worker exited unexpectedly"), wedging the full
 * renderer run. Each sibling file now owns a slice of the cases; shared
 * fixtures live in `SummaryCenterPage.test-helpers.tsx`.
 */
import { fireEvent, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useCurrentAccount } from "~/queries/currentAccount";
import { useFolders } from "~/queries/folders";
import { useInfiniteSummaryHealth } from "~/queries/digests";
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
	// (useUIStore((state) => state.selectEmail)), so the mock must apply the
	// selector instead of returning the whole state object.
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

	it("uses the continuous workbench surface instead of a standalone outer card", () => {
		renderPage();

		const page = screen.getByTestId("summary-center-page");
		expect(page).toHaveClass("bg-transparent");
		expect(page).not.toHaveClass("rounded-xl");
		expect(page).not.toHaveClass("border");
		expect(page).not.toHaveClass("shadow-[var(--shadow-2)]");
	});

	it("renders a focused task-management shell without digest tabs", () => {
		renderPage();

		expect(
			screen.getByRole("heading", { name: "智能中心" }),
		).toBeInTheDocument();
		expect(
			screen.getByText(
				"集中查看邮件智能处理状态，定位异常任务并按需重新生成。",
			),
		).toBeInTheDocument();
		expect(screen.queryByRole("tab", { name: "生成任务" })).toBeNull();
		expect(screen.queryByRole("tab", { name: "汇总摘要" })).toBeNull();
		expect(screen.queryByRole("tab", { name: "规则与设置" })).toBeNull();

		// The throughput panel is mocked to null in this suite (echarts /
		// ResizeObserver are unavailable in jsdom), so aggregate metrics are
		// not asserted here — only the task shell itself.
		expect(screen.getByTestId("summary-task-table-scroll")).toBeInTheDocument();
		expect(screen.getByText("没有匹配的智能任务")).toBeInTheDocument();
	});

	it("applies the pending task filter from the deep link", () => {
		renderPage("/digests?tab=tasks&filter=pending");

		expect(
			screen.getByRole("combobox", { name: "智能任务状态" }),
		).toHaveValue("pending");
		expect(useInfiniteSummaryHealth).toHaveBeenLastCalledWith(
			"acct-1",
			{ scopeKind: "view", scopeKey: "account-summary-work" },
			true,
			expect.objectContaining({ state: "pending" }),
		);
	});

	it("ignores a removed history deep link and shows the task list", () => {
		renderPage("/digests?tab=history");

		expect(
			screen.getByRole("combobox", { name: "智能任务状态" }),
		).toHaveValue("attention");
		expect(screen.getByTestId("summary-task-table-scroll")).toBeInTheDocument();
		expect(screen.queryByRole("region", { name: "汇总摘要历史" })).toBeNull();
	});

	it("loads the next 20 tasks near the bottom of the list", () => {
		const fetchNextPage = vi.fn();
		mockDigestHooks({
			fetchNextPage,
			health: makeHealth({
				hasMore: true,
				nextOffset: 20,
				items: [makeHealthItem({ emailId: "email-1" })],
			}),
		});
		renderPage();

		const scroll = screen.getByTestId("summary-task-table-scroll");
		Object.defineProperties(scroll, {
			clientHeight: { configurable: true, value: 400 },
			scrollHeight: { configurable: true, value: 1_000 },
		});
		fireEvent.scroll(scroll, { target: { scrollTop: 500 } });

		expect(fetchNextPage).toHaveBeenCalledTimes(1);
	});
});
