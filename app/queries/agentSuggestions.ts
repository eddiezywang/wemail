// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Backend-driven AI panel suggestion chips.
 *
 * Sourced from `GET /api/agent/suggestions?accountId=&emailId=`. The
 * backend builds state-aware chips from the IntelligenceService
 * (e.g. "起草回复" only when a reply decision says replyRequired) and
 * falls back to a state-aware Chinese set when the email is fully processed
 * or no email is selected. If the request fails the UI leaves the home
 * suggestion area empty instead of inventing a generic action.
 */

import { useQuery } from "@tanstack/react-query";
import api from "~/services/api";
import type { AgentSuggestion } from "../../shared/wemail/usage";

export type { AgentSuggestion } from "../../shared/wemail/usage";

export interface AgentSuggestionResponse {
	suggestions: AgentSuggestion[];
	contextLine?: string;
	source?: "rules" | "cached-ai";
	candidateFingerprint?: string;
	refreshPending?: boolean;
}

function nonEmptyStrings(value: unknown): value is string[] {
	return (
		Array.isArray(value) &&
		value.length > 0 &&
		value.every((item) => typeof item === "string" && item.trim().length > 0)
	);
}

export function isSemanticHomeSuggestion(
	value: unknown,
): value is AgentSuggestion {
	if (!value || typeof value !== "object") return false;
	const item = value as Record<string, unknown>;
	if (
		typeof item.id !== "string" ||
		typeof item.label !== "string" ||
		typeof item.prompt !== "string" ||
		(item.kind !== "extracted" && item.kind !== "aggregate")
	) {
		return false;
	}
	const discovery = item.discovery as Record<string, unknown> | undefined;
	if (
		!discovery ||
		!nonEmptyStrings(discovery.emailIds) ||
		(discovery.primaryWindow !== "24h" && discovery.primaryWindow !== "7d") ||
		discovery.mailState !== "unread"
	) {
		return false;
	}
	const scope = item.executionScope as Record<string, unknown> | undefined;
	if (!scope) return false;
	if (scope.mode === "fixed") return nonEmptyStrings(scope.emailIds);
	return (
		scope.mode === "query" &&
		!!scope.query &&
		typeof scope.query === "object" &&
		!Array.isArray(scope.query)
	);
}

export function useAgentSuggestions(opts: {
	mailboxId: string | undefined;
	emailId: string | null | undefined;
	enabled?: boolean;
}) {
	const { mailboxId, emailId, enabled = true } = opts;
	return useQuery<AgentSuggestionResponse>({
		queryKey: ["agent-suggestions", mailboxId ?? "_none", emailId ?? "_none"],
		queryFn: async () => {
			if (!mailboxId) return { suggestions: [] };
			const res = await api.getAgentSuggestions(mailboxId, emailId ?? undefined);
			if (!res?.ok) return { suggestions: [] };
			return {
				suggestions: emailId
					? res.suggestions
					: res.suggestions.filter(isSemanticHomeSuggestion),
				contextLine: res.contextLine,
				source: res.source,
				candidateFingerprint: res.candidateFingerprint,
				refreshPending: res.refreshPending,
			};
		},
		enabled: enabled && !!mailboxId,
		retry: false,
		// Home (no email selected): deterministic office actions refresh hourly
		// to bound token/CPU cost. Email-scoped suggestions stay fresh at 30s.
		staleTime: emailId ? 30_000 : 60 * 60 * 1000,
		refetchInterval: emailId ? false : 60 * 60 * 1000,
	});
}
