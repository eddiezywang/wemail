// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useMemo } from "react";
import { useSearchParams } from "react-router";
import { Folders } from "shared/folders";
import { buildMailFilterParams } from "~/components/wemail/MailFilterPopover";
import { useMailFilters } from "~/hooks/useMailFilters";
import { useEmails } from "~/queries/emails";
import { useCurrentAccount } from "~/queries/currentAccount";
import { useSearchEmails } from "~/queries/search";
import { MessageListView } from "./_workbench";

export function meta() {
	return [{ title: "WeMail" }];
}

export default function InboxRoute() {
	const folder = Folders.INBOX;
	const { data: currentAccount } = useCurrentAccount();
	const mailboxId = currentAccount?.account?.id;
	const [searchParams] = useSearchParams();
	const q = searchParams.get("q") ?? "";
	const category = searchParams.get("category") ?? "";
	const mailFilters = useMailFilters();
	const filterParams = useMemo(
		() => buildMailFilterParams(mailFilters),
		[mailFilters],
	);
	const emailsQuery = useEmails(
		mailboxId,
		{
			folder,
			page: "1",
			...filterParams,
			...(category ? { category } : {}),
		},
		{ enabled: !!mailboxId && !q },
	);
	const searchQuery = useSearchEmails(mailboxId, q, {
		...filterParams,
		folder,
		...(category ? { category } : {}),
	});

	const query = useMemo(() => {
		if (!q) return emailsQuery;
		return {
			...searchQuery,
			data: searchQuery.data
				? {
						emails: searchQuery.data.pages.flatMap((page) => page.results),
						totalCount: searchQuery.data.pages[0]?.totalCount ?? 0,
						unreadCount: searchQuery.data.pages.flatMap((page) => page.results).filter(
							(email) => email.read === false,
						).length,
					}
				: undefined,
		} as unknown as typeof emailsQuery;
	}, [q, emailsQuery, searchQuery]);

	return <MessageListView folder={folder} query={query} showCategoryTabs
		markAllReadParams={!q ? { folder, ...filterParams, ...(category && category !== "all" ? { category } : {}) } : undefined} />;
}
