import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AgentJsonValue } from "../../shared/wemail/agentProtocol";
import api from "~/services/api";

export const agentLearningKey = ["agent-learning-preferences"] as const;

export function useAgentLearningPreferences() {
	return useQuery({
		queryKey: agentLearningKey,
		queryFn: () => api.getAgentLearningPreferences(),
	});
}

export function useCorrectAgentLearningPreference() {
	const client = useQueryClient();
	return useMutation({
		mutationFn: (input: { key: string; value: AgentJsonValue }) =>
			api.correctAgentLearningPreference(input.key, input.value),
		onSuccess: () => client.invalidateQueries({ queryKey: agentLearningKey }),
	});
}

export function useDeleteAgentLearningPreference() {
	const client = useQueryClient();
	return useMutation({
		mutationFn: (key: string) => api.deleteAgentLearningPreference(key),
		onSuccess: () => client.invalidateQueries({ queryKey: agentLearningKey }),
	});
}

export function useClearAgentLearning() {
	const client = useQueryClient();
	return useMutation({
		mutationFn: () => api.clearAgentLearning(),
		onSuccess: () => client.invalidateQueries({ queryKey: agentLearningKey }),
	});
}
