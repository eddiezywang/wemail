// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	useAgentConversations,
	useArchiveAgentConversation,
	usePinAgentConversation,
	useRenameAgentConversation,
	useUnarchiveAgentConversation,
	useUnpinAgentConversation,
} from "./agentConversations";

interface RecordedCall {
	url: string;
	init?: RequestInit;
}

let recorded: RecordedCall[] = [];
let nextResponse: { ok: boolean; status?: number; body: unknown } = {
	ok: true,
	body: { ok: true },
};

const originalFetch = globalThis.fetch;

beforeEach(() => {
	recorded = [];
	nextResponse = { ok: true, body: { ok: true } };
	globalThis.fetch = vi.fn(async (input: RequestInfo, init?: RequestInit) => {
		const url =
			typeof input === "string"
				? input
				: input instanceof URL
					? input.toString()
					: input.url;
		recorded.push({ url, init });
		return new Response(JSON.stringify(nextResponse.body), {
			status: nextResponse.status ?? (nextResponse.ok ? 200 : 500),
			headers: { "content-type": "application/json" },
		});
	}) as typeof fetch;
});

afterEach(() => {
	globalThis.fetch = originalFetch;
});

function wrapper() {
	const qc = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	return ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={qc}>{children}</QueryClientProvider>
	);
}

describe("agent conversation mutations", () => {
	it("useRenameAgentConversation PATCHes /api/agent/conversations/:id with the title", async () => {
		nextResponse = {
			ok: true,
			body: {
				ok: true,
				conversation: {
					id: "conv-1",
					title: "New title",
					createdAt: "2026-04-26T00:00:00Z",
					updatedAt: "2026-04-27T00:00:00Z",
				},
			},
		};

		const { result } = renderHook(() => useRenameAgentConversation(), {
			wrapper: wrapper(),
		});

		await act(async () => {
			await result.current.mutateAsync({ id: "conv-1", title: "New title" });
		});

		await waitFor(() => expect(recorded.length).toBeGreaterThan(0));
		const call = recorded[0];
		expect(call.url).toContain("/api/agent/conversations/conv-1");
		expect(call.init?.method).toBe("PATCH");
		expect(JSON.parse(String(call.init?.body))).toEqual({ title: "New title" });
	});

	it("useArchiveAgentConversation POSTs /archive", async () => {
		const { result } = renderHook(() => useArchiveAgentConversation(), {
			wrapper: wrapper(),
		});

		await act(async () => {
			await result.current.mutateAsync({ id: "conv-2" });
		});

		await waitFor(() => expect(recorded.length).toBeGreaterThan(0));
		expect(recorded[0].url).toContain("/api/agent/conversations/conv-2/archive");
		expect(recorded[0].init?.method).toBe("POST");
	});

	it("useUnarchiveAgentConversation POSTs /unarchive", async () => {
		const { result } = renderHook(() => useUnarchiveAgentConversation(), {
			wrapper: wrapper(),
		});

		await act(async () => {
			await result.current.mutateAsync({ id: "conv-3" });
		});

		await waitFor(() => expect(recorded.length).toBeGreaterThan(0));
		expect(recorded[0].url).toContain(
			"/api/agent/conversations/conv-3/unarchive",
		);
		expect(recorded[0].init?.method).toBe("POST");
	});

	it("usePinAgentConversation POSTs /pin", async () => {
		const { result } = renderHook(() => usePinAgentConversation(), {
			wrapper: wrapper(),
		});

		await act(async () => {
			await result.current.mutateAsync({ id: "conv-4" });
		});

		await waitFor(() => expect(recorded.length).toBeGreaterThan(0));
		expect(recorded[0].url).toContain("/api/agent/conversations/conv-4/pin");
		expect(recorded[0].init?.method).toBe("POST");
	});

	it("useUnpinAgentConversation POSTs /unpin", async () => {
		const { result } = renderHook(() => useUnpinAgentConversation(), {
			wrapper: wrapper(),
		});

		await act(async () => {
			await result.current.mutateAsync({ id: "conv-5" });
		});

		await waitFor(() => expect(recorded.length).toBeGreaterThan(0));
		expect(recorded[0].url).toContain("/api/agent/conversations/conv-5/unpin");
		expect(recorded[0].init?.method).toBe("POST");
	});
});

describe("useAgentConversations URL params", () => {
	it("includes search + accountId in the GET when provided", async () => {
		nextResponse = { ok: true, body: { ok: true, conversations: [] } };
		const { result } = renderHook(
			() =>
				useAgentConversations(true, {
					search: "review",
					accountId: "acct-1",
				}),
			{ wrapper: wrapper() },
		);

		await waitFor(() => expect(result.current.isSuccess).toBe(true));
		await waitFor(() => expect(recorded.length).toBeGreaterThan(0));
		const url = recorded[0]?.url ?? "";
		expect(url).toContain("/api/agent/conversations");
		expect(url).toMatch(/search=review/);
		expect(url).toMatch(/accountId=acct-1/);
	});

	it("omits search + accountId params when not provided", async () => {
		nextResponse = { ok: true, body: { ok: true, conversations: [] } };
		const { result } = renderHook(() => useAgentConversations(true, {}), {
			wrapper: wrapper(),
		});

		await waitFor(() => expect(result.current.isSuccess).toBe(true));
		await waitFor(() => expect(recorded.length).toBeGreaterThan(0));
		const url = recorded[0]?.url ?? "";
		expect(url).not.toMatch(/[?&]search=/);
		expect(url).not.toMatch(/[?&]accountId=/);
	});

	it("treats blank search as no filter", async () => {
		nextResponse = { ok: true, body: { ok: true, conversations: [] } };
		const { result } = renderHook(
			() => useAgentConversations(true, { search: "   " }),
			{ wrapper: wrapper() },
		);
		await waitFor(() => expect(result.current.isSuccess).toBe(true));
		await waitFor(() => expect(recorded.length).toBeGreaterThan(0));
		expect(recorded[0]?.url ?? "").not.toMatch(/[?&]search=/);
	});
});
