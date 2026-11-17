// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SaveStatus } from "./save-status";

describe("SaveStatus", () => {
	it("shows a quiet 保存中… while saving", () => {
		render(<SaveStatus state="saving" />);
		const status = screen.getByRole("status");
		expect(status).toHaveTextContent("保存中…");
		expect(status).toHaveAttribute("aria-live", "polite");
	});

	it("shows 已保存 with a green check when saved", () => {
		render(<SaveStatus state="saved" />);
		expect(screen.getByRole("status")).toHaveTextContent("已保存");
	});

	it("swaps to an inline reason with Retry on failure", () => {
		const onRetry = vi.fn();
		render(<SaveStatus state="error" error={new Error("network down")} onRetry={onRetry} />);
		const alert = screen.getByRole("alert");
		expect(alert).toHaveTextContent("暂时无法连接服务，请检查网络后重试。");
		fireEvent.click(screen.getByRole("button", { name: "重试" }));
		expect(onRetry).toHaveBeenCalledTimes(1);
	});

	it("uses the fallback copy for opaque errors", () => {
		render(<SaveStatus state="error" fallback="保存失败，请重试。" />);
		expect(screen.getByRole("alert")).toHaveTextContent("保存失败，请重试。");
	});
});
