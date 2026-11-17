// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * upstream-parity dedicated /todos route.
 *
 * Reuses WorkbenchShell (same sidebar, command palette, settings dialog,
 * floating compose) so the workspace feels integrated. The list slot is
 * replaced by the editorial agenda; the detail slot stays empty —
 * `showDetailColumn` is gated on `selectedEmailId` so opening a "来源邮件"
 * link from a row reveals the email view in the right column.
 */

import { useState } from "react";
import { useCurrentAccount } from "~/queries/currentAccount";
import { TodosWorkspace } from "~/components/todos/TodosWorkspace";

export function meta() {
	return [{ title: "待办" }];
}

export default function TodosRoute() {
	const { data: currentAccount } = useCurrentAccount();
	const accountId = currentAccount?.account?.id;
	const [view, setView] = useState<"active" | "done">("active");

	return (
		<TodosWorkspace
			accountId={accountId}
			view={view}
			onViewChange={setView}
		/>
	);
}
