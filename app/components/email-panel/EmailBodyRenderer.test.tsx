import { render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import EmailBodyRenderer from "./EmailBodyRenderer";
import type { Email } from "~/types";
import { beginMailOpenTrace } from "~/lib/mailOpenTrace";

const paintCallbacks = vi.hoisted(() => [] as Array<() => void>);

vi.mock("~/components/EmailIframe", () => ({
	default: ({ body, onPaint }: { body: string; onPaint?: () => void }) => {
		if (onPaint) paintCallbacks.push(onPaint);
		return <div data-testid="email-iframe" data-body-length={body.length} />;
	},
}));

const baseEmail: Email = {
	id: "msg-1",
	subject: "Subject",
	sender: "sender@example.com",
	recipient: "me@example.com",
	date: "2026-04-27T12:00:00.000Z",
	read: true,
	starred: false,
	body: null,
	attachments: [],
};

describe("EmailBodyRenderer", () => {
	test("a late iframe paint cannot complete a later open of the same message", async () => {
		const email = { ...baseEmail, id: "reopened-body", bodyHtml: "<p>body</p>" };
		const first = beginMailOpenTrace(email.id, true);
		const view = render(<EmailBodyRenderer email={email} traceId={first} />);
		await screen.findByTestId("email-iframe");
		const stalePaint = paintCallbacks.at(-1)!;
		const second = beginMailOpenTrace(email.id, true);
		view.rerender(<EmailBodyRenderer email={email} traceId={second} />);
		const currentPaint = paintCallbacks.at(-1)!;
		const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
		try {
			stalePaint();
			expect(debug).not.toHaveBeenCalled();
			currentPaint();
			expect(debug).toHaveBeenCalledTimes(1);
			expect(debug.mock.calls[0][0]).toContain(second);
		} finally { debug.mockRestore(); }
	});

	test("keeps metadata visible while rendering a body-only loading state", () => {
		render(<EmailBodyRenderer email={baseEmail} loading />);
		expect(screen.getByTestId("email-body-loading")).toBeInTheDocument();
		expect(screen.queryByText("没有可显示的正文。")).not.toBeInTheDocument();
	});

	test("renders plaintext as escaped pre-wrapped text", () => {
		render(
			<EmailBodyRenderer
				email={{
					...baseEmail,
					bodyText: "Hello\n<script>alert(1)</script>",
				}}
			/>,
		);

		expect(screen.getByText(/Hello/)).toHaveClass("whitespace-pre-wrap");
		expect(screen.getByText(/<script>alert\(1\)<\/script>/)).toBeInTheDocument();
		expect(screen.queryByTestId("email-iframe")).not.toBeInTheDocument();
	});

	test("renders html through EmailIframe after yielding the metadata paint", async () => {
		render(
			<EmailBodyRenderer
				email={{
					...baseEmail,
					bodyHtml: "<p>Hello HTML</p>",
					bodyText: "Hello text",
				}}
				mailboxId="acct-1"
			/>,
		);

		expect(screen.getByTestId("email-body-loading")).toBeInTheDocument();
		expect(await screen.findByTestId("email-iframe")).toHaveAttribute(
			"data-body-length",
			String("<p>Hello HTML</p>".length),
		);
	});

	test("renders large html without a second confirmation", async () => {
		const bodyHtml = `<p>${"x".repeat(512 * 1024)}</p>`;
		render(
			<EmailBodyRenderer
				email={{ ...baseEmail, bodyHtml }}
				mailboxId="acct-1"
			/>,
		);

		expect(await screen.findByTestId("email-iframe")).toHaveAttribute(
			"data-body-length",
			String(bodyHtml.length),
		);
		expect(screen.queryByText("展开完整正文")).not.toBeInTheDocument();
	});
});
