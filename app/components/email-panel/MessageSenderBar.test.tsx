// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TooltipProvider } from "~/components/ui/tooltip";
import MessageSenderBar from "./MessageSenderBar";
import type { Email } from "~/types";

function makeEmail(overrides: Partial<Email> = {}): Email {
	return {
		body: "Hello",
		date: "2026-07-29T10:54:00.000Z",
		folder_id: "Inbox",
		id: "msg-1",
		read: false,
		recipient: "me@example.com",
		sender: "Google <no-reply@google.com>",
		starred: false,
		subject: "安全提醒",
		...overrides,
	};
}

describe("MessageSenderBar", () => {
	it("presents sender identity, recipient details, and time in one bar", () => {
		render(
			<TooltipProvider delayDuration={0}>
				<MessageSenderBar
					email={makeEmail()}
					onReply={() => undefined}
					onForward={() => undefined}
				/>
			</TooltipProvider>,
		);

		const bar = screen.getByLabelText("发件人信息");
		const time = bar.querySelector("time");
		expect(bar).toHaveClass("items-start");
		expect(bar).toHaveTextContent("G");
		expect(bar).toHaveTextContent("Google");
		expect(bar).toHaveTextContent("发送给：me@example.com");
		expect(time).toHaveAttribute(
			"datetime",
			"2026-07-29T10:54:00.000Z",
		);
		expect(time?.parentElement).toHaveTextContent("Google");
		expect(time?.parentElement).not.toHaveTextContent("发送给：");
		expect(screen.getByTestId("message-sender-actions")).toHaveClass(
			"absolute",
			"top-2",
		);
	});

	it("derives a useful avatar initial for address-only senders", () => {
		render(
			<TooltipProvider delayDuration={0}>
				<MessageSenderBar
					email={makeEmail({ sender: "alerts@example.com" })}
				/>
			</TooltipProvider>,
		);

		expect(screen.getByLabelText("发件人信息")).toHaveTextContent("A");
	});
});
