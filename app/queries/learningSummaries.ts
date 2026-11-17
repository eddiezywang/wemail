// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api from "~/services/api";
import type {
	IntelligenceJobType,
	LearningSummary,
} from "../../shared/wemail/intelligence";

const KEY = (accountId: string) => ["learning-summaries", accountId];

export function useLearningSummaries(accountId: string | undefined) {
	return useQuery<LearningSummary[]>({
		queryKey: KEY(accountId ?? ""),
		enabled: !!accountId,
		queryFn: async () => {
			const res = await api.getLearningSummaries(accountId as string);
			return res.summaries;
		},
	});
}

export function useResetLearned(accountId: string | undefined) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (args: { accountId: string; feature?: IntelligenceJobType }) =>
			api.resetLearned(args),
		onSuccess: () => {
			if (accountId) {
				qc.invalidateQueries({ queryKey: KEY(accountId) });
			}
		},
	});
}
