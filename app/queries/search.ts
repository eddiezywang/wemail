// Copyright (c) 2026 Cloudflare, Inc.
// Modified for WeMail.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useCallback } from "react";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { parseSearchQuery } from "~/lib/search-parser";
import api from "~/services/api";
import type { Email } from "~/types";
import { logicalMailKey } from "shared/folders";
import { queryKeys } from "./keys";

export const SEARCH_PAGE_SIZE = 50;

interface SearchResponse {
	emails: Email[];
	totalCount: number;
	hasMore?: boolean;
	nextCursor?: string;
}

interface SearchPage {
	results: Email[];
	totalCount: number;
	hasMore: boolean;
	nextCursor?: string;
}

async function fetchSearchPage(
	mailboxId: string,
	query: string,
	filters: Record<string, string>,
	page: number,
	signal?: AbortSignal,
): Promise<SearchPage> {
	const parsed = parseSearchQuery(query);
	const params: Record<string, string> = {
		page: String(page),
		limit: String(SEARCH_PAGE_SIZE),
		...filters,
	};
	if (parsed.query) params.query = parsed.query;
	if (parsed.from) params.from = parsed.from;
	if (parsed.to) params.to = parsed.to;
	if (parsed.subject) params.subject = parsed.subject;
	if (parsed.folder) params.folder = parsed.folder;
	if (parsed.date_start) params.date_start = parsed.date_start;
	if (parsed.date_end) params.date_end = parsed.date_end;
	if (parsed.is_read !== undefined) params.is_read = String(parsed.is_read);
	if (parsed.is_starred !== undefined) params.is_starred = String(parsed.is_starred);
	if (parsed.has_attachment) params.has_attachment = "true";

	const data = await api.searchEmails(mailboxId, params, { signal }) as SearchResponse | Email[];
	if (data && typeof data === "object" && "emails" in data) {
		return {
			results: (data as SearchResponse).emails ?? [],
			totalCount: (data as SearchResponse).totalCount ?? 0,
			hasMore: (data as SearchResponse).hasMore ?? Boolean((data as SearchResponse).nextCursor),
			nextCursor: (data as SearchResponse).nextCursor,
		};
	}
	const results = Array.isArray(data) ? data : [];
	return { results, totalCount: results.length, hasMore: false };
}

export function useSearchEmails(
	mailboxId: string | undefined,
	query: string,
	filters: Record<string, string> = {},
) {
	const queryClient = useQueryClient();
	const queryKey = mailboxId && query
			? queryKeys.search.results(mailboxId, query, 1, filters)
			: (["search", "_disabled"] as const);
	const searchQuery = useInfiniteQuery({
		queryKey,
		initialPageParam: 1,
		queryFn: ({ signal, pageParam }) =>
			fetchSearchPage(mailboxId!, query, filters, Number(pageParam), signal),
		getNextPageParam: (lastPage) => lastPage.hasMore ? Number(lastPage.nextCursor ?? 0) || undefined : undefined,
		select: (data) => ({
			...data,
			pages: [{
				results: data.pages.flatMap((page) => page.results).filter((email, index, all) =>
					all.findIndex((candidate) => logicalMailKey({ id: candidate.id, messageId: candidate.message_id }) === logicalMailKey({ id: email.id, messageId: email.message_id })) === index,
				),
				totalCount: data.pages[0]?.totalCount ?? 0,
				hasMore: data.pages.at(-1)?.hasMore ?? false,
				nextCursor: data.pages.at(-1)?.nextCursor,
			}],
		}),
		enabled: !!mailboxId && !!query,
		retry: 3,
	});
	const refreshLatestPage = useCallback(async () => {
		if (!mailboxId || !query) return undefined;
		const latest = await fetchSearchPage(mailboxId, query, filters, 1);
		queryClient.setQueryData<{ pages: SearchPage[]; pageParams: unknown[] }>(queryKey, (current) => {
			if (!current?.pages.length) return { pages: [latest], pageParams: [1] };
			const existing = current.pages.flatMap((page) => page.results);
			const latestKeys = new Set(latest.results.map((email) => logicalMailKey({ id: email.id, messageId: email.message_id })));
			const merged = [...latest.results, ...existing.filter((email) => !latestKeys.has(logicalMailKey({ id: email.id, messageId: email.message_id })) )];
			return { ...current, pages: [{ ...latest, results: merged }, ...current.pages.slice(1)] };
		});
		return latest;
	}, [filters, mailboxId, query, queryClient, queryKey]);
	return { ...searchQuery, refreshLatestPage };
}
