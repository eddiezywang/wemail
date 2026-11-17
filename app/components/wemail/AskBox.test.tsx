// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AskBox } from "./AskBox";

function getTextarea() {
	return screen.getByTestId("ask-box-input") as HTMLTextAreaElement;
}

function getSubmit() {
	return screen.getByTestId("ask-box-submit") as HTMLButtonElement;
}

describe("AskBox", () => {
	it("exposes data-testid='ask-box' on the root", () => {
		render(<AskBox onSubmit={() => {}} />);
		expect(screen.getByTestId("ask-box")).toBeInTheDocument();
	});

	it("Enter during IME composition does NOT submit", () => {
		const onSubmit = vi.fn();
		render(<AskBox onSubmit={onSubmit} />);
		const textarea = getTextarea();
		fireEvent.change(textarea, { target: { value: "你好" } });
		fireEvent.compositionStart(textarea);
		fireEvent.keyDown(textarea, { key: "Enter" });
		expect(onSubmit).not.toHaveBeenCalled();
		// End composition without re-pressing Enter — still no submit.
		fireEvent.compositionEnd(textarea);
		expect(onSubmit).not.toHaveBeenCalled();
	});

	it("Enter after composition DOES submit", () => {
		const onSubmit = vi.fn();
		render(<AskBox onSubmit={onSubmit} />);
		const textarea = getTextarea();
		fireEvent.compositionStart(textarea);
		fireEvent.change(textarea, { target: { value: "hello" } });
		fireEvent.compositionEnd(textarea);
		act(() => {
			fireEvent.keyDown(textarea, { key: "Enter" });
		});
		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit).toHaveBeenCalledWith("hello");
	});

	it("Shift+Enter does NOT submit (allows newline)", async () => {
		const onSubmit = vi.fn();
		const user = userEvent.setup();
		render(<AskBox onSubmit={onSubmit} />);
		const textarea = getTextarea();
		await user.click(textarea);
		await user.type(textarea, "line1");
		fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });
		expect(onSubmit).not.toHaveBeenCalled();
		// Default behavior of Shift+Enter is not prevented; the value should be
		// unchanged because we only assert non-submission here. (Newline insert
		// is the browser's responsibility on a real <textarea>.)
		expect(textarea.value).toBe("line1");
	});

	it("loading state disables submit button", () => {
		render(<AskBox onSubmit={() => {}} loading />);
		expect(getSubmit()).toBeDisabled();
	});

	it("loading state prevents Enter submission", () => {
		const onSubmit = vi.fn();
		render(<AskBox onSubmit={onSubmit} loading />);
		const textarea = getTextarea();
		fireEvent.change(textarea, { target: { value: "queued" } });
		fireEvent.keyDown(textarea, { key: "Enter" });
		expect(onSubmit).not.toHaveBeenCalled();
	});

	it("submit payload includes the typed string verbatim", async () => {
		const onSubmit = vi.fn();
		const user = userEvent.setup();
		render(<AskBox onSubmit={onSubmit} />);
		const textarea = getTextarea();
		await user.click(textarea);
		await user.type(textarea, "  hello world  ");
		fireEvent.keyDown(textarea, { key: "Enter" });
		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit).toHaveBeenCalledWith("  hello world  ");
	});

	it("clicking submit button submits the typed string", async () => {
		const onSubmit = vi.fn();
		const user = userEvent.setup();
		render(<AskBox onSubmit={onSubmit} />);
		await user.type(getTextarea(), "hi there");
		await user.click(getSubmit());
		expect(onSubmit).toHaveBeenCalledWith("hi there");
	});

	it("does not submit empty / whitespace-only input", () => {
		const onSubmit = vi.fn();
		render(<AskBox onSubmit={onSubmit} />);
		const textarea = getTextarea();
		fireEvent.change(textarea, { target: { value: "   " } });
		fireEvent.keyDown(textarea, { key: "Enter" });
		expect(onSubmit).not.toHaveBeenCalled();
	});

	it("clears the input after a successful submit", async () => {
		const onSubmit = vi.fn();
		const user = userEvent.setup();
		render(<AskBox onSubmit={onSubmit} />);
		const textarea = getTextarea();
		await user.type(textarea, "hello");
		fireEvent.keyDown(textarea, { key: "Enter" });
		expect(textarea.value).toBe("");
	});

	it("renders the placeholder", () => {
		render(<AskBox onSubmit={() => {}} placeholder="ask the agent" />);
		expect(getTextarea().placeholder).toBe("ask the agent");
	});
});
