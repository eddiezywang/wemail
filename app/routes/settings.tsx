// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * `/settings` route.
 *
 * The settings UI is now a upstream-style modal dialog mounted inside the
 * Workbench shell (`app/components/settings/SettingsDialog.tsx`). To
 * keep deep links working, this route opens the dialog via the UI
 * store and bounces the URL back to the inbox.
 *
 * Unauthenticated visitors are still gated to /onboarding (same gate
 * the WorkbenchShell uses) so a deep-link to /settings doesn't expose
 * an account-less workbench flash.
 */

import { useEffect } from "react";
import { Navigate, useSearchParams } from "react-router";
import { resolveSettingsDestination } from "~/components/settings/settingsNavigation";
import { useUIStore } from "~/hooks/useUIStore";
import { useCurrentAccount } from "~/queries/currentAccount";

export default function SettingsRoute() {
	const openSettings = useUIStore((s) => s.openSettings);
	const { data: currentAccount, isLoading } = useCurrentAccount();
	const [searchParams] = useSearchParams();
	const destination = resolveSettingsDestination(searchParams.get("section"));

	useEffect(() => {
		if (currentAccount?.account && destination.kind === "settings") {
			openSettings(destination.section);
		}
	}, [currentAccount?.account, destination.kind, destination.kind === "settings" ? destination.section : "", openSettings]);

	if (!isLoading && !currentAccount?.account) {
		return <Navigate to="/onboarding" replace />;
	}
	if (destination.kind === "route") {
		return <Navigate to={destination.to} replace />;
	}
	return <Navigate to="/" replace />;
}
