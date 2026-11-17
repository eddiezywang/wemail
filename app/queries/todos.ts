// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import {
	useInfiniteQuery,
	useMutation,
	useQueryClient,
} from "@tanstack/react-query";
import api from "~/services/api";
import type {
	TaskAgentStatus,
	TodoItem,
} from "../../shared/wemail/intelligence";

export function useCreateTodo() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (input: {
			accountId: string;
			emailId: string;
			title: string;
			description?: string;
			dueDate?: string;
			startTime?: string;
			endTime?: string;
			timezone?: string;
			priority?: "high" | "medium" | "low";
			/** Initial Task Agent status (F3); locks the status when set. */
			agentStatus?: TaskAgentStatus | null;
		}) => api.createTodo(input),
		onSuccess: (_data, vars) => {
			// Refresh per-message todo list and any aggregated views.
			qc.invalidateQueries({
				queryKey: ["wemail-todos", vars.emailId],
			});
			qc.invalidateQueries({ queryKey: ["intelligence", vars.emailId] });
			qc.invalidateQueries({ queryKey: accountTodoKeys.all });
			qc.invalidateQueries({ queryKey: ["agent-suggestions", vars.accountId] });
		},
	});
}

/* ── Account-scoped queries (used by /todos route) ───────────────── */

export const accountTodoKeys = {
	all: ["todos", "account"] as const,
	list: (accountId: string, status?: string) =>
		["todos", "account", accountId, status ?? "all"] as const,
};

export function useAccountTodos(
	accountId: string | undefined,
	status?: "open" | "completed",
) {
	return useInfiniteQuery({
		queryKey: accountTodoKeys.list(accountId ?? "", status),
		initialPageParam: 1,
		enabled: !!accountId,
		queryFn: async ({ pageParam }) => {
			const res = await api.listAccountTodos(accountId as string, status, { page: pageParam, limit: 50 });
			return {
				todos: res.todos,
				totalCount: (res as { totalCount?: number }).totalCount ?? res.todos.length,
				hasMore: (res as { hasMore?: boolean }).hasMore ?? false,
			};
		},
		getNextPageParam: (lastPage, _pages, lastPageParam) =>
			lastPage.hasMore ? Number(lastPageParam) + 1 : undefined,
		select: (data) => ({
			...data,
			todos: data.pages.flatMap((page) => page.todos),
		}),
		retry: 3,
	});
}

function invalidateAccountTodos(qc: ReturnType<typeof useQueryClient>) {
	qc.invalidateQueries({ queryKey: accountTodoKeys.all });
	qc.invalidateQueries({ queryKey: ["agent-suggestions"] });
}

export function useCompleteAccountTodo() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (todoId: string) => api.completeTodo(todoId),
			onMutate: async (todoId) => {
				await qc.cancelQueries({ queryKey: accountTodoKeys.all });
				const previous = qc.getQueriesData<{ pages: Array<{ todos: TodoItem[] }>; pageParams: unknown[] }>({
					queryKey: accountTodoKeys.all,
				});
				const hasTodo = previous.some(([, current]) =>
					current?.pages.some((page) => page.todos.some((todo) => todo.id === todoId)),
				);
			if (!hasTodo) return { previous: [] };
			for (const [queryKey, current] of previous) {
					if (!current) continue;
					const status = queryKey[3];
					qc.setQueryData<{ pages: Array<{ todos: TodoItem[] }>; pageParams: unknown[] }>(
						queryKey,
						{
							...current,
							pages: current.pages.map((page) => ({
								...page,
								todos: status === "open"
									? page.todos.filter((todo) => todo.id !== todoId)
									: page.todos.map((todo) => todo.id === todoId
										? { ...todo, done: true, doneDate: new Date().toISOString() }
										: todo),
							})),
						},
					);
			}
			return { previous };
		},
		onError: (_error, _todoId, context) => {
			for (const [queryKey, todos] of context?.previous ?? []) {
				qc.setQueryData(queryKey, todos);
			}
		},
		onSettled: () => invalidateAccountTodos(qc),
	});
}

export function useRestoreAccountTodo() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (todoId: string) => api.restoreTodo(todoId),
		onSuccess: () => invalidateAccountTodos(qc),
	});
}

/**
 * Delete + suppress an AI-extracted todo. The server records a suppression
 * row so later re-extraction can't resurface the same suggestion — which
 * doubles as the "incorrect" feedback signal upstream describes.
 */
export function useRejectAccountTodo() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (todoId: string) => api.rejectTodo(todoId),
		onSuccess: () => invalidateAccountTodos(qc),
	});
}

export function useDeleteAccountTodo() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (todoId: string) => api.deleteTodo(todoId),
		onSuccess: () => invalidateAccountTodos(qc),
	});
}

export function useUpdateAccountTodo() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ todoId, patch }: {
			todoId: string;
			patch: Parameters<typeof api.updateTodo>[1];
		}) => api.updateTodo(todoId, patch),
		onSuccess: () => invalidateAccountTodos(qc),
	});
}

export function useConfirmAccountTodo() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (todoId: string) => api.confirmTodo(todoId),
		onSuccess: () => invalidateAccountTodos(qc),
	});
}
