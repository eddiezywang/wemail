// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useQuery } from "@tanstack/react-query";
import api from "~/services/api";
import type { Folder } from "~/types";
import { queryKeys } from "./keys";

export function useFolders(mailboxId: string | undefined) {
	return useQuery<Folder[]>({
		queryKey: mailboxId
			? queryKeys.folders.list(mailboxId)
			: ["folders", "_disabled"],
		queryFn: () => api.listFolders(mailboxId!) as Promise<Folder[]>,
		enabled: !!mailboxId,
	});
}
