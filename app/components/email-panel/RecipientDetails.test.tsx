import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { TooltipProvider } from "~/components/ui/tooltip";
import RecipientDetails from "./RecipientDetails";

describe("RecipientDetails", () => {
	test("renders a compact summary and expands complete message details", () => {
		const { container } = render(
			<RecipientDetails
				messageId="message-1"
				sender="Google <no-reply@google.com>"
				date="2026-07-29T11:12:00.000Z"
				to={[{
					name: "Evan Xu",
					email: "evanxu@example.com",
					directoryName: "evanxu(徐自然)",
				}]}
				cc={[{ name: "Alice", email: "alice@example.com" }]}
				bcc={[{ email: "audit@example.com" }]}
			/>,
		);

		expect(container.firstChild).toHaveClass(
			"mt-0.5",
			"w-full",
			"min-w-0",
			"text-xs",
			"text-ink-3",
		);
		expect(screen.getByText("发送给：")).toBeInTheDocument();
		// The compact row renders a plain text summary (directory name when
		// known), not the full address tags.
		const summary = screen.getByTitle("evanxu(徐自然)");
		expect(summary).toHaveTextContent("evanxu(徐自然)");
		expect(summary).toHaveClass("min-w-0", "max-w-full", "truncate");
		expect(screen.queryByText("发件人：")).not.toBeInTheDocument();
		expect(screen.queryByText("抄送：")).not.toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: "展开邮件详情" }));
		expect(screen.getByLabelText("邮件详细信息")).toBeInTheDocument();
		expect(screen.getByText("发件人：")).toBeInTheDocument();
		expect(screen.getByText("收件人：")).toBeInTheDocument();
		expect(screen.getByText("抄送：")).toBeInTheDocument();
		expect(screen.getByText("密送：")).toBeInTheDocument();
		expect(screen.getByText("日期：")).toBeInTheDocument();
		expect(screen.getByText("Google <no-reply@google.com>")).toBeInTheDocument();
		expect(screen.getByText(/2026年7月29日 \d{2}:12/)).toBeInTheDocument();
		expect(screen.getByText("evanxu(徐自然) <evanxu@example.com>")).toBeInTheDocument();
		expect(screen.getByText("Alice <alice@example.com>")).toBeInTheDocument();
		expect(screen.getByText("Alice <alice@example.com>")).toHaveClass(
			"rounded-md",
			"bg-paper-2",
		);

		fireEvent.click(screen.getByRole("button", { name: "收起邮件详情" }));
		expect(screen.queryByText("抄送：")).not.toBeInTheDocument();
	});

	test("falls back to original names and omits empty address groups", () => {
		render(
			<RecipientDetails
				messageId="message-2"
				to={[{ name: "External User", email: "user@example.com" }]}
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "展开邮件详情" }));
		expect(screen.getByText("External User <user@example.com>")).toBeInTheDocument();
		expect(screen.queryByText("抄送：")).not.toBeInTheDocument();
		expect(screen.queryByText("密送：")).not.toBeInTheDocument();
	});

	test("resets to compact state when the message changes", () => {
		const view = render(
			<RecipientDetails messageId="message-1" to={[{ email: "one@example.com" }]} />,
		);
		fireEvent.click(screen.getByRole("button", { name: "展开邮件详情" }));

		view.rerender(
			<RecipientDetails messageId="message-2" to={[{ email: "two@example.com" }]} />,
		);
		expect(screen.getByRole("button", { name: "展开邮件详情" })).toHaveAttribute(
			"aria-expanded",
			"false",
		);
	});

	test("marks an SMTP-rejected recipient and exposes the delivery explanation", async () => {
		render(
			<TooltipProvider delayDuration={0}>
				<RecipientDetails
					messageId="message-partial"
					to={[{ email: "accepted@example.com" }]}
					cc={[{ email: "fangfangliu@example.com" }]}
					delivery={{
						status: "partial",
						accepted: ["accepted@example.com"],
						rejected: ["fangfangliu@example.com"],
					}}
				/>
			</TooltipProvider>,
		);

		fireEvent.click(screen.getByRole("button", { name: "展开邮件详情" }));
		const rejected = screen.getByText("fangfangliu@example.com");
		expect(rejected).toHaveClass("text-red-600", "decoration-dotted");
		// The accepted address shows up in both the compact summary and the
		// expanded tag; neither may carry the rejection styling.
		for (const accepted of screen.getAllByText("accepted@example.com")) {
			expect(accepted).not.toHaveClass("text-red-600");
		}

		fireEvent.focus(rejected);
		expect(
			(await screen.findAllByText("SMTP 未接受此收件人，邮件可能未送达")).length,
		).toBeGreaterThan(0);
	});
});
