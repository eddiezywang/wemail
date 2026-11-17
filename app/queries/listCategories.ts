// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Backend-driven list segment-tab categories.
 *
 * Sourced from the canonical DB Service category query. The
 * backend returns system categories first (priority/newsletter/etc.)
 * then dynamic tag categories. We strip the system ones at this
 * boundary — the segment-tab strip should only show real smart tags
 * the orchestrator produced. The list view itself prepends "全部" and
 * "星标" so those defaults are always present even when the dynamic
 * list is empty.
 */

import { useQuery } from "@tanstack/react-query";
import api from "~/services/api";

export interface ListCategory {
	id: string;
	label: string;
	count?: number;
	unreadCount?: number;
	system?: boolean;
}

export function useListCategories(mailboxId: string | undefined) {
	return useQuery<ListCategory[]>({
		queryKey: ["list-categories", mailboxId ?? "_disabled"],
		queryFn: async () => {
			if (!mailboxId) return [];
			const res = await api.listInboxCategories(mailboxId);
			if (!res?.ok) return [];
			return res.categories.map((c) => ({
					id: c.id,
					label: c.label,
					count: c.count,
					unreadCount: c.unreadCount,
					system: c.system,
				}));
		},
		enabled: !!mailboxId,
		staleTime: 30_000,
	});
}
