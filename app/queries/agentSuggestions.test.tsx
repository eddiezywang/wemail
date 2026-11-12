import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import api from "~/services/api";
import {
	isSemanticHomeSuggestion,
	useAgentSuggestions,
} from "./agentSuggestions";

afterEach(() => {
	vi.restoreAllMocks();
});

function wrapper(client: QueryClient) {
	return ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
}

const aggregateSuggestion = {
	id: "aggregate-alerts-24h",
	label: "汇总过去 24 小时的系统告警",
	prompt: "汇总过去 24 小时全部系统告警，按系统和严重程度统计。",
	kind: "aggregate" as const,
	discovery: {
		emailIds: ["alert-unread-1", "alert-unread-2"],
		primaryWindow: "24h" as const,
		mailState: "unread" as const,
	},
	executionScope: {
		mode: "query" as const,
		query: {
			receivedWithin: "24h" as const,
			mailState: "all" as const,
			folder: "inbox" as const,
			category: "notification",
			subject: "告警 alert alarm warning",
		},
	},
};

describe("home agent suggestion contract", () => {
	it("accepts a complete multi-mail semantic action", () => {
		expect(isSemanticHomeSuggestion(aggregateSuggestion)).toBe(true);
	});

	it("rejects a fixed account shortcut without discovery evidence", () => {
		expect(
			isSemanticHomeSuggestion({
				id: "open-pending-digests",
				label: "打开摘要中心",
				prompt: "打开摘要中心。",
				action: { type: "open_digest_center", filter: "pending" },
			}),
		).toBe(false);
	});

	it("preserves semantic fields and removes invalid shortcuts on home", async () => {
		vi.spyOn(api, "getAgentSuggestions").mockResolvedValue({
			ok: true,
			suggestions: [
				aggregateSuggestion,
				{
					id: "show-todos",
					label: "查看待办",
					prompt: "查看未完成待办。",
				},
			],
		} as never);
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});

		const { result } = renderHook(
			() => useAgentSuggestions({ mailboxId: "acct-1", emailId: null }),
			{ wrapper: wrapper(client) },
		);

		await waitFor(() => expect(result.current.isSuccess).toBe(true));
		expect(result.current.data?.suggestions).toEqual([aggregateSuggestion]);
	});
});
