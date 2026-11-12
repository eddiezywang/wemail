import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useMailboxNavigationState } from "./useMailboxNavigationState";

describe("useMailboxNavigationState", () => {
	beforeEach(() => {
		localStorage.clear();
	});

	it("defaults each account to expanded and persists collapse state", () => {
		const { result, rerender } = renderHook(
			({ accountId }) => useMailboxNavigationState(accountId),
			{ initialProps: { accountId: "acct-1" } },
		);

		expect(result.current.expanded).toBe(true);
		act(() => result.current.setExpanded(false));
		expect(result.current.expanded).toBe(false);

		rerender({ accountId: "acct-2" });
		expect(result.current.expanded).toBe(true);
		rerender({ accountId: "acct-1" });
		expect(result.current.expanded).toBe(false);
	});
});
