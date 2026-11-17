// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ErrorSlot } from "./error-slot";

describe("ErrorSlot", () => {
	it("renders the mapped reason and announces it assertively", () => {
		render(<ErrorSlot error={new Error("fetch failed")} />);
		const alert = screen.getByRole("alert");
		expect(alert).toHaveTextContent("暂时无法连接服务，请检查网络后重试。");
	});

	it("falls back to the provided copy for opaque errors", () => {
		render(<ErrorSlot fallback="操作没有完成，请稍后重试。" />);
		expect(screen.getByRole("alert")).toHaveTextContent("操作没有完成，请稍后重试。");
	});

	it("renders no retry when none is provided", () => {
		render(<ErrorSlot fallback="失败" />);
		expect(screen.queryByRole("button", { name: "重试" })).not.toBeInTheDocument();
	});

	it("retries on click and disables while the retry is pending", () => {
		const onRetry = vi.fn();
		const { rerender } = render(<ErrorSlot onRetry={onRetry} />);
		fireEvent.click(screen.getByRole("button", { name: "重试" }));
		expect(onRetry).toHaveBeenCalledTimes(1);

		rerender(<ErrorSlot onRetry={onRetry} retryPending />);
		expect(screen.getByRole("button", { name: "重试" })).toBeDisabled();
	});
});
