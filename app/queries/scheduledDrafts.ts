// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Scheduled drafts (Feature F1) — React Query hooks.
 *
 * Refresh periodically because send failures and expired leases do not
 * currently publish an outbox change event to the renderer.
 */

import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { WemailDraftInput } from "../../shared/wemail/mail";
import api from "~/services/api";

export const scheduledKeys = {
	list: (accountId: string) => ["scheduled-drafts", accountId] as const,
};

export function useScheduledDrafts(accountId: string | undefined) {
	return useInfiniteQuery({
		queryKey: accountId
			? scheduledKeys.list(accountId)
			: ["scheduled-drafts", "_disabled"],
		initialPageParam: 1,
		queryFn: ({ pageParam }) => api.listScheduledPage(accountId!, pageParam, 50),
		getNextPageParam: (lastPage, _pages, lastPageParam) =>
			lastPage.hasMore ? Number(lastPageParam) + 1 : undefined,
		select: (data) => ({
			...data,
			scheduled: data.pages.flatMap((page) => page.scheduled),
			totalCount: data.pages[0]?.totalCount ?? 0,
		}),
		enabled: !!accountId,
		refetchInterval: 15_000,
	});
}

export function useScheduleDraft() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (input: {
			draftId: string;
			sendAt: string;
			payload?: WemailDraftInput;
		}) =>
			api.scheduleDraft(input.draftId, {
				sendAt: input.sendAt,
				payload: input.payload,
			}),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["scheduled-drafts"] });
		},
	});
}

export function useCancelScheduledDraft() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (input: { id: string; accountId: string }) =>
			api.cancelScheduledDraft(input.id, input.accountId),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["scheduled-drafts"] });
		},
		onError: () => { qc.invalidateQueries({ queryKey: ["scheduled-drafts"] }); },
	});
}

export function useDeleteScheduledDraft() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (input: { id: string; accountId: string }) =>
			api.deleteScheduledDraft(input.id, input.accountId),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["scheduled-drafts"] });
		},
		onError: () => { qc.invalidateQueries({ queryKey: ["scheduled-drafts"] }); },
	});
}
