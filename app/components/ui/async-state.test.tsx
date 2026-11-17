// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import "@testing-library/jest-dom/vitest";
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AsyncState } from "./async-state";

describe("AsyncState delayed (S1)", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("renders nothing before 300ms when delayed", () => {
		const { container } = render(<AsyncState kind="loading" title="正在加载" delayed />);
		act(() => {
			vi.advanceTimersByTime(299);
		});
		expect(container).toBeEmptyDOMElement();
	});

	it("shows the loading state after 300ms", () => {
		const { container } = render(<AsyncState kind="loading" title="正在加载" delayed />);
		act(() => {
			vi.advanceTimersByTime(300);
		});
		expect(container.querySelector("h3")?.textContent).toBe("正在加载");
	});

	it("swaps immediately once the kind leaves loading", () => {
		const { container, rerender } = render(
			<AsyncState kind="loading" title="正在加载" delayed />,
		);
		act(() => {
			vi.advanceTimersByTime(300);
		});
		rerender(<AsyncState kind="empty" title="没有内容" delayed />);
		act(() => {
			vi.advanceTimersByTime(0);
		});
		expect(container.querySelector("h3")?.textContent).toBe("没有内容");
	});

	it("is immediate by default (existing surfaces keep behaviour)", () => {
		const { getByText } = render(<AsyncState kind="loading" title="正在加载" />);
		expect(getByText("正在加载")).toBeInTheDocument();
	});
});
