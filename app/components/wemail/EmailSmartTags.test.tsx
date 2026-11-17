// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import EmailSmartTags from "./EmailSmartTags";
import type { TagResult } from "~/types/wemail";

vi.mock("./CreateSmartTagDialog", () => ({
	CreateSmartTagDialog: ({
		open,
		candidateSource,
	}: {
		open: boolean;
		candidateSource?: { candidate: { name: string } };
	}) => open ? (
		<div data-testid="promotion-dialog-stub">{candidateSource?.candidate.name}</div>
	) : null,
}));

const tags: TagResult = {
	type: "tags",
	tags: [
		{ name: "question", confidence: 0.9, source: "ai", tier: "suggested" },
		{ name: "notification", confidence: 0.6, source: "ai", tier: "auto" },
	],
};

describe("EmailSmartTags", () => {
	it("renders the empty-state label when no tags are present", () => {
		render(<EmailSmartTags status="succeeded" tags={null} />);
		expect(screen.getByTestId("wemail-tags-empty")).toBeInTheDocument();
	});

	it("renders nothing while tags are pending", () => {
		const { container } = render(<EmailSmartTags status="pending" tags={null} />);
		expect(container.firstChild).toBeNull();
	});

	it("renders nothing while tags are running", () => {
		const { container } = render(<EmailSmartTags status="running" tags={null} />);
		expect(container.firstChild).toBeNull();
	});

	it("renders nothing when status is failed", () => {
		const { container } = render(<EmailSmartTags status="failed" tags={tags} />);
		expect(container.firstChild).toBeNull();
	});

	it("renders nothing when status is skipped", () => {
		const { container } = render(<EmailSmartTags status="skipped" tags={tags} />);
		expect(container.firstChild).toBeNull();
	});

	it("renders one chip per tag", () => {
		render(<EmailSmartTags status="succeeded" tags={tags} />);
		expect(screen.getByTestId("wemail-tag-question")).toBeInTheDocument();
		expect(screen.getByTestId("wemail-tag-notification")).toBeInTheDocument();
	});

	it("fires onReject when the reject button is clicked", async () => {
		const user = userEvent.setup();
		const onReject = vi.fn();
		render(<EmailSmartTags status="succeeded" tags={tags} onReject={onReject} />);
		await user.click(screen.getByTestId("wemail-tag-reject-question"));
		expect(onReject).toHaveBeenCalledWith("question");
		expect(onReject).toHaveBeenCalledTimes(1);
	});

	it("fires onConfirm when the confirm button is clicked", async () => {
		const user = userEvent.setup();
		const onConfirm = vi.fn();
		render(<EmailSmartTags status="succeeded" tags={tags} onConfirm={onConfirm} />);
		await user.click(screen.getByTestId("wemail-tag-confirm-question"));
		expect(onConfirm).toHaveBeenCalledWith("question");
		expect(onConfirm).toHaveBeenCalledTimes(1);
	});

	it("does not show confirm/reject buttons for auto-tier tags", () => {
		render(<EmailSmartTags status="succeeded" tags={tags} />);
		expect(
			screen.queryByTestId("wemail-tag-confirm-notification"),
		).toBeNull();
		expect(
			screen.queryByTestId("wemail-tag-reject-notification"),
		).toBeNull();
	});

	it("shows confirm/reject buttons for suggested-tier tags", () => {
		render(
			<EmailSmartTags
				status="succeeded"
				tags={tags}
				onConfirm={vi.fn()}
				onReject={vi.fn()}
			/>,
		);
		expect(
			screen.getByTestId("wemail-tag-confirm-question"),
		).toBeInTheDocument();
		expect(
			screen.getByTestId("wemail-tag-reject-question"),
		).toBeInTheDocument();
	});

	it("renders only contentTags as keyboard-operable promotion buttons", async () => {
		const user = userEvent.setup();
		const withCandidates: TagResult = {
			...tags,
			contentTags: [{
				name: "构建日报",
				confidence: 0.92,
				source: "ai",
				tier: "auto",
				topicId: "topic-1",
			}],
			system: {
				important: { matched: true, confidence: 0.9, reason: "重要", source: "ai" },
				actionRequired: { matched: false, confidence: 0.2, reason: "无需处理", source: "ai" },
				invoice: { matched: false, confidence: 0.2, reason: "非发票", source: "ai" },
			},
		};
		render(
			<EmailSmartTags
				status="succeeded"
				tags={withCandidates}
				emailId="mail-1"
				accountId="acct-1"
			/>,
		);

		const candidate = screen.getByRole("button", {
			name: "使用候选标签“构建日报”创建智能标签",
		});
		expect(candidate).toHaveClass("focus-visible:ring-2");
		expect(screen.getByTestId("wemail-system-tag-important")).toBeInTheDocument();
		expect(screen.getByTestId("wemail-tag-notification").tagName).toBe("SPAN");
		candidate.focus();
		await user.keyboard("{Enter}");
		expect(screen.getByTestId("promotion-dialog-stub")).toHaveTextContent("构建日报");
	});
});
