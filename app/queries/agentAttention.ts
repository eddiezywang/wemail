import { useQuery } from "@tanstack/react-query";
import api, { type AgentAttention } from "~/services/api";

export function useAgentAttention(enabled = true) {
	return useQuery<AgentAttention>({
		queryKey: ["agent-attention"],
		queryFn: async () => {
			const { active, failed, pausedConversationIds } = await api.getAgentAttention();
			return { active, failed, pausedConversationIds };
		},
		enabled,
		refetchInterval: 3_000,
		refetchOnWindowFocus: true,
	});
}
