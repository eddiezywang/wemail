// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import {
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import api, { type LlmStatus } from "~/services/api";
import type { EmailIntelligenceState } from "~/types/wemail";
import type { WemailDraftInput } from "../../shared/wemail/mail";

const INTELLIGENCE_KEY = "wemail-intelligence";

export const intelligenceKeys = {
	detail: (emailId: string) =>
		[INTELLIGENCE_KEY, "messages", emailId] as const,
};

/**
 * Fetch intelligence results for a single email. DB Service commit events
 * invalidate this exact key when an artifact becomes current.
 */
export function useIntelligence(emailId: string | undefined) {
	return useQuery<EmailIntelligenceState>({
		queryKey: emailId
			? intelligenceKeys.detail(emailId)
			: [INTELLIGENCE_KEY, "_disabled"],
		queryFn: ({ signal }) => api.getIntelligence(emailId!, { signal }),
		// Intelligence state carries AI summaries/tags; release it shortly
		// after the mail detail view leaves instead of the 5-minute default.
		gcTime: 120_000,
		enabled: !!emailId,
	});
}
/**
 * Fully typed alias for {@link useIntelligence} returning
 * `EmailIntelligenceState`.
 */
export function useEmailIntelligence(emailId: string | undefined) {
	return useIntelligence(emailId);
}

/** Query the LLM configuration status. Does not poll. */
export function useLlmStatus() {
	return useQuery<LlmStatus>({
		queryKey: ["system", "llm-status"],
		queryFn: () => api.getLlmStatus(),
	});
}

export function useSendWemailDraft() {
	return useMutation({
		mutationFn: (draft: WemailDraftInput) => api.sendWemailDraft(draft),
	});
}

// ---------- Trigger mutations ----------

/** Trigger summary generation for a message. */
export function useTriggerSummary(emailId: string | undefined) {
	const qc = useQueryClient();
	return useMutation<{ ok: boolean }, Error, void>({
		mutationFn: () => {
			if (!emailId) throw new Error("missing emailId");
			return api.triggerSummary(emailId);
		},
		onSuccess: () => {
			if (emailId) {
				qc.invalidateQueries({ queryKey: intelligenceKeys.detail(emailId) });
			}
		},
	});
}

/** Trigger tag generation for a message. */
export function useTriggerTags(emailId: string | undefined) {
	const qc = useQueryClient();
	return useMutation<{ ok: boolean }, Error, void>({
		mutationFn: () => {
			if (!emailId) throw new Error("missing emailId");
			return api.triggerTags(emailId);
		},
		onSuccess: () => {
			if (emailId) {
				qc.invalidateQueries({ queryKey: intelligenceKeys.detail(emailId) });
			}
		},
	});
}

/** Trigger reply decision for a message. */
export function useTriggerReplyDecision(emailId: string | undefined) {
	const qc = useQueryClient();
	return useMutation<{ ok: boolean }, Error, void>({
		mutationFn: () => {
			if (!emailId) throw new Error("missing emailId");
			return api.triggerReplyDecision(emailId);
		},
		onSuccess: () => {
			if (emailId) {
				qc.invalidateQueries({ queryKey: intelligenceKeys.detail(emailId) });
			}
		},
	});
}

/** Retry a failed summary for a message. */
export function useRetrySummary(emailId: string | undefined) {
	const qc = useQueryClient();
	return useMutation<{ ok: boolean }, Error, void>({
		mutationFn: () => {
			if (!emailId) throw new Error("missing emailId");
			return api.retrySummary(emailId);
		},
		onSuccess: () => {
			if (emailId) {
				qc.invalidateQueries({ queryKey: intelligenceKeys.detail(emailId) });
			}
		},
	});
}

