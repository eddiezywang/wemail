// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Chip, type ChipVariant } from "./Chip";

const VARIANTS: { variant: ChipVariant; expected: RegExp }[] = [
	{ variant: "coral", expected: /text-coral/ },
	{ variant: "amber", expected: /text-amber/ },
	{ variant: "green", expected: /text-green/ },
	{ variant: "blue", expected: /text-blue/ },
	{ variant: "ink", expected: /text-ink/ },
];

describe("Chip", () => {
	it("renders the label", () => {
		render(<Chip variant="ink" label="Inbox" />);
		expect(screen.getByTestId("chip")).toHaveTextContent("Inbox");
	});

	it("always exposes data-testid='chip'", () => {
		render(<Chip variant="coral" label="Urgent" />);
		expect(screen.getByTestId("chip")).toBeInTheDocument();
	});

	it.each(VARIANTS)(
		"applies the $variant variant class",
		({ variant, expected }) => {
			render(<Chip variant={variant} label={`v-${variant}`} />);
			const el = screen.getByTestId("chip");
			expect(el.className).toMatch(expected);
		},
	);

	it("renders a disabled chip with reduced opacity / aria-disabled", () => {
		render(<Chip variant="ink" label="Off" disabled />);
		const el = screen.getByTestId("chip");
		expect(el).toHaveAttribute("aria-disabled", "true");
	});

	it("renders a remove button with accessible name when removable", () => {
		render(
			<Chip
				variant="ink"
				label="meeting"
				removable
				onRemove={() => {}}
			/>,
		);
		const removeBtn = screen.getByRole("button", {
			name: "Remove meeting",
		});
		expect(removeBtn).toBeInTheDocument();
	});

	it("invokes onRemove when the remove button is clicked", async () => {
		const user = userEvent.setup();
		const onRemove = vi.fn();
		render(
			<Chip
				variant="coral"
				label="urgent"
				removable
				onRemove={onRemove}
			/>,
		);
		await user.click(
			screen.getByRole("button", { name: "Remove urgent" }),
		);
		expect(onRemove).toHaveBeenCalledTimes(1);
	});

	it("does not render the remove button when not removable", () => {
		render(<Chip variant="ink" label="static" />);
		expect(screen.queryByRole("button")).toBeNull();
	});
});
