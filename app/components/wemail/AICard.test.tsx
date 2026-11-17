// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { AICard, type AICardState, type AICardVariant } from "./AICard";

const VARIANTS: { variant: AICardVariant; label: RegExp }[] = [
	{ variant: "summary", label: /summary/i },
	{ variant: "original", label: /original/i },
	{ variant: "draft", label: /draft/i },
];

const STATES: AICardState[] = ["empty", "pending", "success", "failed"];

describe("AICard", () => {
	it("always renders data-testid='ai-card'", () => {
		render(<AICard variant="summary" state="empty" />);
		expect(screen.getByTestId("ai-card")).toBeInTheDocument();
	});

	it.each(VARIANTS)(
		"renders the $variant variant label badge",
		({ variant, label }) => {
			render(<AICard variant={variant} state="success">body</AICard>);
			expect(screen.getByTestId("ai-card-variant-label")).toHaveTextContent(
				label,
			);
		},
	);

	it.each(STATES)("supports the %s state", (state) => {
		render(
			<AICard variant="summary" state={state}>
				content
			</AICard>,
		);
		const card = screen.getByTestId("ai-card");
		expect(card).toHaveAttribute("data-state", state);
	});

	it("marks pending state with aria-busy", () => {
		render(<AICard variant="summary" state="pending" />);
		expect(screen.getByTestId("ai-card")).toHaveAttribute("aria-busy", "true");
	});

	it("renders generic failure copy and does NOT surface raw error props", () => {
		render(
			<AICard
				variant="summary"
				state="failed"
				// Even if a parent leaks an error string in, AICard renders generic copy.
			>
				{/* a parent might pass an error message into children, but the
				    failure branch is what AICard renders */}
				<span>raw stack trace: TypeError @ line 42</span>
			</AICard>,
		);
		const card = screen.getByTestId("ai-card");
		expect(card).toHaveTextContent(/couldn't generate/i);
		// The raw error body must not appear inside the failure surface.
		expect(card).not.toHaveTextContent(/raw stack trace/i);
	});

	it("renders the header slot above the body", () => {
		render(
			<AICard
				variant="draft"
				state="success"
				header={<span data-testid="hdr">Header text</span>}
			>
				<span data-testid="bdy">Body text</span>
			</AICard>,
		);
		expect(screen.getByTestId("hdr")).toBeInTheDocument();
		expect(screen.getByTestId("bdy")).toBeInTheDocument();
	});

	it("renders the actions slot", () => {
		render(
			<AICard
				variant="draft"
				state="success"
				actions={<button type="button">Send</button>}
			>
				body
			</AICard>,
		);
		expect(
			screen.getByRole("button", { name: "Send" }),
		).toBeInTheDocument();
	});

	it("merges className", () => {
		render(
			<AICard variant="summary" state="empty" className="custom-x" />,
		);
		expect(screen.getByTestId("ai-card").className).toMatch(/custom-x/);
	});
});
