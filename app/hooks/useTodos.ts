// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useMutation, useQueryClient } from "@tanstack/react-query";
import api from "~/services/api";
import { intelligenceKeys } from "~/queries/intelligence";

/** Mutation to mark a todo as complete. */
export function useCompleteTodo(emailId: string | undefined) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (todoId: string) => api.completeTodo(todoId),
		onSuccess: () => {
			if (emailId) {
				qc.invalidateQueries({ queryKey: intelligenceKeys.detail(emailId) });
			}
		},
	});
}
