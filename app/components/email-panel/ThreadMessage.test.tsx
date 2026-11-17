import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import type { Email } from "~/types";
import ThreadMessage from "./ThreadMessage";

vi.mock("~/components/EmailAttachmentList", () => ({
	default: () => null,
}));

vi.mock("~/components/email-panel/EmailBodyRenderer", () => ({
	default: () => <iframe data-testid="thread-email-iframe" title="mail body" />,
}));

vi.mock("~/components/SnoozeMenu", () => ({
	default: ({ children }: { children: React.ReactNode }) => children,
}));

const email: Email = {
	id: "msg-1",
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

function renderMessage(isExpanded: boolean) {
	return (
		<ThreadMessage
			email={email}
			isLast
			isExpanded={isExpanded}
			onToggleExpand={() => {}}
		/>
	);
}

describe("ThreadMessage iframe lifecycle", () => {
	test("large-body loading uses the supplied foreground callback", () => {
		const onLoadBody = vi.fn();
		render(
			<ThreadMessage
				email={email}
				isLast
				isExpanded
				bodyLoadFailed
				bodyTooLarge
				onLoadBody={onLoadBody}
				onToggleExpand={() => {}}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "加载正文" }));
		expect(onLoadBody).toHaveBeenCalledOnce();
		expect(screen.queryByTestId("thread-email-iframe")).not.toBeInTheDocument();
	});

	test("does not mount before first expansion and preserves the iframe afterward", () => {
		const view = render(renderMessage(false));
		expect(screen.queryByTestId("thread-email-iframe")).not.toBeInTheDocument();

		view.rerender(renderMessage(true));
		const iframe = screen.getByTestId("thread-email-iframe");

		view.rerender(renderMessage(false));
		expect(screen.getByTestId("thread-email-iframe")).toBe(iframe);
		expect(iframe.closest('[aria-hidden="true"]')).not.toBeNull();

		view.rerender(renderMessage(true));
		expect(screen.getByTestId("thread-email-iframe")).toBe(iframe);
	});

	test("recipient details expand without toggling the enclosing thread message", () => {
		const onToggleExpand = vi.fn();
		render(
			<ThreadMessage
				email={{
					...email,
					toAddresses: [{ email: "me@example.com", directoryName: "eddiewang(王振宇)" }],
					ccAddresses: [{ email: "copy@example.com" }],
				}}
				isLast
				isExpanded
				onToggleExpand={onToggleExpand}
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "展开邮件详情" }));
		expect(screen.getByText("抄送：")).toBeInTheDocument();
		expect(onToggleExpand).not.toHaveBeenCalled();
	});

	test("renders recipient details on a full-width row below sender and time", () => {
		render(renderMessage(true));
		const primary = screen.getByTestId("thread-message-primary-meta");
		const recipients = screen.getByTestId("thread-message-recipient-meta");

		expect(primary).toHaveTextContent("sender@example.com");
		expect(primary).not.toHaveTextContent("发送给：");
		expect(recipients).toHaveTextContent("发送给：me@example.com");
		expect(
			primary.compareDocumentPosition(recipients) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
	});
});
