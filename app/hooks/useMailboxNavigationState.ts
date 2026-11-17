import { useEffect, useState } from "react";

const STORAGE_PREFIX = "wemail.mailboxNavigation.expanded";

function storageKey(accountId: string) {
	return `${STORAGE_PREFIX}.${accountId}`;
}
function readExpanded(accountId: string | undefined): boolean {
	if (!accountId || typeof window === "undefined") return true;
	try {
		return window.localStorage.getItem(storageKey(accountId)) !== "false";
	} catch {
		return true;
	}
}
export function useMailboxNavigationState(accountId: string | undefined) {
	const [expanded, setExpandedState] = useState(() => readExpanded(accountId));

	useEffect(() => {
		setExpandedState(readExpanded(accountId));
	}, [accountId]);

	const setExpanded = (next: boolean | ((current: boolean) => boolean)) => {
		setExpandedState((current) => {
			const resolved = typeof next === "function" ? next(current) : next;
			if (accountId && typeof window !== "undefined") {
				try {
					window.localStorage.setItem(storageKey(accountId), String(resolved));
				} catch {
					// Local navigation preferences are best-effort.
				}
			}
			return resolved;
		});
	};

	return { expanded, setExpanded };
}
