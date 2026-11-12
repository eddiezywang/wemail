// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MailItem } from "./MailItem";

const baseProps = {
	id: "msg-1",
	sender: "Alice",
	subject: "Q3 plan",
	snippet: "Here is the rough outline for the…",
	date: "Apr 25",
};

describe("MailItem", () => {
	it("renders sender, subject and date without exposing body text", () => {
		render(<MailItem {...baseProps} />);
		const row = screen.getByTestId("mail-item");
		expect(row).toHaveTextContent("Alice");
		expect(row).toHaveTextContent("Q3 plan");
		expect(row).not.toHaveTextContent("Here is the rough outline");
		expect(row).toHaveTextContent("Apr 25");
		expect(row).toHaveAttribute("data-selected", "false");
	});

	it("marks the row whose detail is open as selected", () => {
		render(<MailItem {...baseProps} selected />);
		const row = screen.getByTestId("mail-item");
		expect(row).toHaveAttribute("data-selected", "true");
	});

	it("exposes data-testid='mail-item' and forwards id", () => {
		render(<MailItem {...baseProps} />);
		const row = screen.getByTestId("mail-item");
		expect(row).toHaveAttribute("data-id", "msg-1");
	});

	it("applies virtual positioning to the interactive row", () => {
		render(
			<MailItem
				{...baseProps}
				className="absolute left-0 right-0"
				style={{ top: 148, height: 104 }}
			/>,
		);
		const row = screen.getByTestId("mail-item");
		expect(row).toHaveClass("absolute", "left-0", "right-0");
		expect(row).toHaveStyle({ top: "148px", height: "104px" });
	});

	it("shows unread indicator when unread is true", () => {
		render(<MailItem {...baseProps} unread />);
		const dot = screen.getByTestId("mail-item-unread");
		expect(dot.className).toMatch(/bg-coral/);
		expect(screen.getByTestId("mail-item")).toHaveAttribute(
			"data-unread",
			"true",
		);
	});

	it("hides unread indicator when unread is false", () => {
		render(<MailItem {...baseProps} unread={false} />);
		const dot = screen.getByTestId("mail-item-unread");
		expect(dot.className).toMatch(/bg-transparent/);
		expect(dot).toHaveClass("h-0", "w-0");
	});

	it("does not render a snippet line", () => {
		render(<MailItem {...baseProps} snippet="" />);
		expect(screen.getByTestId("mail-item")).not.toHaveTextContent(
			"Here is the rough outline",
		);
	});

	it("renders attachment marker when hasAttachment is true", () => {
		render(<MailItem {...baseProps} hasAttachment />);
		// Signals render in both the compact and expanded row layouts; the CSS
		// `data-detail-open` container toggles which one is visible.
		expect(screen.getAllByTestId("mail-item-attachment")).toHaveLength(2);
	});

	it("omits attachment marker when hasAttachment is false", () => {
		render(<MailItem {...baseProps} />);
		expect(screen.queryByTestId("mail-item-attachment")).toBeNull();
	});

	it("renders AI badge when aiStatus is provided (non-none)", () => {
		render(<MailItem {...baseProps} aiStatus="summarized" />);
		const badges = screen.getAllByTestId("mail-item-ai-status");
		expect(badges).toHaveLength(2);
		expect(badges[0]).toHaveAttribute("data-status", "summarized");
		expect(badges[0]).toHaveTextContent("AI");
	});

	it("omits AI badge when aiStatus is 'none'", () => {
		render(<MailItem {...baseProps} aiStatus="none" />);
		expect(screen.queryByTestId("mail-item-ai-status")).toBeNull();
	});

	it("renders tag chips", () => {
		render(
			<MailItem
				{...baseProps}
				tags={[
					{ label: "work", variant: "blue" },
					{ label: "urgent", variant: "coral" },
				]}
			/>,
		);
		// Two layouts, each rendering the same chips (see attachment marker test).
		const tags = screen.getAllByTestId("tag-pin");
		expect(tags).toHaveLength(4);
		expect(tags[0]).toHaveTextContent("work");
		expect(tags[1]).toHaveTextContent("urgent");
		const tagRow = screen.getAllByTestId("mail-item-tags")[0];
		expect(tagRow).not.toHaveClass("flex-wrap");
		expect(tagRow).toHaveClass("overflow-hidden", "whitespace-nowrap");
	});

	it("invokes onClick with id when clicked", async () => {
		const user = userEvent.setup();
		const onClick = vi.fn();
		render(<MailItem {...baseProps} onClick={onClick} />);
		await user.click(screen.getByTestId("mail-item"));
		expect(onClick).toHaveBeenCalledWith("msg-1");
	});
});
