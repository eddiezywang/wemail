// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MailDigestRecord, MailDigestStatus } from "shared/wemail/digests";
import api from "~/services/api";
import { digestKeys, useDigestList, useGenerateDigest, useLatestDigest } from "./digests";

let nextResponseBody: unknown;
let generateDigestSpy: ReturnType<typeof vi.spyOn>;
let getLatestDigestSpy: ReturnType<typeof vi.spyOn>;
let listDigestsSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	nextResponseBody = undefined;
	generateDigestSpy = vi.spyOn(api, "generateDigest").mockImplementation(async () => nextResponseBody as never);
	getLatestDigestSpy = vi.spyOn(api, "getLatestDigest").mockImplementation(async () => nextResponseBody as never);
	listDigestsSpy = vi.spyOn(api, "listDigests").mockImplementation(async () => nextResponseBody as never);
});

afterEach(() => {
	generateDigestSpy.mockRestore();
	getLatestDigestSpy.mockRestore();
	listDigestsSpy.mockRestore();
});

function createQueryClient() {
	return new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
}

function wrapper(queryClient: QueryClient) {
	return ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
	);
}

describe("useGenerateDigest", () => {
	it("updates the scoped digest status cache with the generated digest", async () => {
		const queryClient = createQueryClient();
		const scope = { scopeKind: "folder" as const, scopeKey: "ARCHIVE" };
		const availableStatus: MailDigestStatus = {
			state: "available",
			reason: "manual",
			scopeKind: scope.scopeKind,
			scopeKey: scope.scopeKey,
			windowStart: "2026-06-26T08:00:00.000Z",
			windowEnd: "2026-06-26T16:00:00.000Z",
			emailCount: 2,
			digest: null,
		};
		const digest: MailDigestRecord = {
			id: "digest-archive-1",
			accountId: "acct-1",
			kind: "manual",
			scopeKind: scope.scopeKind,
			scopeKey: scope.scopeKey,
			windowStart: availableStatus.windowStart!,
			windowEnd: availableStatus.windowEnd!,
			emailCount: 2,
			model: "test-model",
			createdAt: "2026-06-26T16:01:00.000Z",
			result: {
				type: "mailDigest",
				overview: ["归档文件夹摘要已生成"],
				themes: [],
				actionItems: [],
				stats: {
					totalEmails: 2,
					includedEmails: 2,
					truncated: false,
				},
			},
		};
		queryClient.setQueryData(
			digestKeys.status("acct-1", scope),
			availableStatus,
		);
		nextResponseBody = { ok: true, digest };

		const { result } = renderHook(() => useGenerateDigest("acct-1", scope), {
			wrapper: wrapper(queryClient),
		});

		await act(async () => {
			await result.current.mutateAsync({
				kind: "manual",
				windowStart: availableStatus.windowStart!,
				windowEnd: availableStatus.windowEnd!,
			});
		});

		expect(queryClient.getQueryData(digestKeys.status("acct-1", scope))).toEqual({
			state: "ready",
			reason: "manual",
			scopeKind: scope.scopeKind,
			scopeKey: scope.scopeKey,
			windowStart: digest.windowStart,
			windowEnd: digest.windowEnd,
			emailCount: digest.emailCount,
			digest,
		});
	});
});

describe("useLatestDigest", () => {
	it("requests the latest digest for a specific kind", async () => {
		const queryClient = createQueryClient();
		nextResponseBody = { ok: true, digest: null };

		renderHook(
			() => useLatestDigest(
				"acct-1",
				{ scopeKind: "folder", scopeKey: "INBOX" },
				"daily",
			),
			{ wrapper: wrapper(queryClient) },
		);

		await waitFor(() => {
			expect(api.getLatestDigest).toHaveBeenCalled();
		});

		expect(api.getLatestDigest).toHaveBeenCalledWith(
			"acct-1",
			{ scopeKind: "folder", scopeKey: "INBOX" },
			"daily",
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
	});
});

describe("useDigestList", () => {
	it("requests a scoped digest list with kind and limit", async () => {
		const queryClient = createQueryClient();
		nextResponseBody = { ok: true, digests: [] };

		renderHook(
			() => useDigestList(
				"acct-1",
				{ scopeKind: "folder", scopeKey: "INBOX" },
				"daily",
				7,
			),
			{ wrapper: wrapper(queryClient) },
		);

		await waitFor(() => {
			expect(api.listDigests).toHaveBeenCalled();
		});

		expect(api.listDigests).toHaveBeenCalledWith(
			"acct-1",
			{ scopeKind: "folder", scopeKey: "INBOX" },
			"daily",
			7,
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
	});
});
