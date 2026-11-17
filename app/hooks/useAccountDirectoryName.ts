import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import api, { type AccountCurrentResponse } from "~/services/api";
import {
	extractChineseDirectoryName,
	isOriginalEmailDisplayName,
} from "../../shared/wemail/signature";

interface DirectoryAccount {
	id: string;
	emailAddress: string;
	displayName?: string;
}

export function useAccountDirectoryName(
	account: DirectoryAccount | null | undefined,
): string | undefined {
	const queryClient = useQueryClient();
	const emailAddress = account?.emailAddress.trim() ?? "";
	const normalizedEmail = emailAddress.toLocaleLowerCase();

	// The server decides whether an enterprise directory applies to the
	// current account: with no directory configured the status query never
	// reports a completed sync and both queries stay inert.
	const status = useQuery({
		queryKey: ["directory", "status", account?.id],
		queryFn: api.getDirectoryStatus,
		enabled: Boolean(account?.id),
		staleTime: 30_000,
		refetchInterval: (query) =>
			query.state.data?.status.state === "running" ? 1_000 : false,
	});
	const hasCompletedSync =
		status.data?.status.state === "completed" ||
		Boolean(status.data?.status.lastSuccessfulAt);

	const contact = useQuery({
		queryKey: [
			"directory",
			"signature-contact",
			account?.id,
			normalizedEmail,
			status.data?.status.lastSuccessfulAt,
		],
		queryFn: async () => {
			const result = await api.searchDirectoryContacts(emailAddress, { limit: 8 });
			return (
				result.contacts.find(
					(candidate) => candidate.email.toLocaleLowerCase() === normalizedEmail,
				) ?? null
			);
		},
		enabled: Boolean(account?.id && hasCompletedSync),
		staleTime: 5 * 60_000,
	});
	const chineseName = extractChineseDirectoryName(contact.data?.name);

	useEffect(() => {
		if (
			!account ||
			!chineseName ||
			!isOriginalEmailDisplayName(account.displayName, account.emailAddress)
		) {
			return;
		}
		queryClient.setQueryData<AccountCurrentResponse>(
			["account", "current"],
			(current) => {
				if (
					!current?.account ||
					current.account.id !== account.id ||
					!isOriginalEmailDisplayName(
						current.account.displayName,
						current.account.emailAddress,
					)
				) {
					return current;
				}
				return {
					...current,
					account: { ...current.account, displayName: chineseName },
				};
			},
		);
	}, [account, chineseName, queryClient]);

	return contact.data?.name;
}
