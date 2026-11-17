// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Action Center route (Route C / WP 3H).
 *
 * Mirrors the workspace route layout: thin shell over `WorkbenchShell`
 * with the action-center feed in the list slot and the standard
 * message detail in the right pane (so opening a todo's source email
 * via the workbench keyboard shortcuts still surfaces the message).
 */

import { ActionCenterFeed } from "~/components/actions/ActionCenterFeed";

export function meta() {
	return [{ title: "行动中心 / Action Center" }];
}

export default function ActionsRoute() {
	return <ActionCenterFeed />;
}
