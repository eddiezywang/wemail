// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Shared fixtures for the SummaryCenterPage suites.
 *
 * The page-level suite used to be a single 13-case file whose jsdom worker
 * fork died partway through ("Worker exited unexpectedly"), wedging the full
 * renderer run. The cases are now split across sibling `*.test.tsx` files so
 * each vitest fork carries only a slice; this module holds the render/mocking
 * helpers they share. The `vi.mock(...)` declarations themselves stay in each
 * test file — vitest hoists them per file, so they cannot live here.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { vi } from "vitest";
import type {
	SummaryHealthItem,
	SummaryHealthStatus,
} from "shared/wemail/intelligence";
import SummaryCenterPage from "./SummaryCenterPage";
import {
	useInfiniteSummaryHealth,
	useRetryAllSummaries,
	useSummaryHealth,
} from "~/queries/digests";

export function renderPage(initialEntry = "/digests"): ReturnType<typeof render> {
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: {
				retry: false,
			},
		},
	});

	return render(
		<QueryClientProvider client={queryClient}>
			<MemoryRouter initialEntries={[initialEntry]}>
				<SummaryCenterPage />
			</MemoryRouter>
		</QueryClientProvider>,
	);
}

export function makeHealthItem(
	overrides: Partial<SummaryHealthItem> & Pick<SummaryHealthItem, "emailId">,
): SummaryHealthItem {
	return {
		subject: "测试邮件",
		sender: "sender@example.com",
		receivedAt: "2026-07-03T08:00:00.000Z",
		state: "failed",
		error: null,
		...overrides,
	};
}

export function makeHealth(
	overrides: Partial<SummaryHealthStatus> = {},
): SummaryHealthStatus {
	return {
		total: 2842,
		succeeded: 1774,
		failed: 1026,
		missing: 18,
		invalid: 20,
		pending: 18,
		running: 4,
		skipped: 0,
		retryable: 1064,
		items: [],
		...overrides,
	};
}

export function mockDigestHooks({
	health = makeHealth(),
	retryMutate = vi.fn(),
	fetchNextPage = vi.fn(),
}: {
	health?: SummaryHealthStatus;
	retryMutate?: ReturnType<typeof vi.fn>;
	fetchNextPage?: ReturnType<typeof vi.fn>;
} = {}) {
	vi.mocked(useSummaryHealth).mockReturnValue({
		isLoading: false,
		isError: false,
		data: health,
		refetch: vi.fn(),
	} as unknown as ReturnType<typeof useSummaryHealth>);
	vi.mocked(useInfiniteSummaryHealth).mockReturnValue({
		data: { pages: [health], pageParams: [0] },
		fetchNextPage,
		hasNextPage: health.hasMore ?? false,
		isFetchingNextPage: false,
		refetch: vi.fn(),
	} as unknown as ReturnType<typeof useInfiniteSummaryHealth>);

	vi.mocked(useRetryAllSummaries).mockReturnValue({
		mutate: retryMutate,
		isPending: false,
	} as unknown as ReturnType<typeof useRetryAllSummaries>);
}
