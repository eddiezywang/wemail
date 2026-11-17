import { useMutation, useQueryClient } from "@tanstack/react-query";
import api from "~/services/api";
import { intelligenceKeys } from "~/queries/intelligence";
import { userTagsKey } from "~/queries/userTags";
import type {
	SmartTagPromotionCreateRequest,
	SmartTagPromotionPreviewRequest,
} from "shared/wemail/intelligence";

export function usePreviewSmartTagPromotion() {
	return useMutation({
		mutationFn: async (input: SmartTagPromotionPreviewRequest) => {
			const response = await api.previewSmartTagPromotion(input);
			return response.draft;
		},
	});
}

export function useCreateSmartTagPromotion(accountId: string | undefined) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: async (input: SmartTagPromotionCreateRequest) => {
			const response = await api.createSmartTagPromotion(input);
			return response;
		},
		onSuccess: (response) => {
			void queryClient.invalidateQueries({
				queryKey: intelligenceKeys.detail(response.sourceEmailId),
			});
			void queryClient.invalidateQueries({ queryKey: userTagsKey(accountId) });
			void queryClient.invalidateQueries({ queryKey: ["account-tags", accountId] });
			void queryClient.invalidateQueries({ queryKey: ["list-categories", accountId] });
			void queryClient.invalidateQueries({ queryKey: ["emails", accountId] });
			void queryClient.invalidateQueries({ queryKey: ["smart-tag-backfills", accountId] });
		},
	});
}
