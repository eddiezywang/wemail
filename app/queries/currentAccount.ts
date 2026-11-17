// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useQuery } from "@tanstack/react-query";
import api from "~/services/api";
import type { AccountCurrentResponse } from "~/services/api";

/**
 * Single-account replacement for the legacy `useMailboxes`/`useMailbox`
 * pair. Fetches `/api/account/current` which returns the configured
 * account or `{ account: null }` when the user has not logged in yet.
 */
export function useCurrentAccount() {
	return useQuery<AccountCurrentResponse>({
		queryKey: ["account", "current"],
		queryFn: ({ signal }) => api.getCurrentAccount(),
	});
}
