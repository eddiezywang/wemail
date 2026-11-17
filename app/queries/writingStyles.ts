// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api from "~/services/api";
import type { WritingStyle } from "../../shared/wemail/settings";

const KEY = ["writing-styles"];

export function useWritingStyles() {
	return useQuery<WritingStyle[]>({
		queryKey: KEY,
		queryFn: async () => {
			const res = await api.listWritingStyles();
			return res.styles;
		},
	});
}

export function useCreateWritingStyle() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (input: {
			name: string;
			description?: string;
			instructions: string;
		}) => api.createWritingStyle(input),
		onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
	});
}

export function useUpdateWritingStyle() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({
			id,
			update,
		}: {
			id: string;
			update: Partial<{ name: string; description: string; instructions: string }>;
		}) => api.updateWritingStyle(id, update),
		onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
	});
}

export function useDeleteWritingStyle() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (id: string) => api.deleteWritingStyle(id),
		onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
	});
}
