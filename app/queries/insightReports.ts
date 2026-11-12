import { useQuery } from "@tanstack/react-query";
import api from "~/services/api";

export function useInsightReport(accountId?: string, emailId?: string) {
	return useQuery({
		queryKey: ["insight-report", accountId ?? "none", emailId ?? "none"],
		queryFn: async () => (await api.getInsightReportForEmail(accountId!, emailId!)).report,
		enabled: Boolean(accountId && emailId),
		staleTime: 15_000,
	});
}
