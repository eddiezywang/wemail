// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useUIStore } from "~/hooks/useUIStore";
import InboxRoute from "./inbox";

vi.mock("~/queries/currentAccount", async () => ({
	useCurrentAccount: vi.fn(),
}));

vi.mock("./_workbench", async () => ({
	WorkbenchShell: ({ list }: { list: React.ReactNode; detail: React.ReactNode }) => <>{list}</>,
	MessageListView: ({ query, showCategoryTabs }: {
		query: { data?: { emails: unknown[] } };
		showCategoryTabs?: boolean;
	}) => (
		<div
			data-testid="message-list"
			data-category-tabs={showCategoryTabs ? "true" : "false"}
		>
			{query.data?.emails.length ?? 0}
		</div>
	),
	MessageDetailView: () => null,
}));

import * as currentAccountModule from "~/queries/currentAccount";
import api from "~/services/api";

function renderRoute(initialEntry = "/") {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>
			<MemoryRouter initialEntries={[initialEntry]}>
				<InboxRoute />
			</MemoryRouter>
		</QueryClientProvider>,
	);
}

describe("InboxRoute", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(currentAccountModule.useCurrentAccount).mockReturnValue({
			isLoading: false,
			isError: false,
			data: { account: { id: "acct-1", emailAddress: "user@example.com" } },
		} as unknown as ReturnType<typeof currentAccountModule.useCurrentAccount>);
		vi.spyOn(api, "listEmails").mockResolvedValue({
			emails: [],
			totalCount: 0,
			unreadCount: 0,
		} as never);
		useUIStore.setState({
			mailFilters: {
				unread: false,
				toMe: false,
				ccMe: false,
				hasAttachment: false,
				olderThan: null,
			},
		});
	});

	it("passes the selected system category to the inbox email query", async () => {
		renderRoute("/?category=notification");

		await waitFor(() =>
			expect(api.listEmails).toHaveBeenCalledWith("acct-1", {
				folder: "inbox",
				limit: "50",
				page: "1",
				category: "notification",
				threaded: "true",
			}, expect.anything()),
		);
	});

	it("uses the shared banner-free message list", () => {
		const { getByTestId } = renderRoute();
		expect(getByTestId("message-list")).toHaveAttribute("data-category-tabs", "true");
	});

	it("refetches list emails with active filter params", async () => {
		renderRoute();

		await waitFor(() =>
			expect(api.listEmails).toHaveBeenCalledWith("acct-1", {
				folder: "inbox",
				limit: "50",
				page: "1",
				threaded: "true",
			}, expect.anything()),
		);

		useUIStore.getState().setMailFilter("unread", true);
		useUIStore.getState().setMailFilter("hasAttachment", true);
		useUIStore.getState().setMailFilter("olderThan", "30d");

		await waitFor(() =>
			expect(api.listEmails).toHaveBeenLastCalledWith("acct-1", {
				folder: "inbox",
				limit: "50",
				page: "1",
				unread: "1",
				hasAttachment: "1",
				olderThan: "30d",
				threaded: "true",
			}, expect.anything()),
		);
	});
});
