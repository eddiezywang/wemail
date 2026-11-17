// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { NavLink } from "./NavLink";

function renderAt(initialPath: string, ui: React.ReactNode) {
	return render(
		<MemoryRouter initialEntries={[initialPath]}>{ui}</MemoryRouter>,
	);
}

describe("NavLink", () => {
	it("renders label and exposes data-testid='nav-link'", () => {
		renderAt("/other", <NavLink to="/inbox" label="Inbox" />);
		const el = screen.getByTestId("nav-link");
		expect(el).toBeInTheDocument();
		expect(el).toHaveTextContent("Inbox");
	});

	it("omits count when not provided", () => {
		renderAt("/other", <NavLink to="/inbox" label="Inbox" />);
		const el = screen.getByTestId("nav-link");
		// only the label
		expect(el.textContent).toBe("Inbox");
	});

	it("renders count as '{count}' when count > 0", () => {
		renderAt("/other", <NavLink to="/inbox" label="Inbox" count={7} />);
		expect(screen.getByTestId("nav-link")).toHaveTextContent("7");
	});

	it("renders count as '{count}+' when atLimit is true", () => {
		renderAt(
			"/other",
			<NavLink to="/inbox" label="Inbox" count={500} atLimit />,
		);
		expect(screen.getByTestId("nav-link")).toHaveTextContent("500+");
	});

	it("does not render count chip when count is 0", () => {
		renderAt("/other", <NavLink to="/inbox" label="Inbox" count={0} />);
		const el = screen.getByTestId("nav-link");
		expect(el.textContent).toBe("Inbox");
	});

	it("applies active classes when route matches", () => {
		renderAt("/inbox", <NavLink to="/inbox" label="Inbox" />);
		const el = screen.getByTestId("nav-link");
		// Active row keeps the sidebar surface and uses the coral foreground.
		expect(el.className).not.toMatch(/bg-paper-4/);
		expect(el.className).toMatch(/text-coral/);
		expect(el.className).not.toMatch(/text-\[#1683ff\]/);
		expect(el.className).not.toMatch(/shadow-\[/);
		expect(el.className).not.toMatch(/inset_3px/);
	});

	it("applies inactive classes when route does not match", () => {
		renderAt("/elsewhere", <NavLink to="/inbox" label="Inbox" />);
		const el = screen.getByTestId("nav-link");
		expect(el.className).toMatch(/text-ink-3/);
  expect(el.className).toMatch(/hover:bg-paper-3\/70/);
	});

	it("forwards data-folder for e2e selection", () => {
		renderAt(
			"/other",
			<NavLink to="/folder/Work" label="Work" data-folder="Work" />,
		);
		expect(screen.getByTestId("nav-link")).toHaveAttribute(
			"data-folder",
			"Work",
		);
	});
});
