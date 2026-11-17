import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import api from "~/services/api";
import {
	resetIntegrationStartupRefreshForTests,
	useIntegrationStatus,
} from "./integrationStatus";

describe("useIntegrationStatus", () => {
	beforeEach(() => {
		resetIntegrationStartupRefreshForTests();
		vi.restoreAllMocks();
	});

	it("renders retained observations first and performs exactly one silent startup refresh", async () => {
		const cached = {
			loadedAt: "2026-07-29T00:00:00.000Z",
			entries: [
				{
					id: "wecli" as const,
					label: "WeCLI",
					state: "connected" as const,
					observedAt: "2026-07-29T00:00:00.000Z",
				},
				{
					id: "feishu" as const,
					label: "飞书",
					state: "not_configured" as const,
					observedAt: null,
				},
				{
					id: "wecom" as const,
					label: "企业微信",
					state: "connected" as const,
					observedAt: "2026-07-29T00:00:00.000Z",
				},
			],
		};
		let resolveRefresh!: (value: typeof cached) => void;
		const refresh = new Promise<typeof cached>((resolve) => {
			resolveRefresh = resolve;
		});
		vi.spyOn(api, "getIntegrationStatus").mockResolvedValue(cached);
		const refreshSpy = vi
			.spyOn(api, "refreshIntegrationStatus")
			.mockReturnValue(refresh);
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		const wrapper = ({ children }: { children: ReactNode }) => (
			<QueryClientProvider client={client}>{children}</QueryClientProvider>
		);
		const { result, rerender } = renderHook(() => useIntegrationStatus(), {
			wrapper,
		});
		await waitFor(() => expect(result.current.data).toEqual(cached));
		expect(refreshSpy).toHaveBeenCalledTimes(1);
		rerender();
		window.dispatchEvent(new Event("focus"));
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(refreshSpy).toHaveBeenCalledTimes(1);
		expect(result.current.data?.entries[0]?.state).toBe("connected");

		const changed = {
			...cached,
			loadedAt: "2026-07-29T00:00:05.000Z",
			entries: cached.entries.map((entry) =>
				entry.id === "wecli"
					? { ...entry, state: "disconnected" as const }
					: entry,
			),
		};
		resolveRefresh(changed);
		await waitFor(() =>
			expect(result.current.data?.entries[0]?.state).toBe("disconnected"),
		);
	});
});
