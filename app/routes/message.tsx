// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Standalone message route. Reachable via direct URL (`/message/:id`)
 * for shareable / deep links. The list slot stays anchored to the
 * inbox so the user keeps a sense of context while reading the
 * message; the detail slot is driven by the UI store, which the
 * effect below seeds with the URL id.
 */

import { useEffect } from "react";
import { useParams, useSearchParams } from "react-router";
import { Folders } from "shared/folders";
import { useEmails } from "~/queries/emails";
import { useCurrentAccount } from "~/queries/currentAccount";
import { useUIStore } from "~/hooks/useUIStore";
import { useMailFilters } from "~/hooks/useMailFilters";
import { buildMailFilterParams } from "~/components/wemail/MailFilterPopover";
import { MessageListView } from "./_workbench";

export function meta() {
	return [{ title: "Message" }];
}

export default function MessageRoute() {
	const { id } = useParams<{ id: string }>();
	const folder = Folders.INBOX;
	const { data: currentAccount } = useCurrentAccount();
	const mailboxId = currentAccount?.account?.id;
	const [searchParams] = useSearchParams();
	const requestedAccountId = searchParams.get("accountId") ?? undefined;
	const sourceAccountId = requestedAccountId ?? mailboxId;
	const tag = searchParams.get("tag") ?? searchParams.get("category") ?? "";

	const mailFilters = useMailFilters();
	const query = useEmails(
		sourceAccountId,
		{
			folder,
			page: "1",
			...buildMailFilterParams(mailFilters),
			...(tag ? { tag } : {}),
		},
		{ enabled: !!sourceAccountId },
	);

	const selectEmail = useUIStore((state) => state.selectEmail);

	// Sync the URL id into the UI store so the detail slot renders the
	// requested message and the rest of the workbench (compose-as-reply
	// etc.) sees it as the active selection.
	useEffect(() => {
		if (id) selectEmail(id);
	}, [id, selectEmail]);

	return <MessageListView folder={folder} query={query} />;
}
