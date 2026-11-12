import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AiPromptBar, type AiPromptBarHandle } from "./AiPromptBar";
import api from "~/services/api";
import { toast } from "sonner";

vi.mock("sonner", () => ({
	toast: {
		error: vi.fn(),
		success: vi.fn(),
	},
}));

vi.mock("~/queries/writingStyles", () => ({
	useWritingStyles: () => ({ data: [] }),
}));

vi.mock("~/queries/aiProfile", () => ({
	useAiProfile: () => ({ data: null }),
}));

vi.mock("~/services/api", () => ({
	default: {
		composeDraft: vi.fn(),
	},
}));

const signature =
	'<div data-wemail-signature="true">--<br>Eddie</div>';

function renderBar(overrides: Partial<React.ComponentProps<typeof AiPromptBar>> = {}) {
	const onApply = vi.fn();
	render(
		<AiPromptBar
			mode="reply"
			originalEmailId="email-1"
			currentTo="dharmesh@example.com"
			currentSubject="Re: Newsletter"
			currentBody={`<p>Existing reply</p>${signature}`}
			onApply={onApply}
			{...overrides}
		/>,
	);
	return { onApply };
}

function renderStatefulEmptyBar() {
	const applySpy = vi.fn();
	function Harness() {
		const [body, setBody] = useState("");
		return (
			<AiPromptBar
				mode="new"
				originalEmailId={undefined}
				currentTo=""
				currentSubject=""
				currentBody={body}
				onApply={(patch) => {
					applySpy(patch);
					setBody(patch.bodyHtml);
				}}
			/>
		);
	}
	render(<Harness />);
	return { applySpy };
}

function renderStatefulBar(initialBody = "<p>Original draft.</p>") {
	const applySpy = vi.fn();
	function Harness() {
		const [body, setBody] = useState(initialBody);
		return (
			<AiPromptBar
				mode="new"
				originalEmailId={undefined}
				currentTo=""
				currentSubject=""
				currentBody={body}
				onApply={(patch) => {
					applySpy(patch);
					setBody(patch.bodyHtml);
				}}
			/>
		);
	}
	render(<Harness />);
	return { applySpy };
}

describe("AiPromptBar", () => {
	beforeEach(() => {
		vi.mocked(api.composeDraft).mockReset();
	});

	it("submits with Enter and keeps the protected signature", async () => {
		vi.mocked(api.composeDraft).mockResolvedValue({
			ok: true,
			draft: {
				type: "composeMail",
				operationType: "REPLY",
				status: "draft",
				to: ["dharmesh@example.com"],
				subject: "Re: Newsletter",
				draftMarkdown: "Dharmesh 您好，\n\n您的邮件已收悉，感谢分享。",
			},
		});
		const { onApply } = renderBar();
		const input = screen.getByPlaceholderText(/让 AI 帮你写邮件/);

		await userEvent.type(input, "回复已收到，稍微正式一点");
		fireEvent.keyDown(input, { key: "Enter" });

		await waitFor(() => expect(api.composeDraft).toHaveBeenCalledTimes(1));
		expect(api.composeDraft).toHaveBeenCalledWith(
			expect.objectContaining({
				intent: "回复已收到，稍微正式一点",
				currentBody: "Existing reply",
			}),
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
		expect(onApply).toHaveBeenCalledWith(
			expect.objectContaining({
				bodyHtml: expect.stringContaining(signature),
			}),
		);
	});

	it("does not submit on Shift+Enter", async () => {
		renderBar();
		const input = screen.getByPlaceholderText(/让 AI 帮你写邮件/);

		await userEvent.type(input, "第一行");
		fireEvent.keyDown(input, { key: "Enter", shiftKey: true });

		expect(api.composeDraft).not.toHaveBeenCalled();
	});

	it("exposes a focus handle for the inline AI writing guide", () => {
		const ref = createRef<AiPromptBarHandle>();
		render(
			<AiPromptBar
				ref={ref}
				mode="new"
				originalEmailId={undefined}
				currentTo=""
				currentSubject=""
				currentBody=""
				onApply={() => {}}
			/>,
		);

		ref.current?.focus();

		expect(screen.getByPlaceholderText(/让 AI 帮你写邮件/)).toHaveFocus();
	});

	it("shows clarification and leaves the current body unchanged", async () => {
		vi.mocked(api.composeDraft).mockResolvedValue({
			ok: true,
			draft: {
				type: "composeMail",
				operationType: "REPLY",
				status: "needsClarification",
				to: ["dharmesh@example.com"],
				subject: "Re: Newsletter",
				draftMarkdown: "",
				clarification: {
					status: "needsClarification",
					questions: ["您希望第一行写什么内容？"],
					missingFields: ["opening"],
				},
			},
		});
		const { onApply } = renderBar();

		await userEvent.type(
			screen.getByPlaceholderText(/让 AI 帮你写邮件/),
			"第一行",
		);
		await userEvent.click(screen.getByRole("button", { name: "发送给 AI" }));

		expect(
			await screen.findByText("您希望第一行写什么内容？"),
		).toBeInTheDocument();
		expect(onApply).not.toHaveBeenCalled();
	});

	it("applies resolved envelope fields and a suggested send time", async () => {
		vi.mocked(api.composeDraft).mockResolvedValue({
			ok: true,
			draft: {
				type: "composeMail",
				operationType: "NEW",
				status: "draft",
				to: ["Existing <existing@example.com>", "张三 <zhangsan@example.com>"],
				cc: ["李四 <lisi@example.com>"],
				bcc: ["审计 <audit@example.com>"],
				subject: "项目上线通知",
				draftMarkdown: "大家好，\n\n项目将按计划上线。",
				suggestedSendAt: "2026-07-31T01:00:00.000Z",
				suggestedSendTimeZone: "Asia/Shanghai",
				changeSummary: ["新增收件人 张三", "新增抄送人 李四", "建议明天 09:00 发送"],
			},
		});
		const { onApply } = renderBar({
			mode: "new",
			originalEmailId: undefined,
			accountId: "acct-1",
			currentTo: "Existing <existing@example.com>",
			currentCc: "",
			currentBcc: "",
			currentSubject: "",
			currentBody: "",
		});

		await userEvent.type(screen.getByPlaceholderText(/让 AI 帮你写邮件/), "明天上午九点发给张三，抄送李四");
		await userEvent.click(screen.getByRole("button", { name: "发送给 AI" }));

		await waitFor(() => expect(onApply).toHaveBeenCalledWith(expect.objectContaining({
			to: ["Existing <existing@example.com>", "张三 <zhangsan@example.com>"],
			cc: ["李四 <lisi@example.com>"],
			bcc: ["审计 <audit@example.com>"],
			subject: "项目上线通知",
			suggestedSendAt: "2026-07-31T01:00:00.000Z",
		})));
		expect(screen.getByTestId("compose-ai-change-summary")).toHaveTextContent("新增收件人 张三");
		expect(api.composeDraft).toHaveBeenCalledWith(expect.objectContaining({
			accountId: "acct-1",
			currentTo: ["Existing <existing@example.com>"],
			clientNow: expect.any(String),
			clientTimeZone: expect.any(String),
		}), expect.anything());
	});

	it("recalls a recent prompt without automatically sending it", async () => {
		vi.mocked(api.composeDraft).mockResolvedValue({
			ok: true,
			draft: {
				type: "composeMail",
				operationType: "REPLY",
				status: "draft",
				to: ["dharmesh@example.com"],
				subject: "Re: Newsletter",
				draftMarkdown: "Received, thank you.",
			},
		});
		renderBar();
		const input = screen.getByPlaceholderText(/让 AI 帮你写邮件/);

		await userEvent.type(input, "回复已收到");
		await userEvent.click(screen.getByRole("button", { name: "发送给 AI" }));
		await waitFor(() => expect(api.composeDraft).toHaveBeenCalledTimes(1));
		await userEvent.click(screen.getByRole("button", { name: "最近对话" }));
		await userEvent.click(screen.getByRole("button", { name: "回复已收到" }));

		expect(input).toHaveValue("回复已收到");
		expect(api.composeDraft).toHaveBeenCalledTimes(1);
	});

	it("exposes a working stop action while generation is pending", async () => {
		let aborted = false;
		vi.mocked(api.composeDraft).mockImplementation(
			((_input: unknown, options?: { signal?: AbortSignal }) =>
				new Promise((_resolve, reject) => {
					options?.signal?.addEventListener("abort", () => {
						aborted = true;
						reject(new DOMException("Aborted", "AbortError"));
					});
				})) as typeof api.composeDraft,
		);
		renderBar();
		await userEvent.type(
			screen.getByPlaceholderText(/让 AI 帮你写邮件/),
			"生成一封完整回复",
		);
		await userEvent.click(screen.getByRole("button", { name: "发送给 AI" }));

		await userEvent.click(
			await screen.findByRole("button", { name: "停止 AI 生成" }),
		);

		expect(aborted).toBe(true);
		await waitFor(() =>
			expect(
				screen.getByRole("button", { name: "发送给 AI" }),
			).toBeInTheDocument(),
		);
	});

	it("keeps draft optimization actions behind one compact control", async () => {
		vi.mocked(api.composeDraft)
			.mockResolvedValueOnce({
				ok: true,
				draft: {
					type: "composeMail",
					operationType: "REPLY",
					status: "draft",
					to: ["dharmesh@example.com"],
					subject: "Re: Newsletter",
					draftMarkdown: "First generated reply.",
				},
			})
			.mockResolvedValueOnce({
				ok: true,
				draft: {
					type: "composeMail",
					operationType: "REPLY",
					status: "draft",
					to: ["dharmesh@example.com"],
					subject: "Re: Newsletter",
					draftMarkdown: "Short reply.",
				},
			});
		const { onApply } = renderBar();
		await userEvent.type(
			screen.getByPlaceholderText(/让 AI 帮你写邮件/),
			"生成回复",
		);
		await userEvent.click(screen.getByRole("button", { name: "发送给 AI" }));
		expect(screen.queryByRole("button", { name: "缩写" })).not.toBeInTheDocument();
		await userEvent.click(
			await screen.findByRole("button", { name: "优化草稿" }),
		);
		await userEvent.click(screen.getByRole("menuitem", { name: "缩写" }));
		await waitFor(() => expect(onApply).toHaveBeenCalledTimes(2));

		await userEvent.click(
			screen.getByRole("button", { name: "上一个草稿版本" }),
		);

		expect(onApply).toHaveBeenLastCalledWith(
			expect.objectContaining({
				bodyHtml: expect.stringContaining("First generated reply."),
			}),
		);
	});

	it("shows one optimization menu after generating the first draft from an empty body", async () => {
		vi.mocked(api.composeDraft).mockResolvedValue({
			ok: true,
			draft: {
				type: "composeMail",
				operationType: "NEW",
				status: "draft",
				to: [],
				subject: "",
				draftMarkdown: "您好，\n\n您的邮件已收到，感谢来信。",
			},
		});
		renderStatefulEmptyBar();

		await userEvent.type(
			screen.getByPlaceholderText(/让 AI 帮你写邮件/),
			"写一封正式的确认邮件",
		);
		await userEvent.click(screen.getByRole("button", { name: "发送给 AI" }));

		const optimize = await screen.findByRole("button", { name: "优化草稿" });
		expect(optimize).toBeVisible();
		expect(screen.queryByRole("menuitem", { name: "扩写" })).not.toBeInTheDocument();
		await userEvent.click(optimize);
		expect(screen.getByRole("menuitem", { name: "扩写" })).toBeVisible();
		expect(screen.getByRole("menuitem", { name: "缩写" })).toBeVisible();
		expect(screen.getByRole("menuitem", { name: "重写" })).toBeVisible();
		expect(screen.getByRole("menuitem", { name: "修正语法" })).toBeVisible();
		expect(toast.success).not.toHaveBeenCalled();
	});

	it("truncates the forward version branch when regenerating from an older draft", async () => {
		vi.mocked(api.composeDraft)
			.mockResolvedValueOnce({
				ok: true,
				draft: {
					type: "composeMail",
					operationType: "NEW",
					status: "draft",
					to: [],
					subject: "",
					draftMarkdown: "Version A.",
				},
			})
			.mockResolvedValueOnce({
				ok: true,
				draft: {
					type: "composeMail",
					operationType: "NEW",
					status: "draft",
					to: [],
					subject: "",
					draftMarkdown: "Discarded forward version B.",
				},
			})
			.mockResolvedValueOnce({
				ok: true,
				draft: {
					type: "composeMail",
					operationType: "NEW",
					status: "draft",
					to: [],
					subject: "",
					draftMarkdown: "Replacement branch C.",
				},
			});
		const { applySpy } = renderStatefulBar();
		const input = screen.getByPlaceholderText(/让 AI 帮你写邮件/);

		await userEvent.type(input, "生成 A");
		await userEvent.click(screen.getByRole("button", { name: "发送给 AI" }));
		await userEvent.click(
			await screen.findByRole("button", { name: "优化草稿" }),
		);
		await userEvent.click(screen.getByRole("menuitem", { name: "缩写" }));
		await waitFor(() => expect(applySpy).toHaveBeenCalledTimes(2));

		await userEvent.click(
			screen.getByRole("button", { name: "上一个草稿版本" }),
		);
		expect(applySpy).toHaveBeenLastCalledWith(
			expect.objectContaining({
				bodyHtml: expect.stringContaining("Version A."),
			}),
		);

		await userEvent.type(input, "生成替代分支 C");
		await userEvent.click(screen.getByRole("button", { name: "发送给 AI" }));
		await waitFor(() => expect(applySpy).toHaveBeenCalledTimes(4));
		expect(screen.getByText("3 / 3")).toBeVisible();
		expect(
			screen.getByRole("button", { name: "下一个草稿版本" }),
		).toBeDisabled();

		await userEvent.click(
			screen.getByRole("button", { name: "上一个草稿版本" }),
		);
		await userEvent.click(
			screen.getByRole("button", { name: "下一个草稿版本" }),
		);
		expect(applySpy).toHaveBeenLastCalledWith(
			expect.objectContaining({
				bodyHtml: expect.stringContaining("Replacement branch C."),
			}),
		);
		expect(applySpy).not.toHaveBeenLastCalledWith(
			expect.objectContaining({
				bodyHtml: expect.stringContaining("Discarded forward version B."),
			}),
		);
	});
});
