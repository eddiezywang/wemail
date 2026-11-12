// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Snooze (Feature F1) — React Query hooks.
 *
 * The list query refetches every 60s so the "Snoozed" virtual folder
 * empties out as messages wake up server-side. Mutations invalidate
 * both the snoozed list and the inbox/folder caches so the UI reflects
 * the new visibility immediately.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api from "~/services/api";
import { queryKeys } from "./keys";

export const snoozeKeys = {
	list: (accountId: string) => ["snoozed", accountId] as const,
};

export function useSnoozedMessages(accountId: string | undefined) {
	return useQuery<Awaited<ReturnType<typeof api.listSnoozed>>>({
		queryKey: accountId ? snoozeKeys.list(accountId) : ["snoozed", "_disabled"],
		queryFn: () => api.listSnoozed(accountId!),
		enabled: !!accountId,
		// Server poller wakes rows every 60s; mirror that on the client so
		// the list view drains without a manual refresh.
		refetchInterval: 60_000,
	});
}

function invalidateMailViews(qc: ReturnType<typeof useQueryClient>) {
	qc.invalidateQueries({ queryKey: ["emails"] });
	qc.invalidateQueries({ queryKey: ["snoozed"] });
}

export function useSnoozeMessage() {
	const qc = useQueryClient();
	return useMutation<
		Awaited<ReturnType<typeof api.snoozeMessage>>,
		Error,
		{ emailId: string; until: string }
	>({
		mutationFn: ({ emailId, until }) => api.snoozeMessage(emailId, until),
		onSuccess: () => invalidateMailViews(qc),
	});
}

export function useUnsnoozeMessage() {
	const qc = useQueryClient();
	return useMutation<
		Awaited<ReturnType<typeof api.unsnoozeMessage>>,
		Error,
		string
	>({
		mutationFn: (emailId) => api.unsnoozeMessage(emailId),
		onSuccess: () => invalidateMailViews(qc),
	});
}

// Re-export so consumers don't need to dual-import.
export { queryKeys };
