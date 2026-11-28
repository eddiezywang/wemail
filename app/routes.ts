// Copyright (c) 2026 Cloudflare, Inc.
// Modified for WeMail.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import {
	index,
	layout,
	type RouteConfig,
	route,
} from "@react-router/dev/routes";

export default [
	layout("routes/workbench-layout.tsx", [
		index("routes/inbox.tsx"),
		route("folder/:folder", "routes/folder.tsx"),
		route("smart-tags/:id", "routes/smart-tags.tsx"),
		route("message/:id", "routes/message.tsx"),
		route("snoozed", "routes/snoozed.tsx"),
		route("scheduled", "routes/scheduled.tsx"),
		route("local-drafts", "routes/local-drafts.tsx"),
		route("todos", "routes/todos.tsx"),
		route("actions", "routes/actions.tsx"),
		route("automation", "routes/automation.tsx"),
		route("digests", "routes/digests.tsx"),
		route("notifications", "routes/notifications.tsx"),
		route("workspace", "routes/workspace.tsx"),
		route("directory", "routes/directory.tsx"),
		route("settings", "routes/settings.tsx"),
	]),
	route("onboarding", "routes/onboarding.tsx"),
	// Dev-only component gallery — gated so the route never enters the
	// production manifest (the conditional is dead-code-eliminated when
	// NODE_ENV is "production" at build time).
	...(process.env.NODE_ENV === "development"
		? [route("__dev/components", "routes/__dev/components.tsx"),
			route("__dev/demo-v1", "routes/__dev/demo_v1.tsx")]
		: []),
	route("*", "routes/not-found.tsx"),
] satisfies RouteConfig;
