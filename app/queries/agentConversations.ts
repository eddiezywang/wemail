// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api from "~/services/api";
import type { ConversationState } from "../../shared/wemail/conversationState";

export interface AgentConversationSummary {
	id: string;
	accountId?: string;
	title?: string;
	createdAt: string;
	updatedAt: string;
	archivedAt?: string;
	pinnedAt?: string;
	/** Originating bot-channel platform ("wecom"/"feishu") when started from a channel. */
	channelPlatform?: string;
}

export interface UseAgentConversationsOptions {
	includeArchived?: boolean;
	/** Case-insensitive substring filter on title. Empty string == no filter. */
	search?: string;
	/** Restrict to a single mailbox account. Empty string == all accounts. */
	accountId?: string;
}

const LIST_KEY = (opts: UseAgentConversationsOptions) =>
	[
		"agent-conversations",
		{
			includeArchived: !!opts.includeArchived,
			search: opts.search?.trim() || "",
			accountId: opts.accountId || "",
		},
	] as const;

export function useAgentConversations(
	enabled: boolean,
	options: UseAgentConversationsOptions = {},
) {
	const includeArchived = !!options.includeArchived;
	const search = options.search?.trim() || undefined;
	const accountId = options.accountId || undefined;
	return useQuery<AgentConversationSummary[]>({
		queryKey: LIST_KEY({ includeArchived, search, accountId }),
		queryFn: async () => {
			const res = await api.listAgentConversations({
				includeArchived,
				search,
				accountId,
			});
			return res.conversations;
		},
		// Agent conversation payloads can be large (messages/runs/tools are
		// all Record maps); keep them around briefly after they go inactive
		// instead of the 5-minute default, so memory is reclaimed sooner.
		gcTime: 60_000,
		enabled,
	});
}

export function useAgentConversationState(id: string | null) {
	return useQuery<ConversationState | null>({
		queryKey: ["agent-conversation-state", id],
		queryFn: async () => {
			if (!id) return null;
			return (await api.getAgentConversationState(id)).state;
		},
		// ConversationState is the largest cached payload in the app (full
		// message/run/tool/confirmation maps); 60s GC keeps a closed
		// conversation from lingering for the 5-minute default.
		gcTime: 60_000,
		enabled: !!id,
	});
}

function invalidateConversationLists(qc: ReturnType<typeof useQueryClient>) {
	qc.invalidateQueries({ queryKey: ["agent-conversations"] });
}

export function useClearAgentConversations() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: () => api.clearAgentConversations(),
		onSuccess: () => invalidateConversationLists(qc),
	});
}

export function useRenameAgentConversation() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ id, title }: { id: string; title: string }) =>
			api.renameAgentConversation(id, title),
		onMutate: async ({ id, title }) => {
			await qc.cancelQueries({ queryKey: ["agent-conversations"] });
			const snapshots = qc.getQueriesData<AgentConversationSummary[]>({
				queryKey: ["agent-conversations"],
			});
			for (const [key, data] of snapshots) {
				if (!data) continue;
				qc.setQueryData<AgentConversationSummary[]>(key, (prev) =>
					(prev ?? []).map((c) => (c.id === id ? { ...c, title } : c)),
				);
			}
			return { snapshots };
		},
		onError: (_err, _vars, ctx) => {
			if (!ctx) return;
			for (const [key, data] of ctx.snapshots) {
				qc.setQueryData(key, data);
			}
		},
		onSettled: () => invalidateConversationLists(qc),
	});
}

export function useArchiveAgentConversation() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ id }: { id: string }) => api.archiveAgentConversation(id),
		onMutate: async ({ id }) => {
			await qc.cancelQueries({ queryKey: ["agent-conversations"] });
			const snapshots = qc.getQueriesData<AgentConversationSummary[]>({
				queryKey: ["agent-conversations"],
			});
			const stamp = new Date().toISOString();
			for (const [key, data] of snapshots) {
				if (!data) continue;
				const includeArchived = Array.isArray(key) && typeof key[1] === "object"
					? Boolean((key[1] as { includeArchived?: boolean }).includeArchived)
					: false;
				qc.setQueryData<AgentConversationSummary[]>(key, (prev) => {
					const next = prev ?? [];
					if (includeArchived) {
						return next.map((c) => (c.id === id ? { ...c, archivedAt: stamp } : c));
					}
					return next.filter((c) => c.id !== id);
				});
			}
			return { snapshots };
		},
		onError: (_err, _vars, ctx) => {
			if (!ctx) return;
			for (const [key, data] of ctx.snapshots) {
				qc.setQueryData(key, data);
			}
		},
		onSettled: () => invalidateConversationLists(qc),
	});
}

export function useUnarchiveAgentConversation() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ id }: { id: string }) => api.unarchiveAgentConversation(id),
		onMutate: async ({ id }) => {
			await qc.cancelQueries({ queryKey: ["agent-conversations"] });
			const snapshots = qc.getQueriesData<AgentConversationSummary[]>({
				queryKey: ["agent-conversations"],
			});
			for (const [key, data] of snapshots) {
				if (!data) continue;
				qc.setQueryData<AgentConversationSummary[]>(key, (prev) =>
					(prev ?? []).map((c) =>
						c.id === id ? { ...c, archivedAt: undefined } : c,
					),
				);
			}
			return { snapshots };
		},
		onError: (_err, _vars, ctx) => {
			if (!ctx) return;
			for (const [key, data] of ctx.snapshots) {
				qc.setQueryData(key, data);
			}
		},
		onSettled: () => invalidateConversationLists(qc),
	});
}

export function usePinAgentConversation() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ id }: { id: string }) => api.pinAgentConversation(id),
		onMutate: async ({ id }) => {
			await qc.cancelQueries({ queryKey: ["agent-conversations"] });
			const snapshots = qc.getQueriesData<AgentConversationSummary[]>({
				queryKey: ["agent-conversations"],
			});
			const stamp = new Date().toISOString();
			for (const [key, data] of snapshots) {
				if (!data) continue;
				qc.setQueryData<AgentConversationSummary[]>(key, (prev) =>
					(prev ?? []).map((c) =>
						c.id === id ? { ...c, pinnedAt: stamp } : c,
					),
				);
			}
			return { snapshots };
		},
		onError: (_err, _vars, ctx) => {
			if (!ctx) return;
			for (const [key, data] of ctx.snapshots) {
				qc.setQueryData(key, data);
			}
		},
		onSettled: () => invalidateConversationLists(qc),
	});
}

export function useUnpinAgentConversation() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ id }: { id: string }) => api.unpinAgentConversation(id),
		onMutate: async ({ id }) => {
			await qc.cancelQueries({ queryKey: ["agent-conversations"] });
			const snapshots = qc.getQueriesData<AgentConversationSummary[]>({
				queryKey: ["agent-conversations"],
			});
			for (const [key, data] of snapshots) {
				if (!data) continue;
				qc.setQueryData<AgentConversationSummary[]>(key, (prev) =>
					(prev ?? []).map((c) =>
						c.id === id ? { ...c, pinnedAt: undefined } : c,
					),
				);
			}
			return { snapshots };
		},
		onError: (_err, _vars, ctx) => {
			if (!ctx) return;
			for (const [key, data] of ctx.snapshots) {
				qc.setQueryData(key, data);
			}
		},
		onSettled: () => invalidateConversationLists(qc),
	});
}
