// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import EmailSummaryCard from "./EmailSummaryCard";
import type { SummaryResult } from "~/types/wemail";

const successSummary: SummaryResult = {
	type: "summary",
	bullets: ["Alpha bullet", "Beta bullet"],
	actionItems: ["Reply to Alice"],
	urgency: "high",
};

describe("EmailSummaryCard", () => {
	it("renders pending state via AICard when status is pending", () => {
		// Stone-floating overhaul: pending/running collapse the body by default
		// and rely on AICard's `data-state="pending"` + `aria-busy` for the
		// visual treatment. The skeleton inside `wemail-summary-pending` only
		// renders after the user expands the card.
		render(<EmailSummaryCard status="pending" />);
		const card = screen.getByTestId("wemail-summary-card");
		expect(card.dataset.state).toBe("pending");
		expect(card).toHaveAttribute("aria-busy", "true");
		expect(screen.queryByTestId("wemail-urgency-pill")).toBeNull();
	});

	it("renders running as pending via AICard when status is running", () => {
		// `running` maps to AICard state "pending" through `toAICardState`.
		render(<EmailSummaryCard status="running" />);
		const card = screen.getByTestId("wemail-summary-card");
		expect(card.dataset.state).toBe("pending");
		expect(screen.queryByTestId("wemail-urgency-pill")).toBeNull();
	});

	it("renders bullets, action items, and urgency pill on succeeded", () => {
		render(<EmailSummaryCard status="succeeded" summary={successSummary} />);
		expect(screen.getByTestId("wemail-summary-success")).toBeInTheDocument();
		expect(screen.getByText("Alpha bullet")).toBeInTheDocument();
		expect(screen.getByText("Beta bullet")).toBeInTheDocument();
		expect(screen.getByText("Reply to Alice")).toBeInTheDocument();
		const pill = screen.getByTestId("wemail-urgency-pill");
		expect(pill).toBeInTheDocument();
		expect(pill.textContent).toMatch(/高|High/);
	});

	it("renders failure copy and invokes onRetry when provided", async () => {
		// Stone-floating overhaul: AICard owns the failed-state copy and
		// intentionally surfaces only generic text ("Couldn't generate —
		// please retry"), not the raw `errorMessage`, per the
		// frontend-intelligence-ui rule. The retry button still flows in
		// through AICard's `actions` slot, which is rendered regardless of
		// state.
		const user = userEvent.setup();
		const onRetry = vi.fn();
		render(
			<EmailSummaryCard
				status="failed"
				errorMessage="network down"
				canRetry
				onRetry={onRetry}
			/>,
		);
		expect(screen.getByTestId("ai-card-failed")).toBeInTheDocument();
		expect(screen.queryByText(/network down/)).toBeNull();
		await user.click(screen.getByTestId("wemail-summary-retry"));
		expect(onRetry).toHaveBeenCalledTimes(1);
	});

	it("does not show retry button when canRetry is false", () => {
		render(<EmailSummaryCard status="failed" canRetry={false} />);
		expect(screen.getByTestId("ai-card-failed")).toBeInTheDocument();
		expect(screen.queryByTestId("wemail-summary-retry")).toBeNull();
	});

	it("renders skipped message when expanded", async () => {
		// Skipped collapses by default (covered by the "defaults to collapsed"
		// test below); the skipped copy is only rendered after the user
		// expands the card via the toggle.
		const user = userEvent.setup();
		render(<EmailSummaryCard status="skipped" errorMessage="LLM not configured" />);
		expect(screen.queryByTestId("wemail-summary-skipped")).toBeNull();
		await user.click(screen.getByTestId("wemail-summary-toggle"));
		expect(screen.getByTestId("wemail-summary-skipped")).toBeInTheDocument();
		expect(screen.getByText(/LLM not configured/)).toBeInTheDocument();
	});

	it("is collapsible via toggle button", async () => {
		const user = userEvent.setup();
		render(<EmailSummaryCard status="succeeded" summary={successSummary} />);
		expect(screen.getByTestId("wemail-summary-content")).toBeInTheDocument();
		await user.click(screen.getByTestId("wemail-summary-toggle"));
		expect(screen.queryByTestId("wemail-summary-content")).toBeNull();
		await user.click(screen.getByTestId("wemail-summary-toggle"));
		expect(screen.getByTestId("wemail-summary-content")).toBeInTheDocument();
	});

	it("defaults to collapsed for skipped status", () => {
		render(<EmailSummaryCard status="skipped" />);
		expect(screen.queryByTestId("wemail-summary-content")).toBeNull();
	});

	it("defaults to expanded for succeeded status", () => {
		render(<EmailSummaryCard status="succeeded" summary={successSummary} />);
		expect(screen.getByTestId("wemail-summary-content")).toBeInTheDocument();
	});

	it("renders the AICard failed treatment for failed status", () => {
		// In the stone-floating design AICard owns the failed-state UI; the
		// EmailSummaryCard children are intentionally suppressed
		// (`showBody = state !== "failed"`), so `wemail-summary-content` is
		// not present. The visible failed treatment is `ai-card-failed`.
		render(<EmailSummaryCard status="failed" />);
		expect(screen.queryByTestId("wemail-summary-content")).toBeNull();
		expect(screen.getByTestId("ai-card-failed")).toBeInTheDocument();
	});
});
