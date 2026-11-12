// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SummaryHealthStatus } from "shared/wemail/intelligence";

const useUsageTimeseriesMock = vi.hoisted(() => vi.fn());
vi.mock("~/queries/usageStats", () => ({
	useUsageTimeseries: useUsageTimeseriesMock,
}));

import { SummaryInsightCards } from "./SummaryInsightCards";

const health: SummaryHealthStatus = {
	total: 128,
	succeeded: 120,
	failed: 3,
	missing: 2,
	invalid: 0,
	pending: 4,
	running: 1,
	retryable: 3,
};

/** 168 hourly buckets split across two series; first half quiet, second half busy. */
function makeSeries() {
	const calls = new Array(168).fill(0).map((_, index) => (index < 84 ? 1 : 2));
	return {
		buckets: new Array(168).fill(""),
		series: [{ label: "摘要", category: "summary", calls, tokens: calls.map((v) => v * 100) }],
		totals: { calls: 252, tokens: 25_200 },
	};
}

describe("SummaryInsightCards", () => {
	beforeEach(() => {
		useUsageTimeseriesMock.mockReset().mockReturnValue({ data: makeSeries() });
	});

	it("renders trend cards with an up delta when activity grows", () => {
		render(<SummaryInsightCards accountId="acct-1" health={health} onFilter={vi.fn()} />);
		const calls = screen.getByTestId("insight-card-calls");
		expect(calls).toHaveTextContent("252");
		// Daily buckets: first half 72, second half 180 → +150%.
		expect(calls).toHaveTextContent("+150%");
		expect(screen.getByTestId("insight-card-tokens")).toHaveTextContent("25.2k");
	});

	it("exposes a filter action for failed tasks", () => {
		const onFilter = vi.fn();
		render(<SummaryInsightCards accountId="acct-1" health={health} onFilter={onFilter} />);
		fireEvent.click(screen.getByRole("button", { name: /筛选失败任务/ }));
		expect(onFilter).toHaveBeenCalledWith("failed");
	});

	it("shows a queue action while tasks are processing", () => {
		const onFilter = vi.fn();
		render(<SummaryInsightCards accountId="acct-1" health={health} onFilter={onFilter} />);
		const queue = screen.getByTestId("insight-card-queue");
		expect(queue).toHaveTextContent("1 生成中");
		expect(queue).toHaveTextContent("4 排队");
		fireEvent.click(screen.getByRole("button", { name: /查看处理中的任务/ }));
		expect(onFilter).toHaveBeenCalledWith("running");
	});

	it("degrades to placeholders while the timeseries loads", () => {
		useUsageTimeseriesMock.mockReturnValue({ data: undefined, isError: false });
		render(<SummaryInsightCards accountId="acct-1" health={health} onFilter={vi.fn()} />);
		expect(screen.getByTestId("insight-card-calls")).toHaveTextContent("—");
	});
});
