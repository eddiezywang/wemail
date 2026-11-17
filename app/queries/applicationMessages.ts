import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api from "~/services/api";

const key = (accountId?: string) => ["application-messages", accountId ?? "none"];

export function useApplicationMessages(accountId?: string) {
	return useQuery({
		queryKey: key(accountId),
		queryFn: () => api.listApplicationMessages(accountId!, { archived: false, limit: 100 }),
		enabled: !!accountId,
	});
}

export function useInfiniteApplicationMessages(accountId?: string) {
	return useInfiniteQuery({
		queryKey: [...key(accountId), "pages"],
		queryFn: ({ pageParam }) => api.listApplicationMessages(accountId!, {
			archived: false,
			offset: pageParam,
			limit: 100,
		}),
		initialPageParam: 0,
		getNextPageParam: (lastPage) => lastPage.nextOffset,
		enabled: !!accountId,
	});
}

export function useMarkApplicationMessageRead(accountId?: string) {
	const client = useQueryClient();
	return useMutation({
		mutationFn: ({ id, value }: { id: string; value: boolean }) => api.markApplicationMessageRead(id, accountId!, value),
		onSuccess: () => client.invalidateQueries({ queryKey: key(accountId) }),
	});
}

export function useArchiveApplicationMessage(accountId?: string) {
	const client = useQueryClient();
	return useMutation({
		mutationFn: ({ id, value }: { id: string; value: boolean }) => api.archiveApplicationMessage(id, accountId!, value),
		onSuccess: () => client.invalidateQueries({ queryKey: key(accountId) }),
	});
}

export function useSmartTagTopicAction(accountId?: string) {
	const client = useQueryClient();
	return useMutation({
		mutationFn: (input: { topicId: string; action: "create" | "defer" | "suppress"; name?: string; description?: string }) =>
			api.actOnSmartTagTopic(input.topicId, { accountId: accountId!, ...input }),
		onSuccess: () => client.invalidateQueries({ queryKey: key(accountId) }),
	});
}
