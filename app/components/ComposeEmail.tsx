// Copyright (c) 2026 Cloudflare, Inc.
// Modified for WeMail.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { FloppyDiskIcon } from "@phosphor-icons/react/FloppyDisk";
import { PaperPlaneTiltIcon } from "@phosphor-icons/react/PaperPlaneTilt";
import { PaperclipIcon } from "@phosphor-icons/react/Paperclip";
import { XIcon } from "@phosphor-icons/react/X";
import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router";
import { useComposeForm } from "~/hooks/useComposeForm";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogTitle,
} from "~/components/ui/dialog";
import RichTextEditor from "./RichTextEditor";
import { useUIStore } from "~/hooks/useUIStore";
import { formatBytes } from "~/lib/utils";
import { trackTelemetry } from "~/lib/telemetry";

interface LabeledInputProps extends React.InputHTMLAttributes<HTMLInputElement> {
	label: string;
}

function LabeledInput({ label, id, ...props }: LabeledInputProps) {
	const inputId = id ?? `compose-${label.toLowerCase()}`;
	return (
		<div>
			<label
				htmlFor={inputId}
				className="block text-sm font-medium text-ink mb-1.5"
			>
				{label}
			</label>
			<Input id={inputId} className="h-8 text-sm" {...props} />
		</div>
	);
}

export default function ComposeEmail() {
	const { mailboxId, folder } = useParams<{
		mailboxId: string;
		folder: string;
	}>();

	const isComposeModalOpen = useUIStore((state) => state.isComposeModalOpen);
	const composeOptions = useUIStore((state) => state.composeOptions);
	const closeComposeModal = useUIStore((state) => state.closeComposeModal);
	useEffect(() => {
		if (!isComposeModalOpen) return;
		trackTelemetry("wemail_compose_opened", {
			compose_mode: composeOptions.mode ?? "new",
			source: "renderer",
		});
	}, [composeOptions.mode, isComposeModalOpen]);

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
		spellcheckExemptWords,
		isDirty,
	} = useComposeForm(mailboxId, folder);
	const attachmentInputRef = useRef<HTMLInputElement | null>(null);
	const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false);
	const requestClose = () => {
		if (isDirty) {
			setDiscardConfirmOpen(true);
			return;
		}
		closeComposeModal();
	};
	const saveAndClose = async () => {
		if (await handleSaveDraft()) {
			setDiscardConfirmOpen(false);
			closeComposeModal();
		}
	};

	return (
		<>
			<Dialog
				open={isComposeModalOpen}
				onOpenChange={(open) => !open && !isSending && requestClose()}
			>
			<DialogContent className="max-w-2xl p-6 max-h-[85vh] overflow-y-auto">
				<DialogTitle className="text-lg font-semibold mb-5">
					{formTitle}
				</DialogTitle>
				<form onSubmit={(e) => handleSend(e, closeComposeModal)} className="space-y-4">
					{error && (
						<div
							role="alert"
							className="rounded-md border border-red bg-red-bg/40 px-3 py-2 text-sm text-ink"
						>
							{error}
						</div>
					)}
					<div className="flex items-end gap-2">
						<div className="flex-1">
							<LabeledInput
								label="收件人"
								type="text"
								placeholder="name@example.com，多个地址用逗号分隔"
								value={to}
								onChange={(e) => setTo(e.target.value)}
								required
							/>
						</div>
						{!showCcBcc && (
							<button
								type="button"
								onClick={() => setShowCcBcc(true)}
								className="shrink-0 text-xs text-coral hover:text-coral-2 font-medium mb-2"
							>
								CC / BCC
							</button>
						)}
					</div>
					{showCcBcc && (
						<LabeledInput
							label="抄送"
							type="text"
							value={cc}
							onChange={(e) => setCc(e.target.value)}
							placeholder="多个地址用逗号分隔"
						/>
					)}
					{showCcBcc && (
						<LabeledInput
							label="密送"
							type="text"
							value={bcc}
							onChange={(e) => setBcc(e.target.value)}
							placeholder="多个地址用逗号分隔"
						/>
					)}
					<LabeledInput
						label="主题"
						type="text"
						placeholder="邮件主题"
						value={subject}
						onChange={(e) => setSubject(e.target.value)}
						required
					/>
					<div>
						<span className="block text-sm font-medium mb-1.5 text-ink">
							正文
						</span>
						<RichTextEditor
							value={body}
							onChange={setBody}
							spellcheckExemptWords={spellcheckExemptWords}
						/>
					</div>
					<div className="space-y-2">
						<input
							ref={attachmentInputRef}
							type="file"
							multiple
							className="hidden"
							onChange={async (event) => {
								if (!event.target.files?.length) return;
								await addAttachments(event.target.files);
								event.target.value = "";
							}}
						/>
						<Button
							type="button"
							variant="ghost"
							size="sm"
							onClick={() => attachmentInputRef.current?.click()}
						>
							<PaperclipIcon size={14} />
							添加附件
						</Button>
						{attachments.length > 0 ? (
							<div className="flex flex-wrap gap-2">
								{attachments.map((attachment, index) => (
									<div
										key={`${attachment.filename}-${attachment.size}-${index}`}
										className="inline-flex items-center gap-2 rounded-full border border-edge bg-paper-2 px-2.5 py-1 text-xs text-ink"
									>
										<span className="max-w-[220px] truncate">
											{attachment.filename}
										</span>
										<span className="text-ink-3">
											{formatBytes(attachment.size)}
										</span>
										<button
											type="button"
											aria-label={`移除附件 ${attachment.filename}`}
											onClick={() => removeAttachment(index)}
											className="inline-flex h-8 w-8 items-center justify-center rounded-full text-ink-3 hover:bg-paper-3 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
										>
											<XIcon size={10} weight="bold" />
										</button>
									</div>
								))}
							</div>
						) : null}
					</div>
					<div className="flex justify-between items-center pt-2">
						<Button
							type="button"
							variant="ghost"
							size="sm"
							onClick={requestClose}
							disabled={isSending}
						>
							丢弃
						</Button>
						<div className="flex items-center gap-2">
							<Button
								type="button"
								variant="secondary"
								size="sm"
								loading={isSavingDraft}
								disabled={isSending}
								onClick={handleSaveDraft}
							>
								<FloppyDiskIcon size={14} />
								{isSavingDraft ? "保存中..." : "保存草稿"}
							</Button>
							<Button
								type="submit"
								variant="default"
								size="sm"
								loading={isSending}
								disabled={isSavingDraft || isSending}
							>
								<PaperPlaneTiltIcon size={14} />
								{isSending ? "发送中..." : "发送"}
							</Button>
						</div>
					</div>
				</form>
			</DialogContent>
			</Dialog>
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
						<Button
							variant="secondary"
							loading={isSavingDraft}
							onClick={() => void saveAndClose()}
						>
							保存草稿并关闭
						</Button>
						<Button
							variant="destructive"
							onClick={() => {
								setDiscardConfirmOpen(false);
								closeComposeModal();
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
