// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("~/queries/applicationMessages", () => ({
	useInfiniteApplicationMessages: (accountId?: string) => ({
		data: {
			pages: [
				{
					messages: [
						{
							id: "msg-report",
							title: "Q3 报销分析报告已生成",
							preview: "本季度共 12 封报销邮件。",
							createdAt: "2026-08-13T10:00:00.000Z",
							sourceType: "agent",
							readAt: null,
							content: [],
							interactions: [],
							keyMetrics: [
								{ label: "发票总额", value: "¥4,820" },
								{ label: "报销邮件", value: "12" },
							],
							artifact: { id: "art-1", version: 3 },
						},
						{
							id: "msg-plain",
							title: "自动化规则已运行",
							preview: "规则「报销归档」处理了 3 封邮件。",
							createdAt: "2026-08-13T09:00:00.000Z",
							sourceType: "automation",
							readAt: "2026-08-13T09:05:00.000Z",
							content: [],
							interactions: [],
						},
					],
					nextCursor: null,
				},
			],
		},
		isLoading: false,
		isError: false,
		hasNextPage: false,
	}),
	useMarkApplicationMessageRead: () => ({ mutate: vi.fn(), isPending: false }),
	useArchiveApplicationMessage: () => ({ mutate: vi.fn(), isPending: false }),
	useSmartTagTopicAction: () => ({ mutate: vi.fn(), isPending: false }),
}));

const pushStateSpy = vi.fn();
beforeAll(() => {
	window.wemailDesktop = {
		...(window.wemailDesktop ?? {}),
		apiBaseUrl: "http://localhost:0",
	} as typeof window.wemailDesktop;
	window.history.pushState = pushStateSpy as typeof window.history.pushState;
});

import { ApplicationMessageCenter } from "./ApplicationMessageCenter";

function renderCenter() {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={client}>
			<MemoryRouter>
				<ApplicationMessageCenter accountId="acct-1" />
			</MemoryRouter>
		</QueryClientProvider>,
	);
}

describe("ApplicationMessageCenter", () => {
	it("renders artifact messages as report delivery cards with stats and open actions", () => {
		renderCenter();

		const card = screen.getByTestId("report-delivery-card");
		expect(card).toHaveTextContent("Q3 报销分析报告已生成");
		expect(card).toHaveTextContent("报告第 3 版");
		expect(card).toHaveTextContent("¥4,820");
		expect(card).toHaveTextContent("发票总额");
		expect(screen.getByRole("button", { name: "打开报告" })).toBeInTheDocument();
		expect(screen.getByRole("link", { name: "浏览器中打开" })).toBeInTheDocument();
	});

	it("renders non-artifact messages as plain rows", () => {
		renderCenter();

		expect(screen.queryByTestId("report-delivery-card")).toBeInTheDocument();
		expect(screen.getByText("自动化规则已运行")).toBeInTheDocument();
	});

	it("opens the in-app artifact viewer from the report card", async () => {
		renderCenter();

		fireEvent.click(screen.getByTestId("report-delivery-open"));

		await waitFor(() => {
			const frame = document.querySelector("iframe[title='Q3 报销分析报告已生成']");
			expect(frame).not.toBeNull();
		});
	});
});
