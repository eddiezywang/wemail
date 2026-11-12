// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Tag library + per-email tag application hooks (Feature 3).
 *
 * Apply / unapply mutations write user smart-tag relationships, then
 * invalidate the affected message views.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import api from "~/services/api";
import { intelligenceKeys } from "~/queries/intelligence";

export interface MessageTagMutationInput {
	tagId: string;
	tag: string;
	reason?: string;
}

export function useApplyMessageTag(emailId: string) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: async ({ tagId, reason }: MessageTagMutationInput) => {
			await api.applyMessageSmartTag(emailId, tagId, reason);
		},
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: intelligenceKeys.detail(emailId) });
			qc.invalidateQueries({ queryKey: ["emails"] });
			qc.invalidateQueries({ queryKey: ["list-categories"] });
		},
	});
}

export function useUnapplyMessageTag(emailId: string) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: async ({ tagId, reason }: MessageTagMutationInput) => {
			await api.removeMessageSmartTag(emailId, tagId, reason);
		},
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: intelligenceKeys.detail(emailId) });
			qc.invalidateQueries({ queryKey: ["emails"] });
			qc.invalidateQueries({ queryKey: ["list-categories"] });
		},
	});
}
