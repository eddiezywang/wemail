// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { MutationCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WarningIcon } from "@phosphor-icons/react/Warning";
import { useEffect, useState } from "react";
import { useMailEvents } from "~/hooks/useMailEvents";
import { useNotificationNavigation } from "~/hooks/useNotificationNavigation";
import { useAccountDirectoryName } from "~/hooks/useAccountDirectoryName";
import { getThemeInitScript } from "~/hooks/useTheme";
import {
	isRouteErrorResponse,
	Links,
	Meta,
	Outlet,
	Scripts,
	ScrollRestoration,
	useLocation,
} from "react-router";
import { AppTitlebar } from "~/components/shell/AppTitlebar";
import ScrollbarActivity from "~/components/shell/ScrollbarActivity";
import MailCredentialDialog from "~/components/MailCredentialDialog";
import { DesktopUpdateCenter } from "~/components/updates/DesktopUpdateCenter";
import { Button } from "~/components/ui/button";
import { Toaster } from "~/components/ui/sonner";
import { TooltipProvider } from "~/components/ui/tooltip";
import { ApiError } from "~/services/api";
import { useCurrentAccount } from "~/queries/currentAccount";
import { telemetrySurface, trackTelemetry } from "~/lib/telemetry";
import { zhCN } from "~/copy/zh-CN";
import "./index.css";

function makeQueryClient() {
	return new QueryClient({
		defaultOptions: {
			queries: {
				staleTime: 30_000,
				refetchOnWindowFocus: false,
				retry: (failureCount, error) => {
					// Don't retry 4xx errors (not found, unauthorized, etc.)
					if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
						return false;
					}
					return failureCount < 2;
				},
			},
		},
		mutationCache: new MutationCache({
			onError: (error) => {
				// Global fallback for mutations that don't handle errors themselves.
				// Consumers using mutateAsync + try/catch handle their own errors.
				console.error("Mutation failed:", error);
			},
		}),
	});
}

// Lazy singleton for the browser — avoids module-scope instantiation that
// leaks cache across SSR requests.
let browserQueryClient: QueryClient | undefined;
function getQueryClient() {
	if (typeof window === "undefined") {
		// SSR: always create a fresh client per request to prevent cross-user cache leaks
		return makeQueryClient();
	}
	// Browser: reuse the same client across navigations
	if (!browserQueryClient) browserQueryClient = makeQueryClient();
	return browserQueryClient;
}

export function Layout({ children }: { children: React.ReactNode }) {
	return (
		<html lang="zh-CN" data-theme="codex">
			<head>
				<meta charSet="UTF-8" />
				<script
					dangerouslySetInnerHTML={{ __html: getThemeInitScript() }}
					suppressHydrationWarning
				/>
				<link rel="icon" type="image/png" href="/ai-panel-logo.png" />
				<meta name="viewport" content="width=device-width, initial-scale=1.0" />
				<title>{zhCN.appName}</title>
				<Meta />
				<Links />
			</head>
			<body className="bg-canvas text-ink antialiased">
				{children}
				<ScrollRestoration />
				<Scripts />
			</body>
		</html>
	);
}

export function HydrateFallback() {
	return (
		<div
			className="flex min-h-[100dvh] items-center justify-center"
			role="status"
			aria-live="polite"
		>
			<span
				aria-label={zhCN.loadingApp}
				className="inline-block h-8 w-8 animate-spin rounded-full border-2 border-current border-t-transparent text-ink-3 motion-reduce:animate-none"
			/>
		</div>
	);
}

function MailEventsBridge() {
	useMailEvents();
	useNotificationNavigation();
	return null;
}

function AccountDirectoryIdentityBridge() {
	const { data: currentAccount } = useCurrentAccount();
	useAccountDirectoryName(currentAccount?.account);
	return null;
}

function TelemetryNavigationBridge() {
	const location = useLocation();
	useEffect(() => {
		trackTelemetry("wemail_surface_viewed", {
			surface: telemetrySurface(location.pathname),
			source: "renderer",
		});
	}, [location.pathname]);
	return null;
}

export default function App() {
	// Use useState to ensure each SSR request gets a fresh client while the
	// browser reuses the same singleton across navigations.
	const [queryClient] = useState(getQueryClient);
	return (
		<QueryClientProvider client={queryClient}>
			<TooltipProvider>
				<MailEventsBridge />
				<AccountDirectoryIdentityBridge />
				<TelemetryNavigationBridge />
				<ScrollbarActivity />
				<MailCredentialDialog />
				<DesktopUpdateCenter />
				<div className="flex h-[100dvh] w-full flex-col">
					<AppTitlebar />
					<div
						className="flex-1 min-h-0"
						style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
					>
						<Outlet />
					</div>
				</div>
				<Toaster />
			</TooltipProvider>
		</QueryClientProvider>
	);
}

export function ErrorBoundary({ error }: { error: unknown }) {
	let title: string = zhCN.pageError.title;
	let description: string = zhCN.pageError.description;
	let status: number | null = null;

	if (isRouteErrorResponse(error)) {
		status = error.status;
		if (error.status === 404) {
			title = zhCN.notFound.title;
			description = zhCN.notFound.description;
		} else {
			title = zhCN.pageError.loadFailed;
		}
	}

	return (
		<div className="flex min-h-[100dvh] items-center justify-center p-8" role="alert">
			<div className="flex flex-col items-center text-center max-w-md">
				<div className="mb-4">
					<WarningIcon size={48} className="text-ink-4" />
				</div>
				<h2 className="text-base font-semibold text-ink mb-1.5">
					{status === 404 ? zhCN.notFound.title : title}
				</h2>
				<p className="text-sm text-ink-3 max-w-sm mb-5">{description}</p>
				<Button
					onClick={() => {
						window.location.href = "/";
					}}
				>
					返回首页
				</Button>
			</div>
		</div>
	);
}
