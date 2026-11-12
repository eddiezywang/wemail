// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api, {
	type LlmSettings,
	type LlmStatus,
	type SaveLlmSettingsInput,
} from "~/services/api";

const SETTINGS_KEY = ["settings", "llm"];
const STATUS_KEY = ["settings", "llm-status"];

export function useLlmSettings() {
	return useQuery<LlmSettings | null>({
		queryKey: SETTINGS_KEY,
		queryFn: async () => {
			const res = await api.getLlmSettings();
			return res.llm;
		},
	});
}

export function useSaveLlmSettings() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (input: SaveLlmSettingsInput) => api.saveLlmSettings(input),
		onSuccess: (data) => {
			qc.setQueryData(SETTINGS_KEY, data.llm);
			qc.invalidateQueries({ queryKey: STATUS_KEY });
		},
	});
}

export function useDiscoverLlmModels() {
	return useMutation({
		mutationFn: (input: import("~/services/api").DiscoverLlmModelsInput) =>
			api.discoverLlmModels(input),
	});
}

export function useActivateFreeTrial() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (input: { username: string; email?: string }) =>
			api.activateFreeTrial(input.username, input.email),
		onSuccess: (data) => {
			qc.setQueryData(SETTINGS_KEY, data.llm);
			qc.invalidateQueries({ queryKey: STATUS_KEY });
		},
	});
}

export function useFreeTrialResource() {
	return useQuery<import("~/services/api").FreeTrialResourceInfo | null>({
		queryKey: ["settings", "llm", "free-trial"],
		queryFn: async () => {
			const res = await api.getFreeTrialResource();
			return res.resource;
		},
		staleTime: 60_000,
	});
}

export function useLlmStatus() {
	return useQuery<LlmStatus>({
		queryKey: STATUS_KEY,
		queryFn: () => api.getLlmStatus(),
		staleTime: 30_000,
		refetchInterval: 15_000,
		refetchOnWindowFocus: true,
	});
}
