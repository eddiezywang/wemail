import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api from "~/services/api";
import type { WemailMcpSettingsInput } from "../../shared/wemail/mcp";

export const mcpKeys = { state: ["settings", "mcp"] as const };

export function useMcpState() {
	return useQuery({
		queryKey: mcpKeys.state,
		queryFn: async () => (await api.getMcpState()).state,
		refetchInterval: 5_000,
	});
}

function useMcpMutation<T>(mutationFn: () => Promise<T>) {
	const client = useQueryClient();
	return useMutation({
		mutationFn,
		onSuccess: () => client.invalidateQueries({ queryKey: mcpKeys.state }),
	});
}

export function useConfigureMcp() {
	const client = useQueryClient();
	return useMutation({
		mutationFn: (input: WemailMcpSettingsInput) => api.configureMcp(input),
		onSuccess: (result) => client.setQueryData(mcpKeys.state, result.state),
	});
}

export function useCreateMcpToken() { return useMcpMutation(api.createMcpToken); }
export function useRotateMcpToken() { return useMcpMutation(api.rotateMcpToken); }
export function useRevokeMcpToken() { return useMcpMutation(api.revokeMcpToken); }
export function useResetMcpCredential() {
	const client = useQueryClient();
	return useMutation({
		mutationFn: api.resetMcpCredential,
		onSuccess: (result) => client.setQueryData(mcpKeys.state, result.state),
	});
}
export function useTerminateMcpSession() {
	const client = useQueryClient();
	return useMutation({
		mutationFn: (sessionHash: string) => api.terminateMcpSession(sessionHash),
		onSuccess: () => client.invalidateQueries({ queryKey: mcpKeys.state }),
	});
}
