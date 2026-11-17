// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { TagPin, type TagPinVariant } from "./TagPin";

const VARIANTS: { variant: TagPinVariant; expected: RegExp }[] = [
	{ variant: "coral", expected: /text-coral/ },
	{ variant: "amber", expected: /text-amber/ },
	{ variant: "green", expected: /text-green/ },
	{ variant: "blue", expected: /text-blue/ },
	{ variant: "ink", expected: /text-ink/ },
];

describe("TagPin", () => {
	it("renders label and dot, exposes data-testid='tag-pin'", () => {
		render(<TagPin label="Work" variant="blue" />);
		const el = screen.getByTestId("tag-pin");
		expect(el).toHaveTextContent("Work");
		// dot is the first child span
		const dot = el.querySelector("span[aria-hidden='true']");
		expect(dot).not.toBeNull();
		expect(dot?.className).toMatch(/rounded-full/);
	});

	it("defaults to the ink variant", () => {
		render(<TagPin label="Default" />);
		const el = screen.getByTestId("tag-pin");
		expect(el).toHaveAttribute("data-variant", "ink");
	});

	it.each(VARIANTS)(
		"applies $variant text-color classes",
		({ variant, expected }) => {
			render(<TagPin label={`v-${variant}`} variant={variant} />);
			const el = screen.getByTestId("tag-pin");
			expect(el.className).toMatch(expected);
			expect(el).toHaveAttribute("data-variant", variant);
		},
	);
});
