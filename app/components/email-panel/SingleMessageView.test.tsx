import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import type { Email } from "~/types";
import SingleMessageView, { SingleMessageActions } from "./SingleMessageView";

vi.mock("~/components/EmailAttachmentList", () => ({
	default: () => <div data-testid="attachment-list" />,
}));

vi.mock("~/components/email-panel/EmailBodyRenderer", () => ({
	default: () => <iframe title="mail body" />,
}));

vi.mock("~/components/SnoozeMenu", () => ({
	default: ({ children }: { children: React.ReactNode }) => children,
}));

const email: Email = {
	id: "message-1",
	subject: "Subject",
	sender: "sender@example.com",
	recipient: "me@example.com",
	date: "2026-07-17T10:00:00.000Z",
	read: true,
	starred: false,
	body: "<p>Hello</p>",
	bodyHtml: "<p>Hello</p>",
	attachments: [],
};

describe("SingleMessageView content layout", () => {
	test("renders attachments before the message body without duplicating header metadata", () => {
		render(
			<SingleMessageView
				email={email}
				mailboxId="mailbox-1"
				onPreviewImage={vi.fn()}
			/>,
		);

		const attachments = screen.getByTestId("attachment-list");
		const body = screen.getByTitle("mail body");
		expect(screen.queryByTestId("single-message-primary-meta")).not.toBeInTheDocument();
		expect(
			attachments.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
	});

	test("renders and invokes the reply-all action when supplied", () => {
		const onReplyAll = vi.fn();
		render(<SingleMessageActions onReplyAll={onReplyAll} />);

		fireEvent.click(screen.getByRole("button", { name: "回复所有人" }));
		expect(onReplyAll).toHaveBeenCalledOnce();
	});
});
