// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useComposeForm } from "./useComposeForm";
import { MAIL_AUTH_REQUIRED_EVENT } from "~/lib/mailCredentialEvents";
import { useUIStore } from "~/hooks/useUIStore";
import { useSendStatusStore } from "~/hooks/useSendStatusStore";
import { useCurrentAccount } from "~/queries/currentAccount";
import { useAccountSignaturePreference } from "~/hooks/useAccountSignaturePreferences";

vi.hoisted(() => {
	vi.resetModules();
});

const saveDraftMock = vi.fn();
const sendDraftMock = vi.fn();
const deleteEmailMock = vi.fn();

const UNDO_SEND_WINDOW_MS = 5000;
/** Advance past the undo-send hold so the deferred enqueue runs. */
const flushUndoWindow = () =>
	act(async () => {
		await vi.advanceTimersByTimeAsync(UNDO_SEND_WINDOW_MS);
	});

vi.mock("~/components/ui/sonner", () => ({
	toast: Object.assign(vi.fn(), {
		success: vi.fn(),
		error: vi.fn(),
		loading: vi.fn(),
	}),
}));

vi.mock("~/queries/mailboxes", () => ({
	useMailbox: () => ({
		data: {
			id: "acct-1",
			email: "me@example.com",
			name: "Me",
			settings: {},
		},
	}),
}));

vi.mock("~/queries/currentAccount", () => ({
	useCurrentAccount: vi.fn(),
}));

vi.mock("~/hooks/useAccountSignaturePreferences", () => ({
	useAccountSignaturePreference: vi.fn(),
}));

vi.mock("~/hooks/useAccountDirectoryName", () => ({
	useAccountDirectoryName: () => undefined,
}));

vi.mock("~/queries/emails", () => ({
	useSaveDraft: () => ({ mutateAsync: saveDraftMock }),
	useSendDraft: () => ({ mutateAsync: sendDraftMock }),
	useDeleteEmail: () => ({ mutate: deleteEmailMock }),
}));

// The compose form reads edition info (signature brand URL) via useQuery;
// stub it with the open-edition defaults so no QueryClient is needed.
// Avoid `importOriginal` here: on Linux CI the dependency optimizer rewrites
// the real package to an absolute `/node_modules/...?v=...` URL that cannot be
// resolved from inside a hoisted vi.mock factory.
vi.mock("@tanstack/react-query", () => ({
	useQuery: () => ({
		data: {
			providerPresets: [],
			bootToCredentials: false,
			signatureBrandUrl: "",
			features: {
				wecli: false,
				allowanceInvoice: false,
				enterpriseDirectory: false,
				officeSceneDetection: false,
			},
		},
	}),
	useQueryClient: () => ({ invalidateQueries: vi.fn() }),
	useMutation: () => ({ mutate: vi.fn(), mutateAsync: vi.fn() }),
}));

describe("useComposeForm draft saving", () => {
	beforeEach(() => {
		saveDraftMock.mockReset();
		sendDraftMock.mockReset();
		deleteEmailMock.mockReset();
		useSendStatusStore.setState({ phase: null, endsAt: 0, onUndo: null });
		useUIStore.setState({
			selectedEmailId: null,
			isComposing: false,
			_previousEmailId: null,
			composeOptions: { mode: "new", originalEmail: null, draftEmail: null },
			isComposeModalOpen: false,
			isSidebarOpen: false,
			isAgentPanelOpen: true,
		});
		vi.mocked(useCurrentAccount).mockReturnValue({
			data: { account: { id: "acct-1", emailAddress: "me@example.com" } },
		} as unknown as ReturnType<typeof useCurrentAccount>);
		vi.mocked(useAccountSignaturePreference).mockReturnValue({
			preference: { enabled: true, customText: "" },
			update: vi.fn(),
		});
	});

	it("injects the current account identity and WeMail footer by default", async () => {
		vi.mocked(useCurrentAccount).mockReturnValue({
			data: {
				account: {
					id: "acct-1",
					emailAddress: "123456789@example.com",
					displayName: "V Bank",
				},
			},
		} as unknown as ReturnType<typeof useCurrentAccount>);

		const { result } = renderHook(() => useComposeForm("acct-1"));

		await waitFor(() =>
			expect(result.current.body).toContain('data-wemail-signature="true"'),
		);
		expect(result.current.body).toContain("V Bank");
		expect(result.current.body).toContain("Sent with");
		expect(result.current.body).toContain("Wemail");
		expect(result.current.body).not.toContain("Eddie Wang");
		expect(result.current.spellcheckExemptWords).toEqual([
			"WeMail",
			"V",
			"Bank",
			"123456789",
		]);
	});

	it("initializes a new message with directory recipients", async () => {
		useUIStore.setState({
			composeOptions: {
				mode: "new",
				originalEmail: null,
				draftEmail: null,
				prefilledTo: "Evan <evan@example.com>, Alice <alice@example.com>",
			},
		});

		const { result } = renderHook(() => useComposeForm("acct-1"));

		await waitFor(() =>
			expect(result.current.to).toBe(
				"Evan <evan@example.com>, Alice <alice@example.com>",
			),
		);
		expect(result.current.showCcBcc).toBe(true);
	});

	it("keeps reply content, signature, and quoted mail in that order", async () => {
		useUIStore.setState({
			composeOptions: {
				mode: "reply",
				draftEmail: null,
				originalEmail: {
					id: "email-1",
					sender: "sender@example.com",
					recipient: "me@example.com",
					subject: "Report",
					date: "2026-07-21T08:00:00.000Z",
					body: "Original body",
				},
			},
		});

		const { result } = renderHook(() => useComposeForm("acct-1"));

		await waitFor(() =>
			expect(result.current.body).toContain('data-wemail-quoted-reply="true"'),
		);
		const signatureIndex = result.current.body.indexOf(
			'data-wemail-signature="true"',
		);
		const quoteIndex = result.current.body.indexOf(
			'data-wemail-quoted-reply="true"',
		);
		expect(signatureIndex).toBeGreaterThan(0);
		expect(quoteIndex).toBeGreaterThan(signatureIndex);
	});

	it("wraps forwarded mail in a collapsed-editor region", async () => {
		useUIStore.setState({
			composeOptions: {
				mode: "forward",
				draftEmail: null,
				originalEmail: {
					id: "email-2",
					sender: "sender@example.com",
					recipient: "me@example.com",
					subject: "Quarterly plan",
					date: "2026-07-21T08:00:00.000Z",
					body: "<p>Original body</p>",
				},
			},
		});

		const { result } = renderHook(() => useComposeForm("acct-1"));

		await waitFor(() =>
			expect(result.current.body).toContain(
				'data-wemail-forwarded-message="true"',
			),
		);
		expect(result.current.body).toContain("Original body");
		expect(result.current.showCcBcc).toBe(true);
	});

	it("omits the identity and footer when the account signature is disabled", async () => {
		vi.mocked(useAccountSignaturePreference).mockReturnValue({
			preference: { enabled: false, customText: "Should not render" },
			update: vi.fn(),
		});

		const { result } = renderHook(() => useComposeForm("acct-1"));

		await waitFor(() => expect(result.current.body).toBe(""));
		expect(result.current.body).not.toContain("Sent with");
		expect(result.current.body).not.toContain("Wemail");
	});

	it("saves incomplete drafts without requiring recipients", async () => {
		saveDraftMock.mockResolvedValue({ ok: true, draft: { id: "draft-1" } });
		const { result } = renderHook(() => useComposeForm("acct-1"));

		act(() => {
			result.current.setSubject("Idea");
			result.current.setBody("<p>Still writing</p>");
		});

		await act(async () => {
			await result.current.handleSaveDraft();
		});

		expect(result.current.error).toBeNull();
		expect(saveDraftMock).toHaveBeenCalledWith(
			expect.objectContaining({
				accountId: "acct-1",
				to: [],
				subject: "Idea",
				bodyHtml: "<p>Still writing</p>",
			}),
		);
	});

	it("reuses a newly saved draft when saving again and sending", async () => {
		saveDraftMock.mockResolvedValue({ ok: true, draft: { id: "draft-new" } });
		sendDraftMock.mockResolvedValue({ ok: true, outboxId: "outbox-1" });
		const { result } = renderHook(() => useComposeForm("acct-1"));
		act(() => {
			result.current.setTo("recipient@example.test");
			result.current.setSubject("Subject");
		});
		await act(async () => { await result.current.handleSaveDraft(); });
		await act(async () => { await result.current.handleSaveDraft(); });
		expect(saveDraftMock).toHaveBeenLastCalledWith(expect.objectContaining({ id: "draft-new" }));
		vi.useFakeTimers();
		await act(async () => {
			await result.current.handleSend({ preventDefault: vi.fn() } as unknown as React.FormEvent, vi.fn());
		});
		expect(sendDraftMock).not.toHaveBeenCalled(); // held in the undo window
		expect(useSendStatusStore.getState().phase).toBe("hold");
		await flushUndoWindow();
		vi.useRealTimers();
		expect(sendDraftMock).toHaveBeenCalledWith(expect.objectContaining({ draftId: "draft-new" }));
	});

	it("keeps the draft and never enqueues when the user undoes within the window", async () => {
		saveDraftMock.mockResolvedValue({ ok: true, draft: { id: "draft-undo" } });
		sendDraftMock.mockResolvedValue({ ok: true, outboxId: "outbox-1" });
		const { result } = renderHook(() => useComposeForm("acct-1"));
		act(() => {
			result.current.setTo("recipient@example.test");
			result.current.setSubject("Undo me");
		});
		vi.useFakeTimers();
		await act(async () => {
			await result.current.handleSend({ preventDefault: vi.fn() } as unknown as React.FormEvent, vi.fn());
		});
		const undoState = useSendStatusStore.getState();
		expect(undoState.phase).toBe("hold");
		expect(undoState.onUndo).toBeTypeOf("function");
		undoState.onUndo?.();
		await act(async () => { await vi.advanceTimersByTimeAsync(UNDO_SEND_WINDOW_MS); });
		vi.useRealTimers();
		expect(sendDraftMock).not.toHaveBeenCalled();
		expect(saveDraftMock).toHaveBeenCalledWith(expect.objectContaining({ subject: "Undo me" }));
		expect(useSendStatusStore.getState().phase).toBeNull();
	});

	it("reuses the same idempotency key after an uncertain submission", async () => {
		vi.spyOn(crypto, "randomUUID").mockReturnValue("00000000-0000-4000-8000-000000000001");
		saveDraftMock.mockResolvedValue({ ok: true, draft: { id: "draft-idem" } });
		sendDraftMock.mockRejectedValueOnce(new Error("request timed out"))
			.mockResolvedValueOnce({ ok: true, outboxId: "outbox-1" });
		const { result } = renderHook(() => useComposeForm("acct-1"));
		act(() => result.current.setTo("recipient@example.test"));
		vi.useFakeTimers();
		await act(async () => { await result.current.handleSend({ preventDefault: vi.fn() } as unknown as React.FormEvent, vi.fn()); });
		await flushUndoWindow();
		expect(result.current.error).toContain("提交结果不确定");
		await act(async () => { await result.current.handleSend({ preventDefault: vi.fn() } as unknown as React.FormEvent, vi.fn()); });
		await flushUndoWindow();
		vi.useRealTimers();
		expect(sendDraftMock.mock.calls[0][0].idempotencyKey).toBe(sendDraftMock.mock.calls[1][0].idempotencyKey);
		vi.restoreAllMocks();
	});

	it("preserves the existing draft id when saving edits", async () => {
		saveDraftMock.mockResolvedValue({ ok: true, draft: { id: "draft-existing" } });
		useUIStore.setState({
			composeOptions: {
				mode: "new",
				originalEmail: null,
				draftEmail: {
					id: "draft-existing",
					subject: "Old subject",
					sender: "me@example.com",
					recipient: "",
					date: "2026-04-26T10:00:00.000Z",
					read: true,
					starred: false,
					body: "<p>Old body</p>",
				},
			},
		});
		const { result } = renderHook(() => useComposeForm("acct-1"));

		await waitFor(() => expect(result.current.subject).toBe("Old subject"));
		act(() => {
			result.current.setSubject("Updated subject");
		});
		await act(async () => {
			await result.current.handleSaveDraft();
		});

		expect(saveDraftMock).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "draft-existing",
				accountId: "acct-1",
				subject: "Updated subject",
			}),
		);
		sendDraftMock.mockResolvedValue({ ok: true, outboxId: "outbox-1" });
		act(() => result.current.setTo("recipient@example.test"));
		vi.useFakeTimers();
		await act(async () => {
			await result.current.handleSend({ preventDefault: vi.fn() } as unknown as React.FormEvent, vi.fn());
		});
		await flushUndoWindow();
		vi.useRealTimers();
		expect(sendDraftMock).toHaveBeenCalledWith(expect.objectContaining({ draftId: "draft-existing" }));
		expect(deleteEmailMock).not.toHaveBeenCalled();
	});

	it("still requires recipients when sending", async () => {
		const { result } = renderHook(() => useComposeForm("acct-1"));

		await act(async () => {
			await result.current.handleSend(
				{ preventDefault: vi.fn() } as unknown as React.FormEvent,
				vi.fn(),
			);
		});

		expect(result.current.error).toBe("请至少添加一个收件人。");
		expect(sendDraftMock).not.toHaveBeenCalled();
	});

	it("refuses to send rather than dropping uploaded attachments", async () => {
		sendDraftMock.mockResolvedValue({ ok: true, messageId: "sent-1" });
		useUIStore.setState({
			composeOptions: {
				mode: "reply",
				draftEmail: null,
				originalEmail: {
					id: "email-1",
					thread_id: "thread-1",
					sender: "sender@example.com",
					recipient: "me@example.com",
					cc: "",
					subject: "Report",
					date: "2026-06-30T10:00:00.000Z",
					body: "Please review.",
				},
			},
		});
		const { result } = renderHook(() => useComposeForm("acct-1"));
		const file = new File(["hello"], "hello.txt", { type: "text/plain" });

		await act(async () => {
			await result.current.addAttachments([file]);
		});
		act(() => {
			result.current.setTo("sender@example.com");
		});
		await act(async () => {
			await result.current.handleSend(
				{ preventDefault: vi.fn() } as unknown as React.FormEvent,
				vi.fn(),
			);
		});

		expect(sendDraftMock).not.toHaveBeenCalled();
		expect(result.current.error).toBe("暂不支持发送附件，请先移除附件。");
	});

	it("refuses to save rather than dropping uploaded attachments", async () => {
		saveDraftMock.mockResolvedValue({ ok: true, draft: { id: "draft-1" } });
		const file = new File(["hello"], "hello.txt", { type: "text/plain" });
		const { result } = renderHook(() => useComposeForm("acct-1"));

		await act(async () => {
			await result.current.addAttachments([file]);
		});
		act(() => {
			result.current.setSubject("With attachment");
		});

		await act(async () => {
			await result.current.handleSaveDraft();
		});

		expect(saveDraftMock).not.toHaveBeenCalled();
		expect(result.current.error).toBe("暂不支持保存含附件的草稿，请先移除附件。");
	});

	it("sends with the current account when no mailbox route param is present", async () => {
		saveDraftMock.mockResolvedValue({ ok: true, draft: { id: "draft-route" } });
		sendDraftMock.mockResolvedValue({ ok: true, messageId: "sent-1" });
		const onClose = vi.fn();
		const { result } = renderHook(() => useComposeForm(undefined));

		act(() => {
			result.current.setTo("x@example.com");
			result.current.setSubject("Hello");
			result.current.setBody("<p>World</p>");
		});

		vi.useFakeTimers();
		await act(async () => {
			await result.current.handleSend(
				{ preventDefault: vi.fn() } as unknown as React.FormEvent,
				onClose,
			);
		});
		await flushUndoWindow();
		vi.useRealTimers();

		expect(result.current.error).toBeNull();
		expect(sendDraftMock).toHaveBeenCalledWith(
			expect.objectContaining({
				accountId: "acct-1",
				to: [{ email: "x@example.com" }],
			}),
		);
		expect(onClose).toHaveBeenCalled();
	});
});

describe("useComposeForm credential errors", () => {
	beforeEach(() => {
		sendDraftMock.mockReset();
		useSendStatusStore.setState({ phase: null, endsAt: 0, onUndo: null });
		vi.mocked(useCurrentAccount).mockReturnValue({ data: { account: { id: "acct-1" } } } as never);
	});

	it("opens the update-password dialog instead of a dead-end toast", async () => {
		saveDraftMock.mockResolvedValue({ ok: true, draft: { id: "draft-pw" } });
		sendDraftMock.mockRejectedValue(
			new Error("credential-required: IMAP LOGIN rejected — password expired"),
		);
		const events: Array<{ accountId: string; code: string; source: string }> = [];
		const listener = (event: Event) => {
			events.push((event as CustomEvent).detail);
		};
		window.addEventListener(MAIL_AUTH_REQUIRED_EVENT, listener);
		const { result } = renderHook(() => useComposeForm("acct-1"));
		act(() => {
			result.current.setTo("recipient@example.test");
			result.current.setSubject("Subject");
			result.current.setBody("Body");
		});
		vi.useFakeTimers();
		await act(async () => {
			await result.current.handleSend({ preventDefault: vi.fn() } as unknown as React.FormEvent, vi.fn());
		});
		await flushUndoWindow();
		vi.useRealTimers();
		window.removeEventListener(MAIL_AUTH_REQUIRED_EVENT, listener);
		expect(events).toEqual([
			{ accountId: "acct-1", code: "MAIL_CREDENTIAL_INVALID", source: "send" },
		]);
		expect(result.current.error).toContain("密码已过期");
	});
});
