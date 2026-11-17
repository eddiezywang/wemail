import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Email } from "~/types";
import EmailPanelDialogs from "./EmailPanelDialogs";

vi.mock("sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn() },
}));

const email: Email = {
	id: "mail-1",
	subject: "日报",
	sender: "sender@example.com",
	recipient: "me@example.com",
	date: "2026-08-11T08:00:00.000Z",
	read: true,
	starred: false,
	bodyHtml: "<table><tr><th>指标</th><th>值</th></tr><tr><td>成功</td><td>9</td></tr></table><img src='pixel.png'>",
	raw_headers: JSON.stringify({ From: "sender@example.com", Subject: "日报" }),
};

describe("EmailPanelDialogs", () => {
	it("copies the displayed source headers and the exact compact mail text", async () => {
		const writeText = vi.fn().mockResolvedValue(undefined);
		Object.defineProperty(navigator, "clipboard", {
			configurable: true,
			value: { writeText },
		});
		const baseProps = {
			previewImage: null,
			onCloseSource: vi.fn(),
			onCloseAiText: vi.fn(),
			onClosePreview: vi.fn(),
		};
		const { rerender } = render(
			<EmailPanelDialogs
				{...baseProps}
				sourceViewEmail={email}
				aiTextViewEmail={null}
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "复制文本" }));
		await waitFor(() => expect(writeText).toHaveBeenLastCalledWith(
			"From: sender@example.com\nSubject: 日报",
		));

		rerender(
			<EmailPanelDialogs
				{...baseProps}
				sourceViewEmail={null}
				aiTextViewEmail={email}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "复制文本" }));
		await waitFor(() => expect(writeText).toHaveBeenLastCalledWith(
			"指标\t值\n成功\t9",
		));
	});
});
