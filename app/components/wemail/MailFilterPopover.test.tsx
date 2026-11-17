// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it } from "vitest";
import { TooltipProvider } from "~/components/ui/tooltip";
import { useUIStore } from "~/hooks/useUIStore";
import MailFilterPopover, { MailFilterChips } from "./MailFilterPopover";

function renderPopover() {
	return render(
		<MemoryRouter initialEntries={["/inbox"]}>
			<TooltipProvider>
				<MailFilterPopover>
					<button type="button">open</button>
				</MailFilterPopover>
			</TooltipProvider>
		</MemoryRouter>,
	);
}

function renderChips() {
	return render(
		<MemoryRouter initialEntries={["/inbox"]}>
			<MailFilterChips />
		</MemoryRouter>,
	);
}

describe("MailFilterPopover", () => {
	beforeEach(() => {
		useUIStore.setState({
			mailFilters: {
				unread: false,
				toMe: false,
				ccMe: false,
				hasAttachment: false,
				olderThan: null,
			},
		});
	});

	it("toggles filters from the popover UI", async () => {
		const user = userEvent.setup();
		renderPopover();

		await user.click(screen.getByRole("button", { name: "open" }));
		await user.click(screen.getByTestId("mail-filter-unread"));
		await user.click(screen.getByTestId("mail-filter-hasAttachment"));
		await user.click(screen.getByTestId("mail-filter-older-30d"));

		expect(useUIStore.getState().mailFilters).toEqual({
			unread: true,
			toMe: false,
			ccMe: false,
			hasAttachment: true,
			olderThan: "30d",
		});
	});

	it("renders nothing when no filter is active", () => {
		const { container } = renderChips();
		expect(container).toBeEmptyDOMElement();
	});

	it("shows active filters as removable chips with a clear-all", async () => {
		const user = userEvent.setup();
		useUIStore.setState({
			mailFilters: {
				unread: true,
				toMe: false,
				ccMe: false,
				hasAttachment: false,
				olderThan: "30d",
			},
		});
		renderChips();

		const chips = screen.getByTestId("mail-filter-chips");
		expect(chips).toHaveTextContent("待我查看");
		expect(chips).toHaveTextContent("一个月前之前");

		await user.click(screen.getByRole("button", { name: "移除筛选：待我查看" }));
		expect(useUIStore.getState().mailFilters.unread).toBe(false);
		expect(useUIStore.getState().mailFilters.olderThan).toBe("30d");

		await user.click(screen.getByTestId("mail-filter-chips-clear"));
		expect(useUIStore.getState().mailFilters.olderThan).toBeNull();
	});
});
