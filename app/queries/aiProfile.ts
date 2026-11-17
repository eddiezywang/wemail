// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api from "~/services/api";
import type { AiProfileSettings } from "../../shared/wemail/settings";

const KEY = ["ai-profile"];

export function useAiProfile() {
	return useQuery<AiProfileSettings | null>({
		queryKey: KEY,
		queryFn: async () => {
			const res = await api.getAiProfile();
			return res.profile;
		},
	});
}

export function useSaveAiProfile() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (input: Partial<Omit<AiProfileSettings, "updatedAt">>) =>
			api.saveAiProfile(input),
		onSuccess: (data) => qc.setQueryData(KEY, data.profile),
	});
}
