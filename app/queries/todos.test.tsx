import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import api from "~/services/api";
import type { TodoItem } from "../../shared/wemail/intelligence";
import { accountTodoKeys, useCompleteAccountTodo } from "./todos";

afterEach(() => vi.restoreAllMocks());

describe("useCompleteAccountTodo", () => {
	it("removes the todo from the open list before the request finishes", async () => {
		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
		});
		const key = accountTodoKeys.list("acct-1", "open");
		// The account todo list is an infinite query — seed the paged shape
		// the optimistic onMutate handler actually reads.
		queryClient.setQueryData<{ pages: Array<{ todos: TodoItem[] }>; pageParams: unknown[] }>(
			key,
			{
				pages: [[{
					id: "todo-1",
					emailId: "mail-1",
					accountId: "acct-1",
					title: "Review contract",
					done: false,
					status: "confirmed",
					source: "user",
					createdAt: "2026-08-11T00:00:00.000Z",
					updatedAt: "2026-08-11T00:00:00.000Z",
				}]].map((todos) => ({ todos })),
				pageParams: [null],
			},
		);

		let finishRequest!: () => void;
		const request = new Promise<{ ok: boolean }>((resolve) => {
			finishRequest = () => resolve({ ok: true });
		});
		vi.spyOn(api, "completeTodo").mockReturnValue(request as never);
		const { result } = renderHook(() => useCompleteAccountTodo(), {
			wrapper: ({ children }: { children: ReactNode }) => (
				<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
			),
		});

		act(() => result.current.mutate("todo-1"));
		await waitFor(() => {
			const cached = queryClient.getQueryData<{
				pages: Array<{ todos: TodoItem[] }>;
			}>(key);
			expect(cached?.pages[0]?.todos).toEqual([]);
		});
		await act(async () => {
			finishRequest();
			await request;
		});
	});
});
