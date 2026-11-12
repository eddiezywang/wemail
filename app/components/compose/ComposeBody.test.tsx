// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import ComposeBody from "./ComposeBody";

const { focusSpy, composeState } = vi.hoisted(() => ({
	focusSpy: vi.fn(),
	composeState: {
		body: '<p><br></p><div data-wemail-signature="true">V Bank</div>',
	},
}));

vi.mock("react-router", () => ({
	useParams: () => ({ mailboxId: "acct-1", folder: "INBOX" }),
}));

vi.mock("~/components/RichTextEditor", () => ({
	default: ({
		emptyGuidance,
		spellcheckExemptWords,
	}: {
		emptyGuidance?: React.ReactNode;
		spellcheckExemptWords?: string[];
	}) => (
		<div
			data-testid="editor-shell"
			data-spellcheck-exempt-words={spellcheckExemptWords?.join(",")}
		>
			{emptyGuidance}
		</div>
	),
}));

vi.mock("~/components/compose/AiPromptBar", async () => {
	const React = await import("react");
	return {
		AiPromptBar: React.forwardRef(function MockAiPromptBar(props: { onApply: (patch: { bodyHtml: string; to?: string[]; cc?: string[]; bcc?: string[]; suggestedSendAt?: string }) => void }, ref) {
			React.useImperativeHandle(ref, () => ({ focus: focusSpy }));
			return <><textarea aria-label="AI 指令" /><button type="button" onClick={() => props.onApply({
				bodyHtml: "<p>AI body</p>",
				to: ["张三 <zhangsan@example.com>"],
				cc: ["李四 <lisi@example.com>"],
				bcc: ["审计 <audit@example.com>"],
				suggestedSendAt: "2026-07-31T01:00:00.000Z",
			})}>应用 AI 草稿</button></>;
		}),
	};
});

vi.mock("~/hooks/useComposeForm", () => ({
	useComposeForm: () => ({
		to: "",
		setTo: vi.fn(),
		cc: "",
		setCc: vi.fn(),
		bcc: "",
		setBcc: vi.fn(),
		showCcBcc: false,
		setShowCcBcc: vi.fn(),
		subject: "",
		setSubject: vi.fn(),
		body: composeState.body,
		setBody: vi.fn(),
		attachments: [],
		addAttachments: vi.fn(),
		removeAttachment: vi.fn(),
		error: null,
		isSavingDraft: false,
		isSending: false,
		formTitle: "Reply",
		handleSaveDraft: vi.fn(),
		handleSend: vi.fn(),
		buildDraftInput: vi.fn(),
		buildDraftSaveInput: vi.fn(),
		closeCompose: vi.fn(),
		spellcheckExemptWords: ["WeMail", "eddiewang"],
	}),
}));

vi.mock("~/hooks/useUIStore", () => ({
	useUIStore: () => ({
		composeOptions: { mode: "reply", originalEmail: { id: "email-1" }, draftEmail: null },
	}),
}));

vi.mock("~/queries/currentAccount", () => ({
	useCurrentAccount: () => ({ data: { account: { id: "acct-1" } } }),
}));

vi.mock("~/queries/scheduledDrafts", () => ({
	useScheduleDraft: () => ({ mutateAsync: vi.fn() }),
}));

vi.mock("~/services/api", () => ({
	default: { saveWemailDraft: vi.fn() },
}));

describe("ComposeBody AI writing guidance", () => {
	it("passes account spellcheck exemptions to the rich text editor", () => {
		composeState.body = "<p>Already writing</p>";
		render(<ComposeBody renderHeader={() => null} />);

		expect(screen.getByTestId("editor-shell")).toHaveAttribute(
			"data-spellcheck-exempt-words",
			"WeMail,eddiewang",
		);
	});

	it("keeps the subject field accessible without placeholder text", () => {
		composeState.body = "<p>Already writing</p>";
		render(<ComposeBody renderHeader={() => null} />);

		const subject = screen.getByRole("textbox", { name: "主题" });
		expect(subject).not.toHaveAttribute("placeholder");
		expect(subject).toHaveClass(
			"border-b",
			"border-edge",
			"focus:border-coral",
			"focus-visible:border-coral",
		);
	});

	it("makes only the AI writing text interactive", async () => {
		focusSpy.mockReset();
		composeState.body =
			'<p><br></p><div data-wemail-signature="true">V Bank</div>';
		render(<ComposeBody renderHeader={() => null} />);

		expect(
			screen.queryByRole("button", { name: "开始输入或 使用 AI 写作" }),
		).not.toBeInTheDocument();

		const aiButton = screen.getByRole("button", { name: "使用 AI 写作" });
		expect(aiButton).toHaveClass("pointer-events-auto");

		await userEvent.click(screen.getByText("开始输入或"));
		expect(focusSpy).not.toHaveBeenCalled();

		await userEvent.click(aiButton);
		expect(focusSpy).toHaveBeenCalledTimes(1);
	});

	it("hides the guidance when the draft has editable body content", () => {
		composeState.body = "<p>Already writing</p>";
		render(<ComposeBody renderHeader={() => null} />);

		expect(screen.queryByText("开始输入或")).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "使用 AI 写作" }),
		).not.toBeInTheDocument();
	});

	it("shows and can clear the AI suggested send time", async () => {
		composeState.body = "";
		render(<ComposeBody renderHeader={(state) => <div data-testid="header-send-at">{state.suggestedSendAt?.toISOString()}</div>} />);

		await userEvent.click(screen.getByRole("button", { name: "应用 AI 草稿" }));

		expect(screen.getByTestId("compose-suggested-send-time")).toHaveTextContent("计划发送");
		expect(screen.getByTestId("header-send-at")).toHaveTextContent("2026-07-31T01:00:00.000Z");
		await userEvent.click(screen.getByRole("button", { name: "清除" }));
		expect(screen.queryByTestId("compose-suggested-send-time")).not.toBeInTheDocument();
	});
});
