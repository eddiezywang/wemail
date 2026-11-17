// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import SmartDraftPanel from "./SmartDraftPanel";
import type { ReplyDecisionResult, ReplyDraftResult } from "~/types/wemail";

const skipDecision: ReplyDecisionResult = {
	type: "replyDecision",
	shouldReply: false,
	reason: "This is a broadcast — no reply expected.",
	confidence: 0.95,
};

const readyDecision: ReplyDecisionResult = {
	type: "replyDecision",
	shouldReply: true,
	reason: "Alice asked a direct question.",
	confidence: 0.95,
};

const readyDraft: ReplyDraftResult = {
	type: "replyDraft",
	draftMarkdown: "Hi Alice,\n\nThanks for reaching out.\n\n— Me",
};

describe("SmartDraftPanel", () => {
	it("renders nothing when status is not-needed", () => {
		const { container } = render(
			<SmartDraftPanel
				emailId="e1"
				status="not-needed"
				replyDecision={skipDecision}
			/>,
		);
		expect(container.firstChild).toBeNull();
	});

	it("renders textarea and Accept / Edit&Send / Delete when status is succeeded", () => {
		render(
			<SmartDraftPanel
				emailId="e1"
				status="succeeded"
				replyDraft={readyDraft}
				replyDecision={readyDecision}
			/>,
		);
		expect(screen.getByTestId("wemail-draft-ready")).toBeInTheDocument();
		expect(
			(screen.getByTestId("wemail-draft-textarea") as HTMLTextAreaElement)
				.value,
		).toContain("Hi Alice");
		expect(screen.getByTestId("wemail-draft-accept")).toBeInTheDocument();
		expect(screen.getByTestId("wemail-draft-edit-send")).toBeInTheDocument();
		expect(screen.getByTestId("wemail-draft-delete")).toBeInTheDocument();
	});

	it("fires onEditAndSend with the textarea contents and does NOT send directly", async () => {
		const user = userEvent.setup();
		const onEditAndSend = vi.fn();
		const onAccept = vi.fn();
		const onDelete = vi.fn();
		render(
			<SmartDraftPanel
				emailId="e1"
				status="succeeded"
				replyDraft={readyDraft}
				replyDecision={readyDecision}
				onAccept={onAccept}
				onDelete={onDelete}
				onEditAndSend={onEditAndSend}
			/>,
		);
		await user.click(screen.getByTestId("wemail-draft-edit-send"));
		expect(onEditAndSend).toHaveBeenCalledTimes(1);
		expect(onEditAndSend.mock.calls[0][0]).toContain("Hi Alice");
		// The panel itself never sends — that's delegated to the parent.
		expect(onAccept).not.toHaveBeenCalled();
		expect(onDelete).not.toHaveBeenCalled();
	});

	it("fires onGeneratedOnce exactly once when a draft becomes available", () => {
		const onGeneratedOnce = vi.fn();
		render(
			<SmartDraftPanel
				emailId="e1"
				status="succeeded"
				replyDraft={readyDraft}
				replyDecision={readyDecision}
				onGeneratedOnce={onGeneratedOnce}
			/>,
		);
		expect(onGeneratedOnce).toHaveBeenCalledTimes(1);
		expect(onGeneratedOnce.mock.calls[0][0]).toContain("Hi Alice");
	});

	it("renders skeleton when status is pending", () => {
		render(<SmartDraftPanel emailId="e1" status="pending" />);
		expect(screen.getByTestId("wemail-draft-pending")).toBeInTheDocument();
	});

	it("renders skeleton when status is running", () => {
		render(<SmartDraftPanel emailId="e1" status="running" />);
		expect(screen.getByTestId("wemail-draft-pending")).toBeInTheDocument();
	});

	it("renders nothing when status is failed", () => {
		const { container } = render(
			<SmartDraftPanel emailId="e1" status="failed" />,
		);
		expect(container.firstChild).toBeNull();
	});

	it("renders nothing when status is skipped", () => {
		const { container } = render(
			<SmartDraftPanel emailId="e1" status="skipped" />,
		);
		expect(container.firstChild).toBeNull();
	});

	it("renders empty state when succeeded but no draft", () => {
		render(
			<SmartDraftPanel
				emailId="e1"
				status="succeeded"
				replyDraft={null}
			/>,
		);
		expect(screen.getByTestId("wemail-draft-empty")).toBeInTheDocument();
	});
});
