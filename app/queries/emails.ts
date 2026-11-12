// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import {
	type QueryClient,
	useInfiniteQuery,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import api from "~/services/api";
import type { Email, Folder } from "~/types";
import { logicalMailKey } from "shared/folders";
import type { ListCategory } from "./listCategories";
import type { WemailDraftInput, WemailDraftSaveInput } from "../../shared/wemail/mail";
import { queryKeys } from "./keys";
import { beginMailOpenTrace, markMailOpenStage } from "~/lib/mailOpenTrace";

// ---------- Types ----------

interface EmailListResponse {
	emails: Email[];
	totalCount: number;
	unreadCount: number;
	hasMore: boolean;
	nextCursor?: string;
}

interface EmailInfiniteCache {
	pages: EmailListResponse[];
	pageParams: unknown[];
}

interface EmailSearchCache {
	results: Email[];
	totalCount: number;
}

interface SemanticEmailSearchCache {
	ok: boolean;
	results: Array<{
		email: Email;
		score: number;
		snippet?: string;
	}>;
}

type MailPageParam = { cursor?: string; before?: string } | undefined;

const DEFAULT_MAIL_PAGE_LIMIT = "50";
const MAIL_FIRST_PAGE_STALE_MS = 60_000;
const MAIL_VIEW_CACHE_GC_MS = 10 * 60_000;
const MAIL_DETAIL_CACHE_MAX = 30;
const MAIL_DETAIL_CACHE_MAX_CHARS = 12 * 1024 * 1024;
const BODY_WAIT_TIMEOUT_MS = 2_500;
const detailCacheLru = new Map<string, number>();
let detailCacheChars = 0;

function retainDetailCache(
	queryClient: QueryClient,
	mailboxId: string,
	email: Email,
): void {
	const key = `${mailboxId}\u0000${email.id}`;
	const chars =
		(email.body?.length ?? 0) +
		(email.bodyHtml?.length ?? 0) +
		(email.bodyText?.length ?? 0) +
		(email.subject?.length ?? 0);
	const previous = detailCacheLru.get(key);
	if (previous !== undefined) detailCacheChars -= previous;
	detailCacheLru.delete(key);
	detailCacheLru.set(key, chars);
	detailCacheChars += chars;
	while (
		detailCacheLru.size > MAIL_DETAIL_CACHE_MAX ||
		detailCacheChars > MAIL_DETAIL_CACHE_MAX_CHARS
	) {
		const oldest = detailCacheLru.entries().next().value as [string, number] | undefined;
		if (!oldest || oldest[0] === key) break;
		detailCacheLru.delete(oldest[0]);
		detailCacheChars -= oldest[1];
		const separator = oldest[0].indexOf("\u0000");
		queryClient.removeQueries({
			queryKey: queryKeys.emails.detail(
				oldest[0].slice(0, separator),
				oldest[0].slice(separator + 1),
			),
			exact: true,
		});
	}
}

function mailQueryParams(params: Record<string, string>): Record<string, string> {
	return params.folder
		? { limit: DEFAULT_MAIL_PAGE_LIMIT, ...params, threaded: "true" }
		: { limit: DEFAULT_MAIL_PAGE_LIMIT, ...params };
}

async function fetchEmailPage(
	mailboxId: string,
	queryParams: Record<string, string>,
	pageParam?: MailPageParam,
	signal?: AbortSignal,
): Promise<EmailListResponse> {
	const pageParams = pageParam
		? { ...queryParams, ...pageParam }
		: queryParams;
	const data = await api.listEmails(mailboxId, pageParams, { signal }) as
		| EmailListResponse
		| Email[];
	if (data && typeof data === "object" && "emails" in data) {
		return {
			emails: data.emails ?? [],
			totalCount: data.totalCount ?? 0,
			unreadCount: data.unreadCount ?? 0,
			hasMore: data.hasMore ?? Boolean(data.nextCursor),
			nextCursor: data.nextCursor,
		};
	}
	const emails = Array.isArray(data) ? data : [];
	return {
		emails,
		totalCount: emails.length,
		unreadCount: emails.filter((email) => !email.read).length,
		hasMore: false,
	};
}

export function prefetchEmailFirstPage(
	queryClient: QueryClient,
	mailboxId: string,
	params: Record<string, string>,
): Promise<void> {
	const queryParams = mailQueryParams(params);
	return queryClient.prefetchInfiniteQuery({
		queryKey: queryKeys.emails.list(mailboxId, queryParams),
		initialPageParam: undefined as MailPageParam,
		queryFn: ({ pageParam, signal }) =>
			fetchEmailPage(mailboxId, queryParams, pageParam, signal),
		getNextPageParam: (lastPage) =>
			lastPage.hasMore && lastPage.nextCursor ? { cursor: lastPage.nextCursor } : undefined,
		staleTime: MAIL_FIRST_PAGE_STALE_MS,
		gcTime: MAIL_VIEW_CACHE_GC_MS,
	});
}

// ---------- Queries ----------

export function useEmails(
	mailboxId: string | undefined,
	params: Record<string, string>,
	options?: { enabled?: boolean; refetchInterval?: number },
) {
	const queryClient = useQueryClient();
	const queryParams = mailQueryParams(params);
	const queryKey = mailboxId
		? queryKeys.emails.list(mailboxId, queryParams)
		: (["emails", "_disabled"] as const);

	const query = useInfiniteQuery<
		EmailListResponse,
		Error,
		EmailListResponse,
		ReturnType<typeof queryKeys.emails.list> | readonly ["emails", "_disabled"],
		MailPageParam
	>({
		queryKey,
		initialPageParam: undefined,
		queryFn: ({ pageParam, signal }) =>
			fetchEmailPage(mailboxId!, queryParams, pageParam, signal),
		getNextPageParam: (lastPage) => {
			return lastPage.hasMore && lastPage.nextCursor
				? { cursor: lastPage.nextCursor }
				: undefined;
		},
		select: (data) => {
			const emails = data.pages.flatMap((page) => page.emails);
			const seen = new Set<string>();
			const uniqueEmails = emails.filter((email) => {
				const key = logicalMailKey({ id: email.id, messageId: email.message_id });
				if (seen.has(key)) return false;
				seen.add(key);
				return true;
			});
			return {
				emails: uniqueEmails,
				totalCount: data.pages[0]?.totalCount ?? uniqueEmails.length,
				unreadCount:
					data.pages[0]?.unreadCount ?? uniqueEmails.filter((email) => !email.read).length,
				hasMore: data.pages.at(-1)?.hasMore ?? false,
				nextCursor: data.pages.at(-1)?.nextCursor,
			};
		},
		enabled: !!mailboxId && (options?.enabled ?? true),
		refetchInterval: options?.refetchInterval,
		retry: 3,
		staleTime: MAIL_FIRST_PAGE_STALE_MS,
		gcTime: MAIL_VIEW_CACHE_GC_MS,
		refetchOnWindowFocus: false,
	});
	const refreshLatestPage = useCallback(async () => {
		if (!mailboxId) return undefined;
		const latest = await fetchEmailPage(mailboxId, queryParams);
		queryClient.setQueryData<EmailInfiniteCache>(queryKey, (current) => {
			if (!current?.pages.length) {
				return { pages: [latest], pageParams: [undefined] };
			}
			const existing = current.pages.flatMap((page) => page.emails);
			const seen = new Set<string>();
			const merged = [...latest.emails, ...existing].filter((email) => {
				const key = logicalMailKey({ id: email.id, messageId: email.message_id });
				if (seen.has(key)) return false;
				seen.add(key);
				return true;
			});
			return {
				...current,
				pages: [
					{ ...latest, emails: merged },
					...current.pages.slice(1),
				],
			};
		});
		return latest;
	}, [mailboxId, queryClient, queryKey, queryParams]);
	return { ...query, refreshLatestPage };
}

export function useEmail(
	mailboxId: string | undefined,
	emailId: string | undefined,
) {
	const queryClient = useQueryClient();
	const ensureRequestedRef = useRef<{ emailId: string; mode: "ensure" | "retry" } | null>(null);
	const bodyRequestGenerationRef = useRef(0);
	const bodyWaitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const [bodyWaitTimedOut, setBodyWaitTimedOut] = useState(false);
	const clearBodyWaitTimer = useCallback(() => {
		if (bodyWaitTimerRef.current === null) return;
		clearTimeout(bodyWaitTimerRef.current);
		bodyWaitTimerRef.current = null;
	}, []);
	const beginBodyWait = useCallback(() => {
		clearBodyWaitTimer();
		setBodyWaitTimedOut(false);
		const requestGeneration = bodyRequestGenerationRef.current;
		bodyWaitTimerRef.current = setTimeout(() => {
			if (bodyRequestGenerationRef.current !== requestGeneration) return;
			bodyWaitTimerRef.current = null;
			setBodyWaitTimedOut(true);
		}, BODY_WAIT_TIMEOUT_MS);
	}, [clearBodyWaitTimer]);
	const traceRef = useRef<{ key: string; traceId: string } | null>(null);
	const traceKey = `${mailboxId ?? ""}\0${emailId ?? ""}`;
	if (emailId && traceRef.current?.key !== traceKey) {
		traceRef.current = { key: traceKey, traceId: beginMailOpenTrace(emailId) };
	}
	const traceId = traceRef.current?.key === traceKey ? traceRef.current.traceId : undefined;
	useEffect(() => {
		bodyRequestGenerationRef.current += 1;
		ensureRequestedRef.current = null;
		setBodyWaitTimedOut(false);
		clearBodyWaitTimer();
		return clearBodyWaitTimer;
	}, [mailboxId, emailId, clearBodyWaitTimer]);
	const query = useQuery<Email>({
		queryKey: mailboxId && emailId
			? queryKeys.emails.detail(mailboxId, emailId)
			: ["emails", "_disabled_detail"],
		queryFn: async ({ signal }) => {
			markMailOpenStage(emailId!, "local-query-start", traceId);
			const result = await api.getEmail(mailboxId!, emailId!, { signal, traceId }) as Email;
			markMailOpenStage(emailId!, "metadata-ready", traceId);
			return result;
		},
		enabled: !!mailboxId && !!emailId,
		staleTime: 30_000,
		gcTime: MAIL_VIEW_CACHE_GC_MS,
	});
	useEffect(() => {
		if (!mailboxId || !query.data) return;
		retainDetailCache(queryClient, mailboxId, query.data);
	}, [mailboxId, query.data, queryClient]);
	useEffect(() => {
		if (!query.data) return;
		const hasBody = [query.data.body, query.data.bodyHtml, query.data.bodyText]
			.some((value) => typeof value === "string" && value.trim().length > 0);
		if (hasBody && emailId) markMailOpenStage(emailId, "body-ready", traceId);
		const readyBodyMissing =
			query.data.bodyState === "ready" &&
			!hasBody &&
			typeof query.data.snippet === "string" &&
			query.data.snippet.trim().length > 0;
		if (
			hasBody ||
			(query.data.bodyState === "ready" && !readyBodyMissing) ||
			query.data.bodyState === "failed"
		) {
			clearBodyWaitTimer();
			setBodyWaitTimedOut(false);
		}
	}, [
		query.data?.body,
		query.data?.bodyHtml,
		query.data?.bodyText,
		query.data?.bodyState,
		query.data?.snippet,
		emailId,
		traceId,
		clearBodyWaitTimer,
	]);
	useEffect(() => {
		if (!mailboxId || !emailId) return;
		void (async () => {
			try {
				await api.focusEmail(mailboxId, emailId, traceId);
			} catch {
				// Focus is an optimization; body loading still has its normal path.
			}
		})();
		return () => {
			void (async () => {
				try {
					await api.blurEmail(mailboxId, emailId, traceId);
				} catch {
					// The account may have been disconnected during navigation.
				}
			})();
		};
	}, [mailboxId, emailId, traceId]);
	useEffect(() => {
		if (!emailId || !query.data) return;
		// A list-summary placeholder is seeded into the detail cache on click
		// (see _workbench.tsx) so the header paints instantly. It carries no
		// bodyState — getEmail always sets one. Without this guard, every
		// mounted useEmail instance (EmailPanel / AgentPanel / CommandPalette)
		// mistakes the placeholder for "body missing" and fires an IMAP ensure
		// for a message whose body is already cached (ensure-request ×N).
		if (query.data.bodyState === undefined) return;
		const hasBody = [query.data.body, query.data.bodyHtml, query.data.bodyText]
			.some((value) => typeof value === "string" && value.trim().length > 0);
		const readyBodyMissing =
			query.data.bodyState === "ready" &&
			!hasBody &&
			typeof query.data.snippet === "string" &&
			query.data.snippet.trim().length > 0;
		const oversizedBody =
			query.data.bodyState === "failed" &&
			query.data.bodyErrorCode === "mail-body-too-large";
		// `ready` without a renderable body is an invariant violation for the
		// detail surface. Keep it in the same foreground loading path as
		// `missing`; the 2.5s deadline below is the escape hatch if the worker
		// cannot produce a body commit. Truly empty messages (empty snippet) are
		// already completed and stay out of this recovery path.
		if (
			hasBody ||
			(query.data.bodyState === "ready" && !readyBodyMissing) ||
			(query.data.bodyState === "failed" && !oversizedBody)
		) return;
		const mode: "ensure" | "retry" = oversizedBody ? "retry" : "ensure";
		// A retry request is still an in-flight body request for this message;
		// do not issue a second ensure when its db event changes bodyState to
		// fetching before the explicit retry response arrives.
		if (ensureRequestedRef.current?.emailId === emailId) return;
		ensureRequestedRef.current = { emailId, mode };
		markMailOpenStage(emailId, `${mode}-request`, traceId);
		beginBodyWait();
		const requestGeneration = bodyRequestGenerationRef.current;
		void (async () => {
			try {
				const result = oversizedBody
					? await api.retryEmailBody(mailboxId!, emailId, true)
					: await api.ensureEmailBody(mailboxId!, emailId, traceId);
				if (bodyRequestGenerationRef.current !== requestGeneration) return;
				markMailOpenStage(emailId, `${mode}-${result.status}`, traceId);
				if (result.status === "ready") {
					// Keep the deadline armed until the subsequent local snapshot
					// actually contains a body. A `ready` acknowledgement alone
					// must not make the renderer paint an empty surface.
					void query.refetch();
				} else if (result.status !== "queued") {
					clearBodyWaitTimer();
					setBodyWaitTimedOut(true);
				}
			} catch {
				if (bodyRequestGenerationRef.current !== requestGeneration) return;
				// Keep the single 2.5s deadline as the user-visible fallback even
				// when the IPC request itself times out or the core is reconnecting.
			}
		})();
	}, [
		mailboxId,
		emailId,
		query.data?.body,
		query.data?.bodyHtml,
		query.data?.bodyText,
		query.data?.bodyState,
		query.data?.bodyErrorCode,
		query.data?.snippet,
		traceId,
		beginBodyWait,
		clearBodyWaitTimer,
	]);
	const retryBody = useCallback(async (onDemand?: boolean) => {
		if (!mailboxId || !emailId) return;
		ensureRequestedRef.current = { emailId, mode: "retry" };
		beginBodyWait();
		const requestGeneration = bodyRequestGenerationRef.current;
		try {
			const result = await api.retryEmailBody(mailboxId, emailId, onDemand);
			if (bodyRequestGenerationRef.current !== requestGeneration) return result;
			if (result.status === "ready") {
				// The refetch effect clears the deadline only after a renderable
				// body is observed.
				return query.refetch();
			}
			if (result.status !== "queued") {
				clearBodyWaitTimer();
				setBodyWaitTimedOut(true);
			}
			return result;
		} catch {
			if (bodyRequestGenerationRef.current !== requestGeneration) {
				return { status: "account-unavailable" as const };
			}
			// Let the already armed 2.5s deadline produce the same loading/error
			// transition as a queued request that never emits a body commit.
			return { status: "account-unavailable" as const };
		}
		// query.refetch is stable across renders (React Query guarantee).
	}, [mailboxId, emailId, query.refetch, beginBodyWait, clearBodyWaitTimer]);
	return {
		...query,
		traceId,
		bodyPollingExhausted: query.data?.bodyState === "failed",
		bodyWaitTimedOut,
		retryBody,
	};
}

export function useThreadReplies(
	mailboxId: string | undefined,
	threadId: string | undefined | null,
) {
	const qc = useQueryClient();

	return useQuery<Email[]>({
		queryKey: mailboxId && threadId
			? queryKeys.emails.thread(mailboxId, threadId)
			: ["emails", "_disabled_thread"],
		queryFn: async ({ signal }) => {
			// Single request returns all thread emails with full bodies +
			// attachments. Eliminates the previous N+1 pattern that fired
			// a separate getEmail call per thread message.
			const emails = await api.getThread(mailboxId!, threadId!, { signal }) as Email[];

			// Populate individual email detail caches so clicking a thread
			// message in the panel doesn't re-fetch.
			for (const email of emails) {
				qc.setQueryData(
					queryKeys.emails.detail(mailboxId!, email.id),
					email,
				);
			}

			return emails;
		},
		enabled: !!mailboxId && !!threadId,
	});
}

// ---------- Mutations ----------

/**
 * Auto-mark-read coordination. When an unread email is opened, BOTH the list
 * (_workbench.tsx) and the detail panel (EmailPanel.tsx) fire an
 * `updateEmail({ read: true })` on the same commit — the detail effect runs
 * first (child before parent) and its optimistic patch isn't visible to the
 * list effect in the same flush, so both mutations fire and the server gets
 * two writes / two db-events / two redundant refetch cascades. These keys make
 * the second caller a no-op while keeping each side's own ref guard for
 * repeated email objects.
 */
const autoReadInFlight = new Set<string>();
export function requestAutoRead(mailboxId: string, emailId: string): boolean {
  const key = `${mailboxId} ${emailId}`;
  if (autoReadInFlight.has(key)) return false;
  autoReadInFlight.add(key);
  return true;
}
export function releaseAutoRead(mailboxId: string, emailId: string): void {
  autoReadInFlight.delete(`${mailboxId} ${emailId}`);
}

/**
 * Run `task` on the next idle tick (fallback: a short timeout). Used to push
 * non-urgent writes - auto-mark-read - past the mail-open critical path:
 * such a write's db-event invalidates the detail query, forcing a refetch
 * (isFetching toggle -> re-renders) that would otherwise race body paint.
 * Returns a cancel handle so callers can cancel on cleanup / dep change.
 */
export function scheduleIdleTask(task: () => void): () => void {
  if (typeof window !== "undefined" && typeof window.requestIdleCallback === "function") {
    const handle = window.requestIdleCallback(task, { timeout: 3000 });
    return () => window.cancelIdleCallback(handle);
  }
  const timer = window.setTimeout(task, 1500);
  return () => window.clearTimeout(timer);
}

/** Invalidate both the email list and folder counts after any email mutation. */
function useInvalidateEmailData() {
	const qc = useQueryClient();
	return (mailboxId: string) => {
		qc.invalidateQueries({ queryKey: ["emails", mailboxId] });
		qc.invalidateQueries({
			queryKey: queryKeys.folders.list(mailboxId),
		});
	};
}

/**
 * Send a fully-formed compose draft through the canonical outbox. The
 * `originalEmailId` field on the input doubles as the reply/forward
 * pointer — the server uses it to thread and to set In-Reply-To
 * headers. There is no separate reply/forward endpoint on the desktop
 * server.
 */
export function useSendDraft() {
	const invalidate = useInvalidateEmailData();
	return useMutation({
		mutationFn: (draft: WemailDraftInput) => api.sendWemailDraft(draft),
		onSuccess: (_data, draft) => invalidate(draft.accountId),
	});
}

export function useUpdateEmail() {
	const qc = useQueryClient();
	const isListQuery = (query: { queryKey: readonly unknown[] }) =>
		query.queryKey[0] === "emails" &&
		typeof query.queryKey[2] === "object" &&
		query.queryKey[2] !== null;
	const patchEmail = (email: Email, id: string, data: Partial<Email>) =>
		email.id === id ? { ...email, ...data } : email;
	const patchListCache = (
		cached: EmailListResponse | EmailInfiniteCache | undefined,
		id: string,
		data: Partial<Email>,
	) => {
		if (!cached) return cached;
		if ("pages" in cached && Array.isArray(cached.pages)) {
			const previousEmail = cached.pages
				.flatMap((page) => page.emails)
				.find((email) => email.id === id);
			const readDelta =
				typeof data.read === "boolean" &&
				previousEmail &&
				previousEmail.read !== data.read
					? data.read
						? -1
						: 1
					: 0;
			return {
				...cached,
				pages: cached.pages.map((page) => ({
					...page,
					emails: page.emails.map((email) => patchEmail(email, id, data)),
					unreadCount:
						typeof page.unreadCount === "number"
							? Math.max(0, page.unreadCount + readDelta)
							: page.unreadCount,
				})),
			};
		}
		if ("emails" in cached && Array.isArray(cached.emails)) {
			const previousEmail = cached.emails.find((email) => email.id === id);
			const readDelta =
				typeof data.read === "boolean" &&
				previousEmail &&
				previousEmail.read !== data.read
					? data.read
						? -1
						: 1
					: 0;
			return {
				...cached,
				emails: cached.emails.map((email) => patchEmail(email, id, data)),
				unreadCount:
					typeof cached.unreadCount === "number"
						? Math.max(0, cached.unreadCount + readDelta)
						: cached.unreadCount,
			};
		}
		return cached;
	};
	const patchSearchCache = (
		cached: EmailSearchCache | SemanticEmailSearchCache | undefined,
		id: string,
		data: Partial<Email>,
	) => {
		if (!cached) return cached;
		return {
			...cached,
			results: cached.results.map((result) =>
				"email" in result
					? { ...result, email: patchEmail(result.email, id, data) }
					: patchEmail(result, id, data),
		),
		};
	};
	const searchCacheEmails = (
		cached: EmailSearchCache | SemanticEmailSearchCache | undefined,
	) =>
		cached?.results.map((result) =>
			"email" in result ? result.email : result,
		) ?? [];
	return useMutation({
		mutationFn: ({
			mailboxId,
			id,
			data,
		}: { mailboxId: string; id: string; data: unknown }) =>
			api.updateEmail(mailboxId, id, data),
		onMutate: async ({ mailboxId, id, data }) => {
			const patch = data as Partial<Email>;
			const readOnlyUpdate =
				typeof patch.read === "boolean" && Object.keys(patch).length === 1;
			// Cancel list and search reads so they cannot overwrite the optimistic
			// update. The list predicate excludes detail and thread queries.
			await Promise.all([
				qc.cancelQueries({
					queryKey: ["emails", mailboxId],
					predicate: isListQuery,
				}),
				qc.cancelQueries({ queryKey: ["search", mailboxId] }),
				qc.cancelQueries({ queryKey: ["semantic-search", mailboxId] }),
			]);

			// Snapshot current list and search caches for rollback.
			const listQueries = qc.getQueriesData<EmailListResponse | EmailInfiniteCache>({
				queryKey: ["emails", mailboxId],
				predicate: isListQuery,
			});
			const searchQueries = [
				...qc.getQueriesData<EmailSearchCache>({
					queryKey: ["search", mailboxId],
				}),
				...qc.getQueriesData<SemanticEmailSearchCache>({
					queryKey: ["semantic-search", mailboxId],
				}),
			];
			const cachedEmails = listQueries.flatMap(([, cached]) =>
				!cached
					? []
					: "pages" in cached
						? cached.pages.flatMap((page) => page.emails)
						: cached.emails,
			);
			const previousEmail = [
				...cachedEmails,
				...searchQueries.flatMap(([, cached]) => searchCacheEmails(cached)),
			].find((email) => email.id === id);
			const readDelta =
				readOnlyUpdate && previousEmail && previousEmail.read !== patch.read
					? patch.read
						? -1
						: 1
					: 0;
			const affectedCategories = new Set(
				listQueries.flatMap(([key, cached]) => {
					const params = key[2];
					const containsEmail =
						!!cached &&
						("pages" in cached
							? cached.pages.some((page) => page.emails.some((email) => email.id === id))
							: cached.emails.some((email) => email.id === id));
					return containsEmail &&
						typeof params === "object" &&
						params !== null &&
						"category" in params &&
						typeof params.category === "string"
						? [params.category]
						: [];
				}),
			);
			const foldersKey = queryKeys.folders.list(mailboxId);
			const categoriesKey = ["list-categories", mailboxId] as const;
			const prevFolders = qc.getQueryData<Folder[]>(foldersKey);
			const prevCategories = qc.getQueryData<ListCategory[]>(categoriesKey);

			// Optimistically patch every cached list and search result.
			for (const [key, cached] of listQueries) {
				qc.setQueryData(
					key,
					patchListCache(cached, id, data as Partial<Email>),
				);
			}
			for (const [key, cached] of searchQueries) {
				qc.setQueryData(
					key,
					patchSearchCache(cached, id, data as Partial<Email>),
				);
			}

			// Also patch the detail cache
			const detailKey = queryKeys.emails.detail(mailboxId, id);
			const prevDetail = qc.getQueryData<Email>(detailKey);
			if (prevDetail) {
				qc.setQueryData(detailKey, { ...prevDetail, ...(data as Partial<Email>) });
			}
			if (readDelta !== 0) {
				if (previousEmail?.folder_id) {
					qc.setQueryData<Folder[]>(foldersKey, (current) =>
						current?.map((folder) =>
							folder.id === previousEmail.folder_id
								? {
										...folder,
										unreadCount: Math.max(0, folder.unreadCount + readDelta),
									}
								: folder,
						),
					);
				}
				qc.setQueryData<ListCategory[]>(categoriesKey, (current) =>
					current?.map((category) =>
						affectedCategories.has(category.id)
							? {
									...category,
									unreadCount: Math.max(
										0,
										(category.unreadCount ?? 0) + readDelta,
									),
								}
							: category,
					),
				);
			}

			return {
				listQueries,
				searchQueries,
				prevDetail,
				detailKey,
				prevFolders,
				prevCategories,
				foldersKey,
				categoriesKey,
				readOnlyUpdate,
			};
		},
		onError: (_err, _vars, context) => {
			// Roll back optimistic updates on failure
			if (context?.listQueries) {
				for (const [key, cached] of context.listQueries) {
					qc.setQueryData(key, cached);
				}
			}
			if (context?.searchQueries) {
				for (const [key, cached] of context.searchQueries) {
					qc.setQueryData(key, cached);
				}
			}
			if (context?.prevDetail) {
				if (context.readOnlyUpdate) {
					// The detail request may have completed after onMutate captured a
					// list-summary placeholder. Rolling the whole snapshot back would
					// erase bodyState/bodyErrorCode and return the panel to an endless
					// loading state. A read-only mutation only owns the read flag.
					qc.setQueryData<Email>(context.detailKey, (current) =>
						current
							? { ...current, read: context.prevDetail!.read }
							: context.prevDetail,
					);
				} else {
					qc.setQueryData(context.detailKey, context.prevDetail);
				}
			}
			if (context?.prevFolders) {
				qc.setQueryData(context.foldersKey, context.prevFolders);
			}
			if (context?.prevCategories) {
				qc.setQueryData(context.categoriesKey, context.prevCategories);
			}
		},
		onSettled: (_data, _err, { mailboxId }, context) => {
			if (context?.readOnlyUpdate) return;
			// Flag changes affect list presentation and counts. Keep the detail
			// cache stable so background reconciliation cannot replace the
			// visible subject/body with a loading state.
			qc.invalidateQueries({
				queryKey: ["emails", mailboxId],
				predicate: isListQuery,
			});
			qc.invalidateQueries({
				queryKey: queryKeys.folders.list(mailboxId),
			});
		},
	});
}

export function useDeleteEmail() {
	const invalidate = useInvalidateEmailData();
	return useMutation({
		mutationFn: ({
			mailboxId,
			id,
		}: { mailboxId: string; id: string }) =>
			api.deleteEmail(mailboxId, id),
		onSuccess: (_data, { mailboxId }) => invalidate(mailboxId),
	});
}

export function useMoveEmail() {
	const invalidate = useInvalidateEmailData();
	return useMutation({
		mutationFn: ({
			mailboxId,
			id,
			folder,
		}: { mailboxId: string; id: string; folder: string }) =>
			api.moveEmail(mailboxId, id, folder),
		onSuccess: (_data, { mailboxId }) => invalidate(mailboxId),
	});
}

/**
 * Persist a compose draft through the canonical Writer. Same payload
 * shape as send so the compose flow can pass identical inputs.
 */
export function useSaveDraft() {
	const invalidate = useInvalidateEmailData();
	return useMutation({
		mutationFn: (draft: WemailDraftSaveInput) => api.saveWemailDraft(draft),
		onSuccess: (_data, draft) => invalidate(draft.accountId),
	});
}
