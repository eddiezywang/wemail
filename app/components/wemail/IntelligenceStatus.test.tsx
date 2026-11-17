// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import IntelligenceStatus from "~/components/wemail/IntelligenceStatus";
import type { EmailIntelligenceState } from "~/types/wemail";

describe("IntelligenceStatus", () => {
	const fullPayload: EmailIntelligenceState = {
		emailId: "msg-1",
		summary: {
			status: "succeeded",
			result: {
				type: "summary",
				bullets: ["Test bullet"],
				actionItems: [],
				urgency: "low",
			},
		},
		tags: {
			status: "succeeded",
			result: {
				type: "tags",
				tags: [
					{ name: "question", confidence: 0.9, source: "ai", tier: "suggested" },
				],
			},
		},
		replyDecision: {
			status: "succeeded",
			result: {
				type: "replyDecision",
				shouldReply: true,
				reason: "Direct question",
				confidence: 0.95,
			},
		},
		replyDraft: {
			status: "succeeded",
			result: {
				type: "replyDraft",
				draftMarkdown: "Yes",
			},
		},
	};

	it("renders four status pills (summary, tags, replyDecision, replyDraft)", () => {
		render(<IntelligenceStatus payload={null} />);
		expect(screen.getByTestId("wemail-status-summary")).toBeInTheDocument();
		expect(screen.getByTestId("wemail-status-tags")).toBeInTheDocument();
		expect(screen.getByTestId("wemail-status-replyDecision")).toBeInTheDocument();
		expect(screen.getByTestId("wemail-status-replyDraft")).toBeInTheDocument();
	});

	it("shows skipped status when payload is null and not loading", () => {
		// `payload=null` without `loading` is the "no data, nothing in flight"
		// case — distinct from `loading=true` (covered by the next test).
		// `deriveStatus` returns "skipped" so the pill renders muted, not
		// the amber "Pending" treatment.
		render(<IntelligenceStatus payload={null} />);
		const summaryPill = screen.getByTestId("wemail-status-summary");
		expect(summaryPill.dataset.status).toBe("skipped");
	});

	it("shows pending status when loading is true", () => {
		render(<IntelligenceStatus payload={undefined} loading />);
		expect(screen.getByTestId("wemail-status-summary").dataset.status).toBe(
			"pending",
		);
	});

	it("shows failed status when error is present", () => {
		render(<IntelligenceStatus payload={null} error={new Error("boom")} />);
		expect(screen.getByTestId("wemail-status-summary").dataset.status).toBe(
			"failed",
		);
	});

	it("shows running status when payload exists but field is pending", () => {
		const partialPayload: EmailIntelligenceState = {
			emailId: "msg-1",
			summary: { status: "pending" },
			tags: { status: "pending" },
			replyDecision: { status: "pending" },
			replyDraft: { status: "pending" },
		};
		render(<IntelligenceStatus payload={partialPayload} />);
		expect(screen.getByTestId("wemail-status-summary").dataset.status).toBe(
			"pending",
		);
	});

	it("shows succeeded status when field is populated", () => {
		render(<IntelligenceStatus payload={fullPayload} />);
		expect(screen.getByTestId("wemail-status-summary").dataset.status).toBe(
			"succeeded",
		);
		expect(screen.getByTestId("wemail-status-tags").dataset.status).toBe(
			"succeeded",
		);
		expect(screen.getByTestId("wemail-status-replyDecision").dataset.status).toBe(
			"succeeded",
		);
		expect(screen.getByTestId("wemail-status-replyDraft").dataset.status).toBe(
			"succeeded",
		);
	});

	it("derives status independently per kind", () => {
		const partialPayload: EmailIntelligenceState = {
			emailId: "msg-1",
			summary: fullPayload.summary,
			tags: { status: "pending" },
			replyDecision: { status: "failed" },
			replyDraft: { status: "skipped" },
		};
		render(<IntelligenceStatus payload={partialPayload} />);
		expect(screen.getByTestId("wemail-status-summary").dataset.status).toBe(
			"succeeded",
		);
		expect(screen.getByTestId("wemail-status-tags").dataset.status).toBe(
			"pending",
		);
		expect(screen.getByTestId("wemail-status-replyDecision").dataset.status).toBe(
			"failed",
		);
		expect(screen.getByTestId("wemail-status-replyDraft").dataset.status).toBe(
			"skipped",
		);
	});

	it("maps replyDraft not-needed to succeeded display", () => {
		const noReplyPayload: EmailIntelligenceState = {
			emailId: "msg-1",
			summary: { status: "succeeded", result: fullPayload.summary.result },
			tags: { status: "succeeded", result: fullPayload.tags.result },
			replyDecision: {
				status: "succeeded",
				result: {
					type: "replyDecision",
					shouldReply: false,
					reason: "Newsletter — no reply needed",
					confidence: 0.98,
				},
			},
			replyDraft: { status: "not-needed" },
		};
		render(<IntelligenceStatus payload={noReplyPayload} />);
		expect(screen.getByTestId("wemail-status-replyDraft").dataset.status).toBe(
			"succeeded",
		);
	});
});
