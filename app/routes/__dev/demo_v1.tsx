// Copyright (c) 2026 Cloudflare, Inc.
// Modified for WeMail.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { MessageDetailView, MessageListView, WorkbenchShell } from "../_workbench";
import { buildMailFilterParams } from "~/components/wemail/MailFilterPopover";
import { useMailFilters } from "~/hooks/useMailFilters";
import { useCurrentAccount } from "~/queries/currentAccount";
import { useEmails } from "~/queries/emails";
import { getFolderDisplayName } from "shared/folders";
import { installDemoApi } from "./demoApi";

/**
 * Developer-only Phase-1 verification demo (`__dev/demo-v1`).
 *
 * Runs the REAL WorkbenchShell / Sidebar / MessageListView in a plain
 * browser against the demo fixtures in `demoApi.ts` — no Electron, no
 * backend. Gated in `app/routes.ts` alongside `__dev/components`.
 *
 * Purpose: verify the Phase-1 interaction changes (sidebar IA groups,
 * provider-sent folder dedupe) against the real components, not a
 * hand-built HTML copy.
 */

installDemoApi();

export function meta() {
	return [{ title: "WeMail · 一期验证" }];
}

function DemoList() {
	const { data: currentAccount } = useCurrentAccount();
	const mailboxId = currentAccount?.account?.id;
	// The demo entry opens on the merged Sent view; clicking sidebar items
	// navigates the real framework routes, which read the same mocks.
	const folder = "sent";

	const mailFilters = useMailFilters();
	const filterParams = buildMailFilterParams(mailFilters);
	const query = useEmails(
		mailboxId,
		{ folder, page: "1", ...filterParams },
		{ enabled: !!mailboxId },
	);

	return (
		<MessageListView
			folder={folder}
			query={query}
			listTitle={getFolderDisplayName(folder)}
			markAllReadParams={{ folder, page: "1", ...filterParams }}
		/>
	);
}

export default function DemoV1Route() {
	return <WorkbenchShell list={<DemoList />} detail={<MessageDetailView />} />;
}
