// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Pending high-risk agent actions (Route C / WP 3I).
 *
 * The agent never executes high-risk actions (send / delete / move /
 * archive / mark_spam / unsubscribe / run_automation) directly —
 * instead it persists an `AgentPendingAction` row and emits a
 * `pending_action` event. This module exposes those records to the
 * renderer so the UI can present them as inline confirmation cards
 * above the agent chat.
 *
 * Backend routes:
 * - GET  /api/agent/pending-actions[?conversationId=...]
 * - POST /api/agent/pending-actions/:id/resolve  body: {status}
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import api, { type AgentPendingAction } from "~/services/api";
import { buildActionExecutionEventsUrl } from "~/services/api";
import { mergePendingActionSnapshots } from "~/lib/actionExecution";
import { useCurrentAccount } from "./currentAccount";

export function pendingActionsQueryKey(conversationId?: string) {
	return ["pending-actions", conversationId ?? null] as const;
}

export function usePendingActions(conversationId?: string, enabled = true) {
	const client = useQueryClient();
	const accountId = useCurrentAccount().data?.account?.id;
	const [connected, setConnected] = useState(false);
	useEffect(() => {
		if (!enabled || typeof EventSource === "undefined") return;
		const source = new EventSource(buildActionExecutionEventsUrl());
		const refresh = () => {
			void client.invalidateQueries({ queryKey: pendingActionsQueryKey(conversationId) });
		};
		const refreshResults = () => {
			void client.invalidateQueries({ queryKey: ["agent-conversation-state", conversationId] });
			void client.invalidateQueries({ queryKey: ["emails"] });
		};
		const ready = () => { setConnected(true); refresh(); refreshResults(); };
		const changed = (event: MessageEvent<string>) => {
			refresh();
			try {
				const payload = JSON.parse(event.data) as { state?: string };
				if (payload.state && !["queued", "running"].includes(payload.state)) refreshResults();
			} catch { /* A snapshot refresh still reconciles malformed passive events. */ }
		};
		source.addEventListener("ready", ready);
		source.addEventListener("action-changed", changed as EventListener);
		source.onerror = () => setConnected(false);
		return () => { source.close(); setConnected(false); };
	}, [client, conversationId, enabled, accountId]);
	return useQuery<AgentPendingAction[]>({
		queryKey: pendingActionsQueryKey(conversationId),
		queryFn: async () => {
			const incoming = await api.getPendingActions(conversationId);
			return mergePendingActionSnapshots(client.getQueryData<AgentPendingAction[]>(pendingActionsQueryKey(conversationId)), incoming);
		},
		enabled,
		// shortcut: external MCP proposals do not publish action-execution events; retain visible-conversation discovery until they do.
		refetchInterval: enabled ? (connected ? 30_000 : 5_000) : false,
		refetchOnWindowFocus: true,
	});
}

export function useResolvePendingAction() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (input: {
			id: string;
			status: "confirmed" | "rejected";
			idempotencyKey?: string;
			parameters?: Record<string, unknown>;
			timeoutMs?: number;
		}) => api.resolvePendingAction(input.id, input.status, {
			idempotencyKey: input.idempotencyKey,
			parameters: input.parameters,
			timeoutMs: input.timeoutMs,
		}),
		onSuccess: () => {
			// Invalidate every cached pending-actions key (any conversationId
			// scope) so the cards disappear immediately after resolution.
			qc.invalidateQueries({ queryKey: ["pending-actions"] });
			qc.invalidateQueries({ queryKey: ["agent-conversation-state"] });
			qc.invalidateQueries({ queryKey: ["emails"] });
			qc.invalidateQueries({ queryKey: ["wemail-intelligence"] });
			qc.invalidateQueries({ queryKey: ["list-categories"] });
			qc.invalidateQueries({ queryKey: ["agent-suggestions"] });
		},
		onError: () => {
			qc.invalidateQueries({ queryKey: ["pending-actions"] });
		},
	});
}
