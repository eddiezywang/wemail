// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Compose form body — shared by the single floating ComposePanel for new
 * mail, replies, reply-all, and forwards.
 *
 * The component renders a complete `<form>` with recipient stack,
 * RichTextEditor, AiPromptBar and footer. The chrome surrounding it
 * (window title bar, drag handle, send pill) is supplied by the
 * caller via `renderHeader`. The header receives form state so it can
 * show "发送中…", disable Save Draft etc.
 *
 * Header send buttons are bound to the form natively via the HTML
 * `form="<id>"` attribute, so submit works regardless of DOM
 * nesting. A `wemail:compose-send` window event also triggers submit
 * (driven by the global Cmd+Enter shortcut).
 */

import { useEffect, useId, useRef, useState } from "react";
import { FloppyDiskIcon } from "@phosphor-icons/react/FloppyDisk";
import { PaperclipIcon } from "@phosphor-icons/react/Paperclip";
import { TextAaIcon } from "@phosphor-icons/react/TextAa";
import { XIcon } from "@phosphor-icons/react/X";
import { ClockIcon } from "@phosphor-icons/react/Clock";
import { useParams } from "react-router";
import { toast } from "sonner";
import { useComposeForm } from "~/hooks/useComposeForm";
import { Button } from "~/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import RichTextEditor from "~/components/RichTextEditor";
import { AiPromptBar } from "~/components/compose/AiPromptBar";
import type { AiPromptBarHandle } from "~/components/compose/AiPromptBar";
import { DirectoryRecipientInput } from "~/components/compose/DirectoryRecipientInput";
import { hasEditableComposeContent } from "~/components/compose/composeAiBody";
import { useUIStore } from "~/hooks/useUIStore";
import { useScheduleDraft } from "~/queries/scheduledDrafts";
import api from "~/services/api";
import { useCurrentAccount } from "~/queries/currentAccount";
import SnoozeMenu from "~/components/SnoozeMenu";
import { getUserFacingError } from "~/lib/user-facing-error";

export interface ComposeBodyHeaderState {
	formTitle: string;
	isSending: boolean;
	isSavingDraft: boolean;
	/** Bind a chrome-rendered submit button to the form natively. */
	formId: string;
	closeCompose: () => void;
	handleSchedule: (sendAt: Date) => Promise<void>;
	suggestedSendAt: Date | null;
}

interface ComposeBodyProps {
	renderHeader: (state: ComposeBodyHeaderState) => React.ReactNode;
}

function formatFileSize(size: number) {
	if (size < 1024) return `${size} B`;
	if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
	return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

export default function ComposeBody({ renderHeader }: ComposeBodyProps) {
	const { mailboxId, folder } = useParams<{
		mailboxId: string;
		folder: string;
	}>();
	const formId = useId();
	const {
		to,
		setTo,
		cc,
		setCc,
		bcc,
		setBcc,
		showCcBcc,
		setShowCcBcc,
		subject,
		setSubject,
		body,
		setBody,
		attachments,
		addAttachments,
		removeAttachment,
		error,
		isSavingDraft,
		isSending,
		formTitle,
		handleSaveDraft,
		handleSend,
		addAttachmentFromFile,
		buildDraftInput,
		buildDraftSaveInput,
		spellcheckExemptWords,
		closeCompose,
		isDirty,
	} = useComposeForm(mailboxId, folder);

	const composeOptions = useUIStore((state) => state.composeOptions);
	const { data: currentAccount } = useCurrentAccount();
	const accountId = currentAccount?.account?.id ?? mailboxId;
	const scheduleDraftMut = useScheduleDraft();
	const formRef = useRef<HTMLFormElement | null>(null);
	const attachmentInputRef = useRef<HTMLInputElement | null>(null);
	const aiPromptRef = useRef<AiPromptBarHandle | null>(null);
	const [formattingOpen, setFormattingOpen] = useState(false);
	const [suggestedSendAt, setSuggestedSendAt] = useState<Date | null>(null);
	const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false);
	const requestClose = () => {
		if (isDirty) {
			setDiscardConfirmOpen(true);
			return;
		}
		closeCompose();
	};
	const saveAndClose = async () => {
		if (await handleSaveDraft()) {
			setDiscardConfirmOpen(false);
			closeCompose();
		}
	};

	useEffect(() => {
		const handler = () => formRef.current?.requestSubmit();
		window.addEventListener("wemail:compose-send", handler);
		return () => window.removeEventListener("wemail:compose-send", handler);
	}, []);

	const handleSchedule = async (sendAt: Date) => {
		if (!accountId) {
			toast.error("没有可用的邮箱账号");
			return;
		}
		const draftPayload = buildDraftInput();
		const savePayload = buildDraftSaveInput();
		if (!draftPayload || !savePayload) {
			toast.error("请填写收件人");
			return;
		}
		try {
			const saveRes = await api.saveWemailDraft({
				...savePayload,
				accountId,
			});
			const draftId = saveRes.draft.id;
			await scheduleDraftMut.mutateAsync({
				draftId,
				sendAt: sendAt.toISOString(),
				payload: { ...draftPayload, accountId },
			});
			toast.success(`已安排在 ${sendAt.toLocaleString()} 发送`);
			closeCompose();
		} catch (err) {
			toast.error(getUserFacingError(err, "定时发送失败，请稍后重试。"));
		}
	};

	const handleAttachmentFiles = async (files: FileList | null) => {
		if (!files || files.length === 0) return;
		await addAttachments(files);
		if (attachmentInputRef.current) {
			attachmentInputRef.current.value = "";
		}
	};

	return (
		<>
			{renderHeader({
				formTitle,
				isSending,
				isSavingDraft,
				formId,
				closeCompose: requestClose,
				handleSchedule,
				suggestedSendAt,
			})}

			<form
				id={formId}
				ref={formRef}
				onSubmit={(e) => handleSend(e, closeCompose)}
				className="flex flex-col flex-1 min-h-0 overflow-hidden"
			>
				{error ? (
					<div
						role="alert"
						className="mx-3 mt-3 rounded-md border border-red bg-red-bg/40 px-3 py-2 text-xs text-ink"
					>
						{error}
					</div>
				) : null}

				{/* Recipient stack */}
				<div className="px-4 pt-3 pb-2 space-y-2 shrink-0 border-b border-edge-3">
					<RecipientRow label="收件人">
						<DirectoryRecipientInput
							value={to}
							onChange={setTo}
							ariaLabel="收件人"
						/>
						{!showCcBcc ? (
							<button
								type="button"
								onClick={() => setShowCcBcc(true)}
								className="shrink-0 text-meta font-medium text-coral hover:text-coral-2"
							>
								CC / BCC
							</button>
						) : null}
					</RecipientRow>
					{showCcBcc ? (
						<>
							<RecipientRow label="抄送">
								<DirectoryRecipientInput
									value={cc}
									onChange={setCc}
									ariaLabel="抄送"
								/>
							</RecipientRow>
							<RecipientRow label="密送">
								<DirectoryRecipientInput
									value={bcc}
									onChange={setBcc}
									ariaLabel="密送"
								/>
							</RecipientRow>
						</>
					) : null}
					<RecipientRow label="主题">
						<Input
							type="text"
							aria-label="主题"
							className="h-8 rounded-md border-x-0 border-t-0 border-b border-edge bg-transparent px-0 text-body font-medium shadow-none transition-[border-color,background-color] duration-150 focus:border-coral focus-visible:border-coral focus-visible:ring-0"
							value={subject}
							onChange={(e) => setSubject(e.target.value)}
							required
						/>
					</RecipientRow>
				</div>
				{suggestedSendAt ? (
					<div className="flex shrink-0 items-center gap-2 border-b border-edge-3 bg-coral/5 px-4 py-2 text-xs text-ink-2" data-testid="compose-suggested-send-time">
						<ClockIcon size={14} className="text-coral" />
						<span className="flex-1">计划发送：{suggestedSendAt.toLocaleString()}</span>
						<SnoozeMenu title="修改发送时间" customDefault={suggestedSendAt} onPick={setSuggestedSendAt}>
							<button type="button" className="font-medium text-coral hover:underline">修改</button>
						</SnoozeMenu>
						<button type="button" onClick={() => setSuggestedSendAt(null)} className="text-ink-3 hover:text-ink">清除</button>
					</div>
				) : null}

				{/* Body */}
				<div className="flex-1 min-h-0 overflow-y-auto">
					<RichTextEditor
						value={body}
						onChange={setBody}
						toolbarVisible={formattingOpen}
						composeSurface
						spellcheckExemptWords={spellcheckExemptWords}
						emptyGuidance={
							!hasEditableComposeContent(body) ? (
								<span className="rounded-md px-1.5 py-1 text-body text-ink-3">
									<span>开始输入或</span>{" "}
									<button
										type="button"
										onClick={() => aiPromptRef.current?.focus()}
										className="pointer-events-auto font-medium text-coral underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/30"
									>
										使用 AI 写作
									</button>
								</span>
							) : undefined
						}
					/>
				</div>

				<AiPromptBar
					ref={aiPromptRef}
					accountId={accountId}
					mode={composeOptions.mode}
					originalEmailId={
						composeOptions.originalEmail?.id ??
						composeOptions.draftEmail?.in_reply_to ??
						undefined
					}
					currentTo={to}
					currentCc={cc}
					currentBcc={bcc}
					currentSubject={subject}
					currentBody={body}
					onApply={(patch) => {
						setBody(patch.bodyHtml);
						if (patch.subject) setSubject(patch.subject);
						if (patch.to && patch.to.length > 0) {
							setTo(patch.to.join(", "));
						} else if (patch.to) {
							setTo("");
						}
						if (patch.cc && patch.cc.length > 0) {
							setShowCcBcc(true);
							setCc(patch.cc.join(", "));
						} else if (patch.cc) {
							setCc("");
						}
						if (patch.bcc && patch.bcc.length > 0) {
							setShowCcBcc(true);
							setBcc(patch.bcc.join(", "));
						} else if (patch.bcc) {
							setBcc("");
						}
						if (patch.suggestedSendAt) setSuggestedSendAt(new Date(patch.suggestedSendAt));
					}}
				/>

				{attachments.length > 0 ? (
					<div className="border-t border-edge bg-paper px-3 py-2 shrink-0">
						<div className="flex flex-wrap gap-2">
							{attachments.map((attachment) => (
								<div
									key={attachment.id}
									className="inline-flex max-w-full items-center gap-2 rounded-md border border-edge bg-paper-2 px-2 py-1 text-xs text-ink"
								>
									<PaperclipIcon size={13} className="shrink-0 text-ink-3" />
									<span className="max-w-48 truncate font-medium">
										{attachment.filename}
									</span>
									<span className="shrink-0 text-ink-3">
										{formatFileSize(attachment.size)}
									</span>
									<button
										type="button"
										onClick={() => removeAttachment(attachment.id)}
										className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-ink-3 hover:bg-paper-3 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
										aria-label={`移除附件 ${attachment.filename}`}
										title="移除附件"
									>
										<XIcon size={12} />
									</button>
								</div>
							))}
						</div>
					</div>
				) : null}

				{/* Footer: discard + save draft */}
				<div className="px-3 py-2 border-t border-edge bg-paper-2 flex items-center justify-between shrink-0">
					<div className="flex items-center gap-1">
						<Button
							type="button"
							variant={formattingOpen ? "secondary" : "ghost"}
							size="sm"
							onClick={() => setFormattingOpen((open) => !open)}
							disabled={isSending}
							title={formattingOpen ? "隐藏格式工具" : "显示格式工具"}
							aria-label={formattingOpen ? "隐藏格式工具" : "显示格式工具"}
							className="h-8 w-8 rounded-full p-0"
						>
							<TextAaIcon size={16} />
						</Button>
						<Button
							type="button"
							variant="ghost"
							size="sm"
							onClick={requestClose}
							disabled={isSending}
						>
							丢弃
						</Button>
						<input
							ref={attachmentInputRef}
							type="file"
							multiple
							className="hidden"
							onChange={(event) => {
								void handleAttachmentFiles(event.currentTarget.files);
							}}
						/>
						<Button
							type="button"
							variant="ghost"
							size="sm"
							onClick={() => attachmentInputRef.current?.click()}
							disabled={isSending}
							title="添加附件"
							aria-label="添加附件"
							className="px-2"
						>
							<PaperclipIcon size={15} />
						</Button>
					</div>
					<Button
						type="button"
						variant="secondary"
						size="sm"
						loading={isSavingDraft}
						disabled={isSending}
						onClick={handleSaveDraft}
					>
						<FloppyDiskIcon size={14} />
						{isSavingDraft ? "保存中…" : "保存草稿"}
					</Button>
				</div>
			</form>
			<Dialog open={discardConfirmOpen} onOpenChange={setDiscardConfirmOpen}>
				<DialogContent className="max-w-[440px]">
					<DialogTitle>保存这封邮件吗？</DialogTitle>
					<DialogDescription>
						邮件内容尚未保存。你可以保存为草稿后关闭，或放弃本次修改。
					</DialogDescription>
					<DialogFooter className="flex-wrap gap-2 sm:justify-end">
						<Button variant="ghost" onClick={() => setDiscardConfirmOpen(false)}>
							继续编辑
						</Button>
						<Button variant="secondary" loading={isSavingDraft} onClick={() => void saveAndClose()}>
							保存草稿并关闭
						</Button>
						<Button
							variant="destructive"
							onClick={() => {
								setDiscardConfirmOpen(false);
								closeCompose();
							}}
						>
							放弃修改
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
}

function RecipientRow({
	label,
	children,
}: {
	label: string;
	children: React.ReactNode;
}) {
	return (
		<div className="flex items-center gap-3">
			<span className="w-12 shrink-0 text-meta font-medium text-ink-3">
				{label}
			</span>
			<div className="flex-1 flex items-center gap-2 min-w-0">{children}</div>
		</div>
	);
}
