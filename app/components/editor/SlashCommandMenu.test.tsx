// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Renderer tests for the slash command palette UI.
 *
 * The menu is a controlled view over the catalogue + filter helpers;
 * here we drive it with synthetic props to verify:
 *
 *   - it renders each visible group with its heading
 *   - typing narrows the list (via the `query` prop)
 *   - clicking an item invokes `onSelect` with the right command
 *   - the imperative API (move / commitSelected) wraps + commits
 *   - the empty-state placeholder shows when nothing matches
 *
 * We also exercise the editor-level wiring in
 * `RichTextEditor.test.tsx` (kept light because jsdom can't run the
 * suggestion plugin's `coordsAtPos`).
 */

import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import {
	SlashCommandMenu,
	type SlashMenuApi,
} from "./SlashCommandMenu";
import type { SlashCommand } from "./slashCommands";

function Harness({
	query,
	onSelect,
	apiRef,
}: {
	query: string;
	onSelect?: (cmd: SlashCommand) => void;
	apiRef?: React.MutableRefObject<SlashMenuApi | null>;
}) {
	const fallbackRef = useRef<SlashMenuApi | null>(null);
	return (
		<div style={{ position: "relative" }}>
			<SlashCommandMenu
				open
				query={query}
				anchor={{ top: 0, left: 0 }}
				onSelect={onSelect ?? (() => {})}
				onClose={() => {}}
				apiRef={apiRef ?? fallbackRef}
			/>
		</div>
	);
}

describe("SlashCommandMenu", () => {
	it("renders all three groups when the query is empty", () => {
		render(<Harness query="" />);
		const menu = screen.getByTestId("slash-menu");
		expect(menu).toBeInTheDocument();
		expect(menu.textContent).toContain("模板");
		expect(menu.textContent).toContain("AI");
		expect(menu.textContent).toContain("插入");
	});

	it("narrows when query is typed (filters by title / keywords)", () => {
		const { rerender } = render(<Harness query="" />);
		const menu = screen.getByTestId("slash-menu");
		expect(menu.textContent).toContain("润色");
		expect(menu.textContent).toContain("问候");

		rerender(<Harness query="润" />);
		const narrowed = screen.getByTestId("slash-menu");
		expect(narrowed.textContent).toContain("润色");
		// The greeting template should drop out.
		expect(narrowed.textContent).not.toContain("问候");
	});

	it("invokes onSelect with the clicked command", () => {
		const onSelect = vi.fn();
		render(<Harness query="" onSelect={onSelect} />);
		const greeting = screen.getByTestId("slash-item-tpl-greeting");
		fireEvent.click(greeting);
		expect(onSelect).toHaveBeenCalledWith(
			expect.objectContaining({ id: "tpl-greeting" }),
		);
	});

	it("shows an empty placeholder when nothing matches", () => {
		render(<Harness query="zzzzzz-no-such-cmd" />);
		const menu = screen.getByTestId("slash-menu");
		expect(menu.getAttribute("data-empty")).toBe("true");
		expect(menu.textContent).toContain("没有匹配的命令");
	});

	it("exposes a working imperative move/commit API", () => {
		const apiRef: React.MutableRefObject<SlashMenuApi | null> = { current: null };
		const onSelect = vi.fn();
		render(<Harness query="" onSelect={onSelect} apiRef={apiRef} />);
		expect(apiRef.current).not.toBeNull();
		// Move past the first item, then commit.
		act(() => {
			apiRef.current!.move(2);
		});
		act(() => {
			expect(apiRef.current!.commitSelected()).toBe(true);
		});
		expect(onSelect).toHaveBeenCalled();
	});
});
