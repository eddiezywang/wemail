// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Action Center aggregation query (Route C / WP 3H).
 *
 * The Action Center page reads everything needing the user's attention
 * via a single endpoint (`GET /api/action-center`) so the renderer
 * doesn't fan out across `pending-actions`, `todos`, and the workspace
 * filesystem on every poll. Polling at 10s keeps the page reasonably
 * fresh without thrashing the backend (the underlying queries are all
 * cheap reads).
 */

import { useQuery } from "@tanstack/react-query";
import api, { type ActionCenterPayload } from "~/services/api";
import { useCurrentAccount } from "./currentAccount";

/** Stable query-key prefix for the Action Center. */
export const actionCenterQueryKey = (accountId: string | null) =>
	["action-center", accountId] as const;

export function useActionCenter() {
	const account = useCurrentAccount();
	const accountId = account.data?.account?.id ?? null;
	return useQuery<ActionCenterPayload>({
		queryKey: actionCenterQueryKey(accountId),
		queryFn: () => api.getActionCenter(),
		enabled: !!accountId,
		// Lightweight polling — the endpoint is cheap and the user's
		// attention surface should feel close to real-time.
		refetchInterval: 10_000,
		refetchOnWindowFocus: true,
	});
}
