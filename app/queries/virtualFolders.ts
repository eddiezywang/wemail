// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Server-backed virtual mail views.
 *
 * Views represented by `mail_messages` use the same stable-cursor query as
 * ordinary folders. Scheduled sends are an outbox model and are rendered by
 * `/scheduled`; they must not be approximated by filtering ordinary mail.
 */

import { useMemo } from "react";
import { VirtualFolders, type VirtualFolderId } from "shared/folders";
import type { Email } from "~/types";
import { useEmails } from "./emails";

interface EmailListResponse {
	emails: Email[];
	totalCount: number;
	unreadCount: number;
	hasMore?: boolean;
	nextCursor?: string;
}

interface VirtualMailFilters {
	unread?: string;
	toMe?: string;
	ccMe?: string;
	hasAttachment?: string;
	olderThan?: string;
	category?: string;
	tag?: string;
}

/**
 * `useEmails` for one of the system folders. Hook order is fixed —
 * we always call all hooks regardless of view, then pick one.
 */
function useAllMailQuery(
	mailboxId: string | undefined,
	view: VirtualFolderId,
	filters?: VirtualMailFilters,
) {
	const serverScoped =
		view === VirtualFolders.ALL_MAIL ||
		view === VirtualFolders.STARRED ||
		view === VirtualFolders.SNOOZED ||
		view === VirtualFolders.NEWSLETTER ||
		view === VirtualFolders.TODOS;
	const scope = view === VirtualFolders.ALL_MAIL
		? undefined
		: view === VirtualFolders.STARRED ||
			  view === VirtualFolders.SNOOZED ||
			  view === VirtualFolders.NEWSLETTER ||
			  view === VirtualFolders.TODOS
			? view
			: undefined;
	const allQuery = useEmails(
		mailboxId,
		{
			page: "1",
			...(view === VirtualFolders.ALL_MAIL ? { allMail: "1" } : {}),
			...(scope ? { scope } : {}),
			...(filters?.unread ? { unread: filters.unread } : {}),
			...(filters?.toMe ? { toMe: filters.toMe } : {}),
			...(filters?.ccMe ? { ccMe: filters.ccMe } : {}),
			...(filters?.hasAttachment
				? { hasAttachment: filters.hasAttachment }
				: {}),
			...(filters?.olderThan ? { olderThan: filters.olderThan } : {}),
			...(filters?.category ? { category: filters.category } : {}),
			...(filters?.tag ? { tag: filters.tag } : {}),
		},
			{ enabled: serverScoped && !!mailboxId, refetchInterval: view === VirtualFolders.SNOOZED ? 60_000 : undefined },
	);
	return { allQuery };
}

/**
 * Returns the view's emails as if it were a normal `useEmails` call.
 * The shape matches `EmailListResponse` so `MessageListView` can render
 * it without code changes.
 */
export function useVirtualEmails(
	mailboxId: string | undefined,
	view: VirtualFolderId,
	filters?: VirtualMailFilters,
) {
	const isAllMail = view === VirtualFolders.ALL_MAIL;
	const serverScoped =
		isAllMail ||
		view === VirtualFolders.STARRED ||
		view === VirtualFolders.SNOOZED ||
		view === VirtualFolders.NEWSLETTER ||
		view === VirtualFolders.TODOS;
	const { allQuery } = useAllMailQuery(
		mailboxId,
		view,
		filters,
	);
	const unsupportedVirtualQuery = useEmails(
		mailboxId,
		{ folder: "__unsupported_virtual_view__" },
		{ enabled: false },
	);

	const data: EmailListResponse | undefined = useMemo(() => {
		if (serverScoped) {
			return allQuery.data;
		}
		return undefined;
	}, [
		serverScoped,
		allQuery.data,
	]);

		const activeQuery = serverScoped ? allQuery : unsupportedVirtualQuery;

	// Surface the underlying React Query state so the list view can
	// show skeletons / errors normally.
	return {
		...activeQuery,
		data,
	} as ReturnType<typeof useEmails> & { data: EmailListResponse | undefined };
}

/**
 * Whether a virtual view is currently empty *because* it has no
 * persistence yet. Used to pick the right empty-state message.
 */
export function virtualViewIsLocalOnly(view: VirtualFolderId): boolean {
	return view === VirtualFolders.SCHEDULED;
}
