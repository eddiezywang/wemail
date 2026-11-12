// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * React Query hooks for user-defined smart tags.
 *
 * Used by the simplified "创建智能标签" dialog (Feature 4) and the per-email
 * Smart Tag Picker popover (Feature 3) to keep the tag library and per-
 * email tag application in sync across the renderer.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api from "~/services/api";

export interface UserTag {
	id: string;
	accountId: string;
	name: string;
	description: string;
	prompt: string;
	optimizedPrompt?: string;
	optimizedPromptVersion?: string;
	optimizedAt?: string;
	effectivePrompt: string;
	createdAt: string;
	updatedAt: string;
	count?: number;
	unreadCount?: number;
	feedbackSampleCount?: number;
	positiveFeedbackCount?: number;
	negativeFeedbackCount?: number;
	latestLearningRun?: SmartTagLearningRun;
	latestRetagRun?: SmartTagRetagRun;
}

export interface SmartTagLearningRun {
	id: string;
	status: "generating" | "evaluating" | "activated" | "rejected" | "failed" | "stale";
	sampleCount: number;
	positiveCount: number;
	negativeCount: number;
	validationCount: number;
	currentCorrect: number;
	candidateCorrect: number;
	correctedCount: number;
	regressionCount: number;
	reason?: string;
	createdAt: string;
	completedAt?: string;
}

export interface SmartTagRetagRun {
	id: string;
	status: "running" | "completed" | "failed";
	queuedCount: number;
	processedCount: number;
	failedCount: number;
	retainedCount: number;
	removedCount: number;
}

export const userTagsKey = (accountId: string | undefined) =>
	["user-tags", accountId ?? ""] as const;

export function useUserTags(
	accountId: string | undefined,
	options?: { refetchInterval?: number | false },
) {
	return useQuery({
		queryKey: userTagsKey(accountId),
		queryFn: async () => {
			if (!accountId) return [] as UserTag[];
			const res = await api.listUserTags(accountId);
			return res.tags;
		},
		enabled: !!accountId,
		refetchInterval: options?.refetchInterval,
	});
}

export function useCreateUserTag() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: async (input: {
			accountId: string;
			name: string;
			description: string;
			prompt?: string;
		}) => {
			const res = await api.createUserTag(input);
			return res.tag;
		},
		onSuccess: (_tag, vars) => {
			qc.invalidateQueries({ queryKey: userTagsKey(vars.accountId) });
			qc.invalidateQueries({ queryKey: ["account-tags", vars.accountId] });
			qc.invalidateQueries({ queryKey: ["list-categories", vars.accountId] });
			qc.invalidateQueries({ queryKey: ["emails", vars.accountId] });
			qc.invalidateQueries({ queryKey: ["smart-tag-backfills", vars.accountId] });
		},
	});
}

export function useUpdateUserTag(accountId: string | undefined) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: async (input: {
			id: string;
			name?: string;
			description?: string;
			prompt?: string;
		}) => {
			const { id, ...patch } = input;
			const res = await api.updateUserTag(id, patch);
			return res.tag;
		},
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: userTagsKey(accountId) });
			qc.invalidateQueries({ queryKey: ["account-tags", accountId] });
			qc.invalidateQueries({ queryKey: ["list-categories", accountId] });
			qc.invalidateQueries({ queryKey: ["emails", accountId] });
			qc.invalidateQueries({ queryKey: ["smart-tag-backfills", accountId] });
		},
	});
}

export function useDeleteUserTag(accountId: string | undefined) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: async (id: string) => {
			await api.deleteUserTag(id);
		},
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: userTagsKey(accountId) });
			qc.invalidateQueries({ queryKey: ["account-tags", accountId] });
			qc.invalidateQueries({ queryKey: ["list-categories", accountId] });
			qc.invalidateQueries({ queryKey: ["emails", accountId] });
		},
	});
}

export function useRestoreOriginalUserTag(accountId: string | undefined) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: async (id: string) => {
			const res = await api.restoreOriginalUserTag(id);
			return res.tag;
		},
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: userTagsKey(accountId) });
			qc.invalidateQueries({ queryKey: ["account-tags", accountId] });
			qc.invalidateQueries({ queryKey: ["emails", accountId] });
			qc.invalidateQueries({ queryKey: ["smart-tag-backfills", accountId] });
		},
	});
}
