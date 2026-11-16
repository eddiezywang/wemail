// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Button } from "./button";

describe("Button loading", () => {
	it("keeps the label in place and stays keyboard-reachable while busy", () => {
		const onClick = vi.fn();
		render(
			<Button loading onClick={onClick}>
				保存
			</Button>,
		);
		const button = screen.getByRole("button", { name: "保存" });
		// Busy buttons are announced via aria-disabled + aria-busy, not the
		// disabled attribute, so they stay focusable and keyboard-reachable.
		expect(button).not.toBeDisabled();
		expect(button).toHaveAttribute("aria-disabled", "true");
		expect(button).toHaveAttribute("aria-busy", "true");
		// Label keeps its box (opacity-only) — no layout shift.
		expect(screen.getByText("保存")).toBeInTheDocument();
		// Clicks are swallowed while busy.
		fireEvent.click(button);
		expect(onClick).not.toHaveBeenCalled();
	});

	it("passes clicks through when not busy", () => {
		const onClick = vi.fn();
		render(
			<Button onClick={onClick}>保存</Button>,
		);
		fireEvent.click(screen.getByRole("button", { name: "保存" }));
		expect(onClick).toHaveBeenCalledTimes(1);
	});

	it("still honours an explicit disabled", () => {
		render(
			<Button disabled loading>
				保存
			</Button>,
		);
		expect(screen.getByRole("button", { name: "保存" })).toBeDisabled();
	});
});
