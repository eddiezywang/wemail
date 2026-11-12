// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { Trace, type TraceEntry } from "./Trace";

describe("Trace", () => {
	it("exposes data-testid='trace' on the root", () => {
		render(<Trace entries={[]} />);
		expect(screen.getByTestId("trace")).toBeInTheDocument();
	});

	it("renders command rows with leading '$ ' prefix", () => {
		const entries: TraceEntry[] = [
			{ kind: "command", text: "git status" },
		];
		render(<Trace entries={entries} />);
		const root = screen.getByTestId("trace");
		expect(root.textContent ?? "").toContain("$ git status");
	});

	it("renders status rows with timestamps in [HH:MM:SS] form", () => {
		const ts = new Date("2026-04-25T12:34:56Z");
		const entries: TraceEntry[] = [
			{ kind: "status", text: "running", timestamp: ts },
		];
		render(<Trace entries={entries} />);
		const root = screen.getByTestId("trace");
		// Match [HH:MM:SS] regardless of locale's timezone offset.
		expect(root.textContent ?? "").toMatch(/\[\d{2}:\d{2}:\d{2}\]/);
		expect(root.textContent ?? "").toContain("running");
	});

	it("accepts a string timestamp verbatim", () => {
		const entries: TraceEntry[] = [
			{ kind: "status", text: "queued", timestamp: "12:34:56" },
		];
		render(<Trace entries={entries} />);
		expect(screen.getByTestId("trace").textContent ?? "").toContain(
			"[12:34:56]",
		);
	});

	it("tints failure rows (red/amber class or data-status='failed')", () => {
		const entries: TraceEntry[] = [
			{ kind: "error", text: "boom" },
		];
		const { container } = render(<Trace entries={entries} />);
		const failedRow = container.querySelector('[data-status="failed"]');
		expect(failedRow).not.toBeNull();
		expect(failedRow!.className).toMatch(/text-(red|amber)/);
	});

	it("wraps long lines with whitespace-pre-wrap or break-words", () => {
		const entries: TraceEntry[] = [
			{ kind: "output", text: "x".repeat(400) },
		];
		const { container } = render(<Trace entries={entries} />);
		const row = within(container).getByText(/x{400}/);
		expect(row.className).toMatch(/whitespace-pre-wrap|break-words/);
	});

	it("renders multiple entries in order", () => {
		const entries: TraceEntry[] = [
			{ kind: "command", text: "ls" },
			{ kind: "output", text: "a.txt" },
			{ kind: "status", text: "ok", timestamp: "00:00:01" },
		];
		render(<Trace entries={entries} />);
		const text = screen.getByTestId("trace").textContent ?? "";
		expect(text.indexOf("$ ls")).toBeLessThan(text.indexOf("a.txt"));
		expect(text.indexOf("a.txt")).toBeLessThan(text.indexOf("ok"));
	});
});
