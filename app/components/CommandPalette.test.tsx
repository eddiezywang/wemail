// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CommandPalette from "./CommandPalette";
import { useUIStore } from "~/hooks/useUIStore";
import {
	_clearAllCommandsForTesting,
	registerCommand,
} from "~/lib/commandPalette";

describe("CommandPalette", () => {
	beforeEach(() => {
		_clearAllCommandsForTesting();
		Element.prototype.scrollIntoView = vi.fn();
		useUIStore.setState({ isCommandPaletteOpen: true });
	});

	afterEach(() => {
		_clearAllCommandsForTesting();
		useUIStore.setState({ isCommandPaletteOpen: false });
	});

	it("runs the command for the clicked row", async () => {
		const first = vi.fn();
		const second = vi.fn();
		registerCommand({
			id: "test.first",
			title: "First command",
			section: "Test",
			handler: first,
		});
		registerCommand({
			id: "test.second",
			title: "Second command",
			section: "Test",
			handler: second,
		});

		render(<CommandPalette />);

		act(() => {
			fireEvent.click(screen.getByRole("option", { name: "Second command" }));
		});

		await waitFor(() => expect(second).toHaveBeenCalledTimes(1));
		expect(first).not.toHaveBeenCalled();
	});

	it("highlights direct substring matches in coral", () => {
		registerCommand({
			id: "test.search",
			title: "搜索邮件",
			section: "Test",
			handler: vi.fn(),
		});

		render(<CommandPalette />);
		fireEvent.change(screen.getByTestId("command-palette-input"), {
			target: { value: "邮件" },
		});

		const mark = document.querySelector("mark");
		expect(mark).not.toBeNull();
		expect(mark).toHaveTextContent("邮件");
	});

	it("shows a rich empty state whose suggestions run real commands", async () => {
		const handler = vi.fn();
		registerCommand({
			id: "test.search",
			title: "搜索邮件",
			section: "Test",
			handler,
		});

		render(<CommandPalette />);
		fireEvent.change(screen.getByTestId("command-palette-input"), {
			target: { value: "zzz不存在" },
		});

		const empty = screen.getByTestId("command-palette-empty");
		expect(empty).toHaveTextContent("试试这些");
		const suggestion = within(empty).getAllByRole("button")[0];
		expect(suggestion).toHaveTextContent("搜索邮件");

		await act(async () => {
			fireEvent.click(suggestion);
		});
		await waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
	});
});
