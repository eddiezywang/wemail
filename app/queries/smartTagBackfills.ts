import { useQuery } from "@tanstack/react-query";
import api from "~/services/api";

export const smartTagBackfillsKey = (accountId: string | undefined) =>
	["smart-tag-backfills", accountId ?? ""] as const;

export function useSmartTagBackfills(accountId: string | undefined) {
	return useQuery({
		queryKey: smartTagBackfillsKey(accountId),
		queryFn: async () => {
			if (!accountId) return [];
			const response = await api.listSmartTagBackfills(accountId, 5);
			return response.runs;
		},
		enabled: !!accountId,
		refetchInterval: (query) =>
			query.state.data?.some((run) => run.status === "running") ? 3_000 : false,
	});
}
