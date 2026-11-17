// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import {
	useInfiniteQuery,
	useMutation,
	useQuery,
	useQueryClient,
	type QueryClient,
} from "@tanstack/react-query";
import api from "~/services/api";
import type {
	GenerateMailDigestRequest,
	MailDigestKind,
	MailDigestRecord,
	MailDigestScope,
	MailDigestSettings,
	MailDigestStatus,
} from "../../shared/wemail/digests";
import type {
	IntelligenceAttributeKind,
	SummaryHealthStatus,
	SummaryRetryAllResult,
	SummaryRetryMode,
	SummaryWorkState,
} from "../../shared/wemail/intelligence";

const DIGEST_KEY = "mail-digests";

export type DigestScope = MailDigestScope;
export type SummaryStateFilter = SummaryWorkState | "all" | "attention";

export interface SummaryHealthFilters {
	query?: string;
	state?: SummaryStateFilter;
}

export const SUMMARY_TASK_PAGE_SIZE = 20;
const SUMMARY_HEALTH_POLL_INTERVAL = 15_000;

export const ATTENTION_SUMMARY_STATES: SummaryWorkState[] = [
	"failed",
	"missing",
	"invalid",
	"pending",
	"running",
];

const DEFAULT_SCOPE: DigestScope = { scopeKind: "folder", scopeKey: "INBOX" };

function normalizeScope(scope?: DigestScope): DigestScope {
	return scope ?? DEFAULT_SCOPE;
}

export const digestKeys = {
	settings: [DIGEST_KEY, "settings"] as const,
	status: (accountId: string, scope?: DigestScope) => {
		const s = normalizeScope(scope);
		return [DIGEST_KEY, "status", accountId, s.scopeKind, s.scopeKey] as const;
	},
	latest: (accountId: string, scope?: DigestScope, kind?: MailDigestKind) => {
		const s = normalizeScope(scope);
		return [DIGEST_KEY, "latest", accountId, s.scopeKind, s.scopeKey, kind ?? "any"] as const;
	},
	list: (accountId: string, scope?: DigestScope, kind?: MailDigestKind, limit?: number) => {
		const s = normalizeScope(scope);
		return [DIGEST_KEY, "list", accountId, s.scopeKind, s.scopeKey, kind ?? "any", limit ?? "default"] as const;
	},
	summaryHealth: (accountId: string, scope?: DigestScope, filters?: SummaryHealthFilters) => {
		const s = normalizeScope(scope);
		return [
			DIGEST_KEY,
			"summary-health",
			accountId,
			s.scopeKind,
			s.scopeKey,
			filters?.query?.trim() ?? "",
			filters?.state ?? "all",
		] as const;
	},
	summaryHealthPages: (accountId: string, scope?: DigestScope, filters?: SummaryHealthFilters) => [
		...digestKeys.summaryHealth(accountId, scope, filters),
		"pages",
		SUMMARY_TASK_PAGE_SIZE,
	] as const,
};

export function invalidateDigestStatus(
	queryClient: QueryClient,
	accountId: string | undefined,
	scope?: DigestScope,
) {
	if (!accountId) return;
	queryClient.invalidateQueries({ queryKey: digestKeys.status(accountId, scope) });
}

export function useDigestSettings() {
	return useQuery<MailDigestSettings>({
		queryKey: digestKeys.settings,
		queryFn: async ({ signal }) => {
			const res = await api.getDigestSettings({ signal });
			return res.settings;
		},
	});
}

export function useSaveDigestSettings() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (settings: MailDigestSettings) =>
			api.saveDigestSettings(settings),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: digestKeys.settings });
			qc.invalidateQueries({ queryKey: [DIGEST_KEY, "status"] });
		},
	});
}

export function useDigestStatus(accountId: string | undefined, scope?: DigestScope) {
	const normalizedScope = normalizeScope(scope);
	return useQuery({
		queryKey: accountId
			? digestKeys.status(accountId, normalizedScope)
			: [DIGEST_KEY, "status", "_disabled"],
		queryFn: async ({ signal }) => {
			const res = await api.getDigestStatus(accountId!, normalizedScope, { signal });
			return res.status;
		},
		enabled: !!accountId,
	});
}

export function useLatestDigest(
	accountId: string | undefined,
	scope?: DigestScope,
	kind?: MailDigestKind,
) {
	const normalizedScope = normalizeScope(scope);
	return useQuery({
		queryKey: accountId
			? digestKeys.latest(accountId, normalizedScope, kind)
			: [DIGEST_KEY, "latest", "_disabled"],
		queryFn: async ({ signal }) => {
			const res = await api.getLatestDigest(accountId!, normalizedScope, kind, { signal });
			return res.digest;
		},
		enabled: !!accountId,
	});
}

export function useDigestList(
	accountId: string | undefined,
	scope?: DigestScope,
	kind?: MailDigestKind,
	limit?: number,
) {
	const normalizedScope = normalizeScope(scope);
	return useQuery({
		queryKey: accountId
			? digestKeys.list(accountId, normalizedScope, kind, limit)
			: [DIGEST_KEY, "list", "_disabled"],
		queryFn: async ({ signal }) => {
			const res = await api.listDigests(accountId!, normalizedScope, kind, limit, { signal });
			return res.digests;
		},
		enabled: !!accountId,
	});
}

export function useSummaryHealth(
	accountId: string | undefined,
	scope?: DigestScope,
	enabled = true,
	filters?: SummaryHealthFilters,
) {
	const normalizedScope = normalizeScope(scope);
	return useQuery<SummaryHealthStatus>({
		queryKey: accountId
			? digestKeys.summaryHealth(accountId, normalizedScope, filters)
			: [DIGEST_KEY, "summary-health", "_disabled"],
		queryFn: async ({ signal }) => {
			const states = resolveSummaryStateFilter(filters?.state);
			const res = await api.getSummaryHealth(accountId!, normalizedScope, {
				signal,
				query: filters?.query,
				states,
				limit: 1,
			});
			return res.status;
		},
		enabled: !!accountId && enabled,
		refetchInterval: (query) => {
			const data = query.state.data;
			if (!data) return false;
			return data.pending + data.running > 0 ? SUMMARY_HEALTH_POLL_INTERVAL : false;
		},
	});
}

export function useInfiniteSummaryHealth(
	accountId: string | undefined,
	scope?: DigestScope,
	enabled = true,
	filters?: SummaryHealthFilters,
) {
	const normalizedScope = normalizeScope(scope);
	return useInfiniteQuery({
		queryKey: accountId
			? digestKeys.summaryHealthPages(accountId, normalizedScope, filters)
			: [DIGEST_KEY, "summary-health", "_disabled", "pages"],
		queryFn: async ({ signal, pageParam }) => {
			const states = resolveSummaryStateFilter(filters?.state);
			const res = await api.getSummaryHealth(accountId!, normalizedScope, {
				signal,
				query: filters?.query,
				states,
				limit: SUMMARY_TASK_PAGE_SIZE,
				offset: pageParam,
				pageOnly: true,
			});
			return res.status;
		},
		initialPageParam: 0,
		getNextPageParam: (lastPage) =>
			lastPage.hasMore ? lastPage.nextOffset : undefined,
		enabled: !!accountId && enabled,
		refetchInterval: (query) => {
			const firstPage = query.state.data?.pages[0];
			if (!firstPage) return false;
			return firstPage.pending + firstPage.running > 0 ? SUMMARY_HEALTH_POLL_INTERVAL : false;
		},
	});
}

function resolveSummaryStateFilter(
	state?: SummaryStateFilter,
): SummaryWorkState[] | undefined {
	if (!state || state === "all") return undefined;
	if (state === "attention") return ATTENTION_SUMMARY_STATES;
	return [state];
}

export function useRetryAllSummaries(accountId: string | undefined, scope?: DigestScope) {
	const qc = useQueryClient();
	const normalizedScope = normalizeScope(scope);
	return useMutation<SummaryRetryAllResult, Error, { emailIds?: string[]; kinds?: IntelligenceAttributeKind[]; mode?: SummaryRetryMode; limit?: number } | void>({
		mutationFn: async (input) => {
			if (!accountId) throw new Error("missing accountId");
			const res = await api.retryAllSummaries({
				accountId,
				scope: normalizedScope,
				mode: input?.mode ?? "all",
				emailIds: input?.emailIds,
				kinds: input?.kinds,
				limit: input?.limit,
			});
			return res.result;
		},
		onSuccess: () => {
			if (!accountId) return;
			qc.invalidateQueries({
				queryKey: [DIGEST_KEY, "summary-health", accountId, normalizedScope.scopeKind, normalizedScope.scopeKey],
			});
			qc.invalidateQueries({
				queryKey: digestKeys.status(accountId, normalizedScope),
			});
			qc.invalidateQueries({
				queryKey: ["wemail-intelligence"],
			});
		},
	});
}

export function useGenerateDigest(accountId: string | undefined, scope?: DigestScope) {
	const qc = useQueryClient();
	const normalizedScope = normalizeScope(scope);
	return useMutation({
		mutationFn: (input: Omit<GenerateMailDigestRequest, "accountId">) => {
			if (!accountId) throw new Error("missing accountId");
			return api.generateDigest({ ...input, ...normalizedScope, accountId });
		},
		onSuccess: (data) => {
			const digest = data.digest;
			const generatedAccountId = digest.accountId;
			const generatedScope = {
				scopeKind: digest.scopeKind,
				scopeKey: digest.scopeKey,
			};
			setGeneratedDigestCache(qc, digest);
			qc.invalidateQueries({
				queryKey: digestKeys.status(generatedAccountId, generatedScope),
			});
			qc.invalidateQueries({
				queryKey: [DIGEST_KEY, "latest", generatedAccountId, generatedScope.scopeKind, generatedScope.scopeKey],
			});
			qc.invalidateQueries({
				queryKey: [DIGEST_KEY, "list", generatedAccountId, generatedScope.scopeKind, generatedScope.scopeKey],
			});
		},
	});
}

function setGeneratedDigestCache(queryClient: QueryClient, digest: MailDigestRecord) {
	const scope = {
		scopeKind: digest.scopeKind,
		scopeKey: digest.scopeKey,
	};
	const status: MailDigestStatus = {
		state: "ready",
		reason: digest.kind,
		scopeKind: digest.scopeKind,
		scopeKey: digest.scopeKey,
		windowStart: digest.windowStart,
		windowEnd: digest.windowEnd,
		emailCount: digest.emailCount,
		digest,
	};
	queryClient.setQueryData(digestKeys.status(digest.accountId, scope), status);
	queryClient.setQueryData(digestKeys.latest(digest.accountId, scope), digest);
	queryClient.setQueryData(digestKeys.latest(digest.accountId, scope, digest.kind), digest);
}
