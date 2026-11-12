// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ReplyDraftVariant } from "~/types/wemail";
import QuickReplyChips from "./QuickReplyChips";

const variants: ReplyDraftVariant[] = [
	{ tone: "neutral", length: "medium", draftMarkdown: "收到，本周内确认明细后回复您。" },
	{ tone: "concise", length: "short", draftMarkdown: "收到，稍后回复。" },
	{ tone: "friendly", length: "medium", draftMarkdown: "您好，已收到，我尽快确认后回您～" },
];

describe("QuickReplyChips recommendation card", () => {
	it("shows the confidence meter when confidence is provided", () => {
		render(<QuickReplyChips variants={variants} confidence={0.82} onSelect={vi.fn()} />);

		expect(screen.getByLabelText("置信度 82%，较高")).toBeInTheDocument();
		expect(screen.getByText("回复建议")).toBeInTheDocument();
	});

	it("omits the confidence meter when no confidence is available", () => {
		render(<QuickReplyChips variants={variants} onSelect={vi.fn()} />);

		expect(screen.queryByLabelText(/置信度/)).not.toBeInTheDocument();
	});

	it("previews the first variant and switches on variant selection", () => {
		render(<QuickReplyChips variants={variants} onSelect={vi.fn()} />);

		expect(screen.getByText("收到，本周内确认明细后回复您。")).toBeInTheDocument();

		fireEvent.click(screen.getByRole("radio", { name: "回复方案：简短 · 短" }));
		expect(screen.getByText("收到，稍后回复。")).toBeInTheDocument();
	});

	it("sends the selected variant through onSelect on the primary action", () => {
		const onSelect = vi.fn();
		render(<QuickReplyChips variants={variants} onSelect={onSelect} />);

		fireEvent.click(screen.getByRole("radio", { name: "回复方案：友好 · 中" }));
		fireEvent.click(screen.getByTestId("wemail-quick-reply-accept"));

		expect(onSelect).toHaveBeenCalledWith(variants[2]);
	});

	it("dismisses the card without calling onSelect", () => {
		const onSelect = vi.fn();
		render(<QuickReplyChips variants={variants} onSelect={onSelect} />);

		fireEvent.click(screen.getByRole("button", { name: "不用了" }));

		expect(screen.queryByTestId("wemail-quick-reply-chips")).not.toBeInTheDocument();
		expect(onSelect).not.toHaveBeenCalled();
	});

	it("renders nothing without variants", () => {
		const { container } = render(<QuickReplyChips variants={[]} onSelect={vi.fn()} />);
		expect(container).toBeEmptyDOMElement();
	});
});
