// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Feature F1 — dedicated "Snoozed" route.
 *
 * Reuses the existing workbench shell + virtual-folder query pipeline
 * so the row layout, message detail panel, and selection state behave
 * exactly like /folder/snoozed. Having a top-level path makes the route
 * linkable from notifications / the command palette without leaning on
 * the generic /folder/:folder pattern.
 */

import { VirtualFolders } from "shared/folders";
import { useCurrentAccount } from "~/queries/currentAccount";
import { useVirtualEmails } from "~/queries/virtualFolders";
import {
	MessageListView,
} from "./_workbench";

export function meta() {
	return [{ title: "Snoozed" }];
}

export default function SnoozedRoute() {
	const { data: currentAccount } = useCurrentAccount();
	const mailboxId = currentAccount?.account?.id;
	const query = useVirtualEmails(mailboxId, VirtualFolders.SNOOZED);

	return (
		<MessageListView
			folder={VirtualFolders.SNOOZED}
			// MessageListView expects the same shape as `useEmails`.
			query={query as unknown as Parameters<typeof MessageListView>[0]["query"]}
		/>
	);
}
