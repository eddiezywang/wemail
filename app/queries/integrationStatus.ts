import {
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useEffect } from "react";
import type {
	IntegrationConnectionId,
	IntegrationConnectionSnapshot,
} from "../../shared/wemail/channels";
import api from "~/services/api";
import { buildIntegrationEventsUrl } from "~/services/api";

export const integrationStatusKey = ["integrations", "status"] as const;
let startupRefreshStarted = false;

export function useIntegrationStatus() {
	const client = useQueryClient();
	const query = useQuery<IntegrationConnectionSnapshot>({
		queryKey: integrationStatusKey,
		queryFn: () => api.getIntegrationStatus(),
		// The first snapshot can be read before Bot Core has finished
		// reconnecting. Keep it visible, but allow a later mount/focus to pick
		// up the retained connected observation without requiring a manual
		// detection from the settings page.
		staleTime: 5_000,
		refetchOnMount: "always",
		refetchOnWindowFocus: true,
		refetchOnReconnect: true,
		refetchInterval: (current) =>
			needsStartupSync(current.state.data) ? 1_500 : false,
	});

	useEffect(() => {
		if (!query.data || startupRefreshStarted) return;
		startupRefreshStarted = true;
		const schedule =
			typeof window !== "undefined" && "requestIdleCallback" in window
				? (callback: () => void) =>
						(window as Window & {
							requestIdleCallback: (value: () => void) => number;
						}).requestIdleCallback(callback)
				: (callback: () => void) => window.setTimeout(callback, 0);
		schedule(() => {
			void api
				.refreshIntegrationStatus()
				.then((snapshot) =>
					client.setQueryData(integrationStatusKey, snapshot),
				)
				.catch(() => undefined);
		});
	}, [client, query.data]);

	useEffect(() => {
		if (typeof EventSource === "undefined") return;
		const source = new EventSource(buildIntegrationEventsUrl());
		const onStatus = (event: MessageEvent<string>) => {
			try {
				client.setQueryData(
					integrationStatusKey,
					JSON.parse(event.data) as IntegrationConnectionSnapshot,
				);
			} catch {
				// Ignore malformed passive events; the retained snapshot stays visible.
			}
		};
		source.addEventListener("integration-status", onStatus as EventListener);
		return () => source.close();
	}, [client]);

	return query;
}

function needsStartupSync(
	snapshot: IntegrationConnectionSnapshot | undefined,
): boolean {
	return snapshot?.entries.some(
		(entry) => entry.state === "unknown" || entry.state === "checking",
	) ?? true;
}

export function useDetectIntegrationStatus(id: IntegrationConnectionId) {
	const client = useQueryClient();
	return useMutation({
		mutationFn: () => api.refreshIntegrationStatus(id),
		onSuccess: (snapshot) =>
			client.setQueryData(integrationStatusKey, snapshot),
	});
}

export function resetIntegrationStartupRefreshForTests() {
	startupRefreshStarted = false;
}
