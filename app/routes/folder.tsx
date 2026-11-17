// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useMemo } from "react";
import { useParams, useSearchParams } from "react-router";
import { getFolderDisplayName, isVirtualFolder, type VirtualFolderId } from "shared/folders";
import { buildMailFilterParams } from "~/components/wemail/MailFilterPopover";
import { useMailFilters } from "~/hooks/useMailFilters";
import { useCurrentAccount } from "~/queries/currentAccount";
import { useEmails } from "~/queries/emails";
import { useSearchEmails } from "~/queries/search";
import { useVirtualEmails } from "~/queries/virtualFolders";
import { mailCategoryLabel } from "~/lib/mail-categories";
import { MessageListView } from "./_workbench";

export function meta() {
	return [{ title: "WeMail" }];
}

export default function FolderRoute() {
	const params = useParams<{ folder: string }>();
	const { data: currentAccount } = useCurrentAccount();
	const mailboxId = currentAccount?.account?.id;

	const folder = useMemo(() => {
		const raw = params.folder ?? "inbox";
		try {
			return decodeURIComponent(raw);
		} catch {
			return raw;
		}
	}, [params.folder]);

	const [searchParams] = useSearchParams();
	const q = searchParams.get("q") ?? "";
	const tag = searchParams.get("tag") ?? searchParams.get("category") ?? "";
	const virtualFolder = isVirtualFolder(folder)
		? (folder as VirtualFolderId)
		: undefined;
	const selectedCategory = searchParams.get("category") ?? "";
	const listTitle = selectedCategory
		? mailCategoryLabel(selectedCategory)
		: virtualFolder === "all-mail"
			? "所有邮件"
			: getFolderDisplayName(folder);

	const mailFilters = useMailFilters();
	const filterParams = buildMailFilterParams(mailFilters);
	const emailsQuery = useEmails(
		mailboxId,
		{
			folder,
			page: "1",
			...filterParams,
			...(tag ? { tag } : {}),
		},
		{ enabled: !!mailboxId && !q && !virtualFolder },
	);
	const virtualQuery = useVirtualEmails(
		virtualFolder ? mailboxId : undefined,
		virtualFolder ?? "all-mail",
		{
			...filterParams,
			...(searchParams.get("category")
				? { category: searchParams.get("category")! }
				: {}),
			...(searchParams.get("tag") ? { tag: searchParams.get("tag")! } : {}),
		},
	);
	const searchQuery = useSearchEmails(mailboxId, q, {
		...filterParams,
		...(virtualFolder ? { mailScope: virtualFolder === "all-mail" ? "all" : virtualFolder } : { folder }),
		...(searchParams.get("category") ? { category: searchParams.get("category")! } : {}),
		...(searchParams.get("tag") ? { smartTagId: searchParams.get("tag")! } : {}),
		...(searchParams.get("scope") ? { scope: searchParams.get("scope")! } : {}),
	});

	const query = useMemo(() => {
		if (q) {
			return {
					...searchQuery,
					data: searchQuery.data
						? {
							emails: searchQuery.data.pages.flatMap((page) => page.results),
							totalCount: searchQuery.data.pages[0]?.totalCount ?? 0,
						}
						: undefined,
			} as unknown as typeof emailsQuery;
		}
		if (virtualFolder) return virtualQuery as unknown as typeof emailsQuery;
		return emailsQuery;
	}, [q, virtualFolder, emailsQuery, searchQuery, virtualQuery]);

	return <MessageListView folder={folder} query={query} listTitle={listTitle}
		markAllReadParams={!q && !virtualFolder ? { folder, ...filterParams, ...(tag ? { tag } : {}) } : undefined} />;
}
