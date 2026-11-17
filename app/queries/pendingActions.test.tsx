import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import api from "~/services/api";
import { useResolvePendingAction } from "./pendingActions";

afterEach(() => {
	vi.restoreAllMocks();
});

function wrapper(client: QueryClient) {
	return ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
}

describe("useResolvePendingAction", () => {
	it("refreshes scene actions after a confirmed action resolves", async () => {
		const client = new QueryClient({
			defaultOptions: { mutations: { retry: false } },
		});
		const invalidateQueries = vi.spyOn(client, "invalidateQueries");
		vi.spyOn(api, "resolvePendingAction").mockResolvedValue({ ok: true } as never);
		const { result } = renderHook(() => useResolvePendingAction(), {
			wrapper: wrapper(client),
		});

		await act(async () => {
			await result.current.mutateAsync({ id: "invoice-upload-1", status: "confirmed" });
		});

		expect(invalidateQueries).toHaveBeenCalledWith({
			queryKey: ["wemail-intelligence"],
		});
	});
});
