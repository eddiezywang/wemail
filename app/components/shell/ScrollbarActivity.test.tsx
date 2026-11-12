// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ScrollbarActivity from "./ScrollbarActivity";

afterEach(() => {
	vi.useRealTimers();
});

describe("ScrollbarActivity", () => {
	it("shows a scrollbar during wheel scrolling and lets it settle after inactivity", () => {
		vi.useFakeTimers();
		render(
			<>
				<ScrollbarActivity />
				<div data-testid="scroller" />
			</>,
		);
		const scroller = screen.getByTestId("scroller");

		Object.defineProperty(scroller, "clientHeight", { value: 100 });
		Object.defineProperty(scroller, "scrollHeight", { value: 400 });
		scroller.style.overflowY = "auto";
		fireEvent.wheel(scroller, { deltaY: 80 });
		expect(scroller).toHaveAttribute("data-scrollbar-active", "true");

		act(() => vi.advanceTimersByTime(800));
		expect(scroller).not.toHaveAttribute("data-scrollbar-active");
	});

	it("reveals the actual scrolling element without depending on pointer position", () => {
		render(
			<>
				<ScrollbarActivity />
				<div data-testid="scroller" />
			</>,
		);
		const scroller = screen.getByTestId("scroller");
		Object.defineProperty(scroller, "clientHeight", { value: 100 });
		Object.defineProperty(scroller, "scrollHeight", { value: 400 });
		scroller.style.overflowY = "auto";
		scroller.scrollTop = 120;

		fireEvent.scroll(scroller);

		expect(scroller).toHaveAttribute("data-scrollbar-active", "true");
	});

	it("shows the nearest scrollable ancestor as soon as the wheel moves", () => {
		render(
			<>
				<ScrollbarActivity />
				<div data-testid="scroller" style={{ overflowY: "auto" }}>
					<div data-testid="content" />
				</div>
			</>,
		);
		const scroller = screen.getByTestId("scroller");
		Object.defineProperty(scroller, "clientHeight", { value: 100 });
		Object.defineProperty(scroller, "scrollHeight", { value: 400 });

		fireEvent.wheel(screen.getByTestId("content"), { deltaY: 80 });

		expect(scroller).toHaveAttribute("data-scrollbar-active", "true");
	});
});
