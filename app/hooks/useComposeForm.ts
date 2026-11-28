// Copyright (c) 2026 Cloudflare, Inc.
// Modified for WeMail.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { toast } from "~/components/ui/sonner";
import DOMPurify from "dompurify";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
	buildQuotedReplyBlock,
	escapeHtml,
	formatComposeDate,
	getSignatureBlock,
	htmlToPlainText,
	parseAddressList,
	resolveSignatureText,
	splitEmailList,
} from "~/lib/utils";
import { buildComposeSpellcheckExemptWords } from "~/lib/spellcheck";
import { getUserFacingError, isCredentialError } from "~/lib/user-facing-error";
import { MAIL_CREDENTIAL_INVALID, dispatchMailAuthRequired } from "~/lib/mailCredentialEvents";
import { getComposeError, getComposeSubmitError } from "~/lib/compose-errors";
import type {
	WemailDraftInput,
	WemailDraftSaveInput,
	WemailOutboundAttachment,
} from "../../shared/wemail/mail";
import { useSaveDraft, useSendDraft } from "~/queries/emails";
import api from "~/services/api";
import { useMailbox } from "~/queries/mailboxes";
import { useCurrentAccount } from "~/queries/currentAccount";
import { useUIStore } from "~/hooks/useUIStore";
import { useImeComposition } from "~/hooks/useImeComposition";
import { useAccountSignaturePreference } from "~/hooks/useAccountSignaturePreferences";
import { useAccountDirectoryName } from "~/hooks/useAccountDirectoryName";

function appendUniqueAddress(
	addresses: string[],
	seen: Set<string>,
	address: string,
	exclude?: string,
) {
	const trimmed = address.trim();
	if (!trimmed) return;

	const normalized = normalizeRecipientAddress(trimmed);
	const normalizedExclude = exclude ? normalizeRecipientAddress(exclude) : undefined;
	if (normalized === normalizedExclude || seen.has(normalized)) return;

	seen.add(normalized);
	addresses.push(trimmed);
}

function normalizeRecipientAddress(address: string): string {
	return parseAddressList(address)[0]?.email.trim().toLowerCase() || address.trim().toLowerCase();
}

interface ComposeFormFields {
	to: string;
	cc: string;
	bcc: string;
	showCcBcc: boolean;
	subject: string;
	body: string;
}

const EMPTY_FIELDS: ComposeFormFields = {
	to: "",
	cc: "",
	bcc: "",
	showCcBcc: true,
	subject: "",
	body: "",
};

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = 25 * 1024 * 1024;

function composeSnapshot(
	fields: ComposeFormFields,
	attachments: WemailOutboundAttachment[],
): string {
	return JSON.stringify({
		to: fields.to,
		cc: fields.cc,
		bcc: fields.bcc,
		subject: fields.subject,
		body: fields.body,
		attachments: attachments.map(({ id, filename, size, mimetype }) => ({
			id,
			filename,
			size,
			mimetype,
		})),
	});
}

function getPrefixedSubject(subject: string, prefix: "Re" | "Fwd") {
	const expectedPrefix = `${prefix}: `;
	return subject.startsWith(expectedPrefix)
		? subject
		: `${expectedPrefix}${subject}`;
}

function buildForwardBody(
	original: NonNullable<ReturnType<typeof useUIStore.getState>["composeOptions"]["originalEmail"]>,
	sigBlock: string,
) {
	const safeSender = escapeHtml(original.sender);
	const safeSubject = escapeHtml(original.subject);
	const safeBody = DOMPurify.sanitize(original.body || "", {
		FORBID_TAGS: ["script", "style", "iframe", "object", "embed", "img"],
		FORBID_ATTR: ["style", "srcset", "onerror", "onload"],
	});
	const attachmentNotice = original.attachments?.length
		? `<p><strong>附件提示：</strong>原邮件包含 ${original.attachments.length} 个附件，请确认是否需要重新添加。</p>`
		: "";

	return `<p><br></p>${sigBlock ? `${sigBlock}<br>` : ""}<div data-wemail-forwarded-message="true"><p><strong>转发的邮件</strong><br><strong>发件人：</strong>${safeSender}<br><strong>日期：</strong>${formatComposeDate(original.date)}<br><strong>主题：</strong>${safeSubject}</p>${attachmentNotice}${safeBody}</div>`;
}

function buildReplyAllFields(
	original: NonNullable<ReturnType<typeof useUIStore.getState>["composeOptions"]["originalEmail"]>,
	selfAddress?: string,
) {
	const toRecipients: string[] = [];
	const toSeen = new Set<string>();
	appendUniqueAddress(toRecipients, toSeen, original.sender, selfAddress);

	for (const recipient of splitEmailList(original.recipient)) {
		appendUniqueAddress(toRecipients, toSeen, recipient, selfAddress);
	}

	const ccRecipients: string[] = [];
	const ccSeen = new Set<string>();
	const normalizedSelf = selfAddress
		? normalizeRecipientAddress(selfAddress)
		: undefined;
	for (const recipient of splitEmailList(original.cc)) {
		const normalized = normalizeRecipientAddress(recipient);
		if (
			normalized === normalizedSelf ||
			toSeen.has(normalized) ||
			ccSeen.has(normalized)
		) {
			continue;
		}
		ccSeen.add(normalized);
		ccRecipients.push(recipient);
	}

	return {
		to: toRecipients.join(", "),
		cc: ccRecipients.join(", "),
		showCcBcc: true,
	};
}

/**
 * Convert plain Markdown / text into rich-text HTML for the editor.
 * Used when a Quick Reply chip injects a draft variant into the body.
 * We do NOT run a full Markdown parser; the variants are short reply
 * snippets and rendering them as paragraph blocks is sufficient.
 */
function prefilledBodyToHtml(prefilled: string): string {
	const safe = escapeHtml(prefilled.trim());
	if (!safe) return "";
	return safe
		.split(/\n{2,}/)
		.map((para) => `<p>${para.replace(/\n/g, "<br>")}</p>`)
		.join("");
}

function buildInitialComposeFields(
	composeOptions: ReturnType<typeof useUIStore.getState>["composeOptions"],
	mailboxEmail: string | undefined,
	sigBlock: string,
): ComposeFormFields {
	const {
		draftEmail: draft,
		originalEmail: original,
		mode,
		prefilledBody,
		prefilledTo,
	} = composeOptions;

	if (draft) {
		return {
			to: draft.recipient || "",
			cc: draft.cc || "",
			bcc: draft.bcc || "",
			showCcBcc: true,
			subject: draft.subject || "",
			body: draft.body || "",
		};
	}

	if (!original) {
		const baseBody = sigBlock ? `<p><br></p>${sigBlock}` : "";
		return {
			...EMPTY_FIELDS,
			to: prefilledTo ?? "",
			body: prefilledBody ? `${prefilledBodyToHtml(prefilledBody)}${baseBody}` : baseBody,
		};
	}

	const replyHead = prefilledBody ? prefilledBodyToHtml(prefilledBody) : "<p><br></p>";

	if (mode === "reply") {
		return {
			...EMPTY_FIELDS,
			to: original.sender,
			subject: getPrefixedSubject(original.subject, "Re"),
			body: `${replyHead}${sigBlock ? `${sigBlock}<br>` : ""}${buildQuotedReplyBlock(original.date, original.sender, original.body || "")}`,
		};
	}

	if (mode === "reply-all") {
		const recipients = buildReplyAllFields(original, mailboxEmail?.toLowerCase());
		return {
			...EMPTY_FIELDS,
			...recipients,
			subject: getPrefixedSubject(original.subject, "Re"),
			body: `${replyHead}${sigBlock ? `${sigBlock}<br>` : ""}${buildQuotedReplyBlock(original.date, original.sender, original.body || "")}`,
		};
	}

	if (mode === "forward") {
		return {
			...EMPTY_FIELDS,
			subject: getPrefixedSubject(original.subject, "Fwd"),
			body: buildForwardBody(original, sigBlock),
		};
	}

	return {
		...EMPTY_FIELDS,
		body: sigBlock ? `<p><br></p>${sigBlock}` : "",
	};
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	let binary = "";
	const chunkSize = 0x8000;
	for (let offset = 0; offset < bytes.length; offset += chunkSize) {
		const chunk = bytes.subarray(offset, offset + chunkSize);
		binary += String.fromCharCode(...chunk);
	}
	return btoa(binary);
}

async function fileToOutboundAttachment(file: File): Promise<WemailOutboundAttachment> {
	const id =
		typeof crypto !== "undefined" && "randomUUID" in crypto
			? crypto.randomUUID()
			: `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	return {
		id,
		filename: file.name || "attachment",
		mimetype: file.type || "application/octet-stream",
		size: file.size,
		dataBase64: arrayBufferToBase64(await file.arrayBuffer()),
	};
}

export function useComposeForm(mailboxId?: string, _folder?: string) {
	const composeOptions = useUIStore((state) => state.composeOptions);
	const closePanel = useUIStore((state) => state.closePanel);
	const closeCompose = useUIStore((state) => state.closeCompose);
	const { data: currentAccount } = useCurrentAccount();
	const activeAccountId = currentAccount?.account?.id ?? mailboxId;
	const { data: currentMailbox } = useMailbox(activeAccountId);
	const { preference: signaturePreference } =
		useAccountSignaturePreference(activeAccountId);
	const directoryName = useAccountDirectoryName(currentAccount?.account);
	const sendDraftMutation = useSendDraft();
	const saveDraftMutation = useSaveDraft();
	const ime = useImeComposition();

	const [to, setTo] = useState("");
	const [cc, setCc] = useState("");
	const [bcc, setBcc] = useState("");
	const [showCcBcc, setShowCcBcc] = useState(true);
	const [subject, setSubject] = useState("");
	const [body, setBody] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [isSavingDraft, setIsSavingDraft] = useState(false);
	const [isSending, setIsSending] = useState(false);
	const [attachments, setAttachments] = useState<WemailOutboundAttachment[]>([]);
	const [baselineSnapshot, setBaselineSnapshot] = useState("");
	const lastInitializedOptionsRef = useRef<typeof composeOptions | null>(null);
	const savedDraftIdRef = useRef<string | undefined>(undefined);
	const sendAttemptRef = useRef<{ snapshot: string; key: string } | undefined>(undefined);
	const lastSignatureIdentityRef = useRef<string | undefined>(undefined);
	const isDraftEdit = !!composeOptions.draftEmail;

	const formTitle = useMemo(() => {
		if (isDraftEdit) return "编辑草稿";
		switch (composeOptions.mode) { case "reply": return "回复"; case "reply-all": return "回复全部"; case "forward": return "转发"; default: return "新邮件"; }
	}, [composeOptions.mode, isDraftEdit]);

	const signatureIdentity = useMemo(
		() =>
			resolveSignatureText({
				customText: signaturePreference.customText,
				directoryName,
				displayName:
					currentAccount?.account?.displayName ?? currentMailbox?.name,
				emailAddress:
					currentAccount?.account?.emailAddress ?? currentMailbox?.email,
			}),
		[
			currentAccount?.account?.displayName,
			currentAccount?.account?.emailAddress,
			directoryName,
			currentMailbox?.email,
			currentMailbox?.name,
			signaturePreference.customText,
		],
	);
	const spellcheckExemptWords = useMemo(
		() =>
			buildComposeSpellcheckExemptWords({
				displayName:
					currentAccount?.account?.displayName ?? currentMailbox?.name,
				emailAddress:
					currentAccount?.account?.emailAddress ?? currentMailbox?.email,
			}),
		[
			currentAccount?.account?.displayName,
			currentAccount?.account?.emailAddress,
			currentMailbox?.email,
			currentMailbox?.name,
		],
	);
	const { data: editionInfo } = useQuery({
		queryKey: ["system", "edition"],
		queryFn: () => api.getEditionInfo(),
		staleTime: Number.POSITIVE_INFINITY,
		retry: 1,
	});
	const sigBlock = useMemo(
		() =>
			getSignatureBlock(
				{
					signature: {
						enabled: signaturePreference.enabled,
						text: signatureIdentity,
					},
				},
				editionInfo?.signatureBrandUrl || undefined,
			),
		[editionInfo?.signatureBrandUrl, signatureIdentity, signaturePreference.enabled],
	);

	useEffect(() => {
		if (lastInitializedOptionsRef.current === composeOptions) return;
		if (
			!composeOptions.draftEmail &&
			signaturePreference.enabled &&
			!signatureIdentity
		) {
			return;
		}
		lastInitializedOptionsRef.current = composeOptions;
		savedDraftIdRef.current = composeOptions.draftEmail?.id;
		sendAttemptRef.current = undefined;

		const initialFields = buildInitialComposeFields(
			composeOptions,
			currentMailbox?.email,
			sigBlock,
		);
		setError(null);
		setTo(initialFields.to);
		setCc(initialFields.cc);
		setBcc(initialFields.bcc);
		setShowCcBcc(initialFields.showCcBcc);
		setSubject(initialFields.subject);
		setBody(initialFields.body);
		const initialAttachments = (composeOptions.draftEmail?.attachments ?? []).filter(
				(attachment): attachment is WemailOutboundAttachment =>
					typeof (attachment as { dataBase64?: unknown }).dataBase64 === "string",
			);
		setAttachments(initialAttachments);
		setBaselineSnapshot(composeSnapshot(initialFields, initialAttachments));
	}, [
		composeOptions,
		currentMailbox?.email,
		sigBlock,
		signatureIdentity,
		signaturePreference.enabled,
	]);

	const addAttachments = async (files: FileList | File[]) => {
		const list = Array.from(files);
		if (list.length === 0) return;

		let nextTotal = attachments.reduce((sum, item) => sum + item.size, 0);
		for (const file of list) {
			if (file.size > MAX_ATTACHMENT_BYTES) {
				const message = "单个附件不能超过 10 MB";
				setError(message);
				toast.error(message);
				throw new Error(message);
			}
			nextTotal += file.size;
			if (nextTotal > MAX_TOTAL_ATTACHMENT_BYTES) {
				const message = "附件总大小不能超过 25 MB";
				setError(message);
				toast.error(message);
				throw new Error(message);
			}
		}

		try {
			const uploaded = await Promise.all(list.map(fileToOutboundAttachment));
			setAttachments((items) => [...items, ...uploaded]);
		} catch (err) {
			const message = getUserFacingError(err, "附件读取失败，请重新选择文件。");
			setError(message);
			toast.error(message);
			throw err;
		}
	};

	const addAttachmentFromFile = async (file: File) => {
		await addAttachments([file]);
	};

	const removeAttachment = (target: string | number) => {
		setAttachments((items) => items.filter((item, index) => (
			typeof target === "number" ? index !== target : item.id !== target
		)));
	};

	/**
	 * Build the canonical `WemailDraftInput` for the desktop server's
	 * canonical outbox. Returns null
	 * when required fields are missing — callers surface their own
	 * errors so we don't toast twice.
	 *
	 * `accountId` is the active mailboxId (the desktop server resolves
	 * the active account by id). `originalEmailId` doubles as the
	 * reply/forward pointer; it does not currently establish SMTP reply
	 * threading. We don't carry `from` in the payload — the provider
	 * fills it from the account's IMAP/SMTP profile.
	 */
	const buildDraftInput = (): WemailDraftInput | null => {
		if (!activeAccountId) return null;
		const toAddrs = parseAddressList(to);
		if (toAddrs.length === 0) return null;
		const saveInput = buildDraftSaveInput();
		if (!saveInput) return null;
		return {
			...saveInput,
			to: toAddrs,
		};
	};

	const buildDraftSaveInput = (): WemailDraftSaveInput | null => {
		if (!activeAccountId) return null;
		const originalEmailId =
			composeOptions.originalEmail?.id ||
			composeOptions.draftEmail?.in_reply_to ||
			undefined;
		const threadId =
			composeOptions.originalEmail?.thread_id ||
			composeOptions.draftEmail?.thread_id ||
			undefined;
		return {
			id: savedDraftIdRef.current,
			accountId: activeAccountId,
			composeType: composeOptions.mode === "forward" ? "forward" :
				composeOptions.mode === "reply" || composeOptions.mode === "reply-all" ? "reply" : "new",
			originalEmailId,
			threadId,
			to: parseAddressList(to),
			cc: parseAddressList(cc),
			bcc: parseAddressList(bcc),
			subject,
			bodyText: htmlToPlainText(body),
			bodyHtml: body,
			attachments,
		};
	};

	const currentSnapshot = composeSnapshot(
		{ to, cc, bcc, showCcBcc, subject, body },
		attachments,
	);
	const isDirty = baselineSnapshot !== "" && currentSnapshot !== baselineSnapshot;
	const rememberSavedDraft = (id: string) => {
		if (lastInitializedOptionsRef.current === composeOptions) savedDraftIdRef.current = id;
	};

	useEffect(() => {
		const previousIdentity = lastSignatureIdentityRef.current;
		lastSignatureIdentityRef.current = signatureIdentity;
		if (previousIdentity === undefined || previousIdentity === signatureIdentity) {
			return;
		}
		if (composeOptions.draftEmail || !signaturePreference.enabled || isDirty) {
			return;
		}

		const initialFields = buildInitialComposeFields(
			composeOptions,
			currentMailbox?.email,
			sigBlock,
		);
		setBody(initialFields.body);
		setBaselineSnapshot(composeSnapshot(initialFields, attachments));
	}, [
		attachments,
		composeOptions,
		currentMailbox?.email,
		isDirty,
		sigBlock,
		signatureIdentity,
		signaturePreference.enabled,
	]);

	const handleSaveDraft = async (): Promise<boolean> => {
		if (!activeAccountId || isSending || isSavingDraft) return false;
		if (attachments.length > 0) {
			const message = "暂不支持保存含附件的草稿，请先移除附件。";
			setError(message);
			toast.error(message);
			return false;
		}
		setIsSavingDraft(true);
		setError(null);
		try {
			const draft = buildDraftSaveInput();
			if (!draft) {
				setError("没有可用的邮箱账号。");
				return false;
			}
			const saved = await saveDraftMutation.mutateAsync(draft);
			rememberSavedDraft(saved.draft.id);
			setBaselineSnapshot(currentSnapshot);
			toast.success("草稿已保存");
			return true;
		}
		catch (err: unknown) {
			const message = getComposeError(err, "草稿保存失败，请稍后重试。");
			setError(message);
			toast.error(message);
			return false;
		}
		finally {
			setIsSavingDraft(false);
		}
	};

	/** Undo-send hold before the draft is handed to the outbox.
	 *  ponytail: client-side hold only — closing the app inside the window leaves
	 *  the mail as a saved draft (content preserved); server-side deferred
	 *  dequeue is the designed upgrade path. */
	const UNDO_SEND_WINDOW_MS = 5000;

	const handleSend = async (e: FormEvent, onClose: () => void) => {
		e.preventDefault();
		// IME safety: if the user is mid-composition (e.g. Pinyin), bail.
		// Consumers that wire Cmd/Ctrl+Enter to this handler MUST also
		// guard via `imeComposingRef`, but we double-check here as a
		// defence in depth.
		if (ime.isComposingRef.current) return;
		if (isSending || isSavingDraft) return;
		setError(null);
		if (!activeAccountId) {
			setError("没有可用的邮箱账号。");
			return;
		}
		if (splitEmailList(to).length === 0) {
			setError("请至少添加一个收件人。");
			return;
		}
		if (attachments.length > 0) {
			setError("暂不支持发送附件，请先移除附件。");
			return;
		}
		const draft = buildDraftInput();
		if (!draft) {
			setError("请至少添加一个收件人。");
			return;
		}
		const draftId = savedDraftIdRef.current;
		const payload = { ...draft, ...(draftId ? { draftId } : {}) };
		const snapshot = JSON.stringify(payload);
		if (sendAttemptRef.current?.snapshot !== snapshot) {
			sendAttemptRef.current = { snapshot, key: `send:${activeAccountId}:${crypto.randomUUID()}` };
		}
		const idempotencyKey = sendAttemptRef.current.key;

		// Persist the draft first so 撤销 (and any later send failure) keeps content.
		setIsSending(true);
		let savedDraftId: string | undefined = draftId;
		try {
			const savePayload = buildDraftSaveInput();
			if (!savePayload) {
				setError("请至少添加一个收件人。");
				setIsSending(false);
				return;
			}
			const saveRes = await saveDraftMutation.mutateAsync({ ...savePayload, accountId: activeAccountId });
			savedDraftId = saveRes.draft.id;
			rememberSavedDraft(savedDraftId);
		} catch (err: unknown) {
			const message = getComposeSubmitError(err, "草稿保存失败，请检查网络后重试。");
			setError(message);
			toast.error(message);
			setIsSending(false);
			return;
		}
		setIsSending(false);
		onClose();

		const deliverNow = async () => {
			try {
				await sendDraftMutation.mutateAsync({
					...payload,
					draftId: savedDraftId,
					idempotencyKey,
				});
				sendAttemptRef.current = undefined;
				toast.success("邮件已加入发件队列");
			} catch (err: unknown) {
				if (activeAccountId && isCredentialError(err)) {
					// Expired/rejected password mid-session: open the update-password
					// dialog instead of a dead-end toast. The draft stays in 草稿箱.
					dispatchMailAuthRequired({
						accountId: activeAccountId,
						code: MAIL_CREDENTIAL_INVALID,
						source: "send",
					});
					setError("邮箱密码已过期或已失效，请在弹窗中更新密码。");
					toast.error("邮箱密码已过期或已失效，请在弹窗中更新密码；邮件已保留为草稿。");
					return;
				}
				const message = getComposeSubmitError(
					err,
					"邮件发送失败，邮件已保留为草稿，可从草稿箱重试。",
				);
				setError(message);
				toast.error(message);
			}
		};

		// Undo window: hold the actual enqueue for 5s; 撤销 keeps it as a draft.
		let cancelled = false;
		toast.loading("正在发送…", {
			duration: UNDO_SEND_WINDOW_MS,
			action: {
				label: "撤销",
				onClick: () => {
					cancelled = true;
					sendAttemptRef.current = undefined;
					toast.success("已撤销发送，内容保留在草稿箱");
				},
			},
		});
		window.setTimeout(() => {
			if (cancelled) return;
			void deliverNow();
		}, UNDO_SEND_WINDOW_MS);
	};

	return {
		to, setTo, cc, setCc, bcc, setBcc, showCcBcc, setShowCcBcc,
		subject, setSubject, body, setBody, error, setError,
		attachments, addAttachments, removeAttachment,
		isSavingDraft, isSending, formTitle, handleSaveDraft, handleSend,
		addAttachmentFromFile,
		maxAttachmentBytes: MAX_ATTACHMENT_BYTES,
		maxTotalAttachmentBytes: MAX_TOTAL_ATTACHMENT_BYTES,
		buildDraftInput, buildDraftSaveInput, rememberSavedDraft,
		isDirty,
		spellcheckExemptWords,
		closeCompose, closePanel,
		// IME composition handlers — spread onto the body editor / inputs
		// and consult `imeComposingRef.current` from any Cmd/Ctrl+Enter
		// keydown handler before invoking `handleSend`.
		onCompositionStart: ime.onCompositionStart,
		onCompositionEnd: ime.onCompositionEnd,
		isImeComposing: ime.isComposing,
		imeComposingRef: ime.isComposingRef,
	};
}
