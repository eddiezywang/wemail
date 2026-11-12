import { useLayoutEffect } from "react";
import { useLocation } from "react-router";
import {
	createDefaultMailFilters,
	useUIStore,
	type MailFilters,
} from "./useUIStore";

/**
 * Returns filters for the active directory only. During a route transition,
 * the old scope is deliberately treated as empty before the store reset runs,
 * so the new list cannot render with another directory's filters.
 */
export function useMailFilters(): MailFilters {
	const { pathname } = useLocation();
	const mailFilters = useUIStore((state) => state.mailFilters);
	const mailFilterScope = useUIStore((state) => state.mailFilterScope);
	const setMailFilterScope = useUIStore((state) => state.setMailFilterScope);

	useLayoutEffect(() => {
		setMailFilterScope(pathname);
	}, [pathname, setMailFilterScope]);

	return mailFilterScope === pathname
		? mailFilters
		: createDefaultMailFilters();
}
