// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useState } from "react";
import { DownloadSimpleIcon } from "@phosphor-icons/react/DownloadSimple";
import { EyeIcon } from "@phosphor-icons/react/Eye";
import { FileIcon } from "@phosphor-icons/react/File";
import { ImageIcon } from "@phosphor-icons/react/Image";
import { PaperclipIcon } from "@phosphor-icons/react/Paperclip";
import { ArrowsClockwiseIcon } from "@phosphor-icons/react/ArrowsClockwise";
import { toast } from "sonner";
import { Button } from "~/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogTitle,
} from "~/components/ui/dialog";
import {
	downloadFile,
	formatBytes,
	getAttachmentUrl,
	getNonInlineAttachments,
} from "~/lib/utils";
import type { Attachment } from "~/types";
import type {
	InvoiceAttachmentStatus,
	InvoiceAttachmentStatusValue,
	InvoiceMailStatusSummary,
} from "~/types/wemail";
import { getUserFacingError } from "~/lib/user-facing-error";
import { useEditionFeatures } from "~/hooks/useEditionFeatures";

interface EmailAttachmentListProps {
	mailboxId?: string;
	emailId: string;
	attachments?: Attachment[];
	invoiceStatus?: InvoiceMailStatusSummary | null;
	onRefreshInvoiceStatus?: () => void;
	isRefreshingInvoiceStatus?: boolean;
	invoiceRefreshMessage?: string;
	onPreviewImage?: (url: string, filename: string) => void;
	className?: string;
	showHeading?: boolean;
}

export default function EmailAttachmentList({
	mailboxId,
	emailId,
	attachments,
	invoiceStatus,
	onRefreshInvoiceStatus,
	isRefreshingInvoiceStatus = false,
	invoiceRefreshMessage,
	onPreviewImage,
	className,
	showHeading = false,
}: EmailAttachmentListProps) {
	const [pendingDownload, setPendingDownload] = useState<{
		attachment: Attachment;
		url: string;
	} | null>(null);
	// P2.6: the invoice platform status (badges, refresh, messages) is an
	// edition module capability. Without the feature the props collapse to
	// unset and the whole invoice surface stays hidden.
	const { allowanceInvoice } = useEditionFeatures();
	const effectiveInvoiceStatus = allowanceInvoice ? invoiceStatus : null;
	const effectiveRefreshInvoiceStatus = allowanceInvoice ? onRefreshInvoiceStatus : undefined;
	const effectiveInvoiceRefreshMessage = allowanceInvoice ? invoiceRefreshMessage : undefined;

	if (!mailboxId) return null;

	const files = getNonInlineAttachments(attachments);
	if (files.length === 0 && !effectiveRefreshInvoiceStatus && !effectiveInvoiceRefreshMessage) return null;
	const invoiceStatusByAttachment = new Map(
		(effectiveInvoiceStatus?.statuses ?? []).map((status) => [status.attachmentId, status]),
	);

	const handleConfirmDownload = () => {
		if (!pendingDownload) return;
		const { attachment, url } = pendingDownload;
		setPendingDownload(null);
		void downloadFile(url, attachment.filename)
			.then(() => {
				toast.success("附件下载已开始");
			})
			.catch((err) => {
				toast.error(getUserFacingError(err, "附件下载失败，请稍后重试。"));
			});
	};

	return (
		<div className={className}>
			{showHeading && (
				<div className="flex items-center gap-2 mb-2">
					<div className="flex min-w-0 items-center gap-2">
						<PaperclipIcon size={14} className="text-ink-3" />
						<span className="text-sm font-medium text-ink">
							{files.length > 0 ? `${files.length} 个附件` : "发票平台状态"}
						</span>
						{effectiveRefreshInvoiceStatus ? (
							<button
								type="button"
								onClick={effectiveRefreshInvoiceStatus}
								disabled={isRefreshingInvoiceStatus}
								className="inline-flex min-h-8 items-center gap-1 rounded-md px-2 text-xs text-ink-3 hover:bg-paper-3 hover:text-ink disabled:opacity-50"
								aria-label="刷新发票平台状态"
							>
								<ArrowsClockwiseIcon size={13} className={isRefreshingInvoiceStatus ? "animate-spin motion-reduce:animate-none" : ""} />
								{isRefreshingInvoiceStatus ? "正在查询平台…" : "刷新平台状态"}
							</button>
						) : null}
					</div>
				</div>
			)}
			{effectiveInvoiceRefreshMessage ? <div role="status" className="mb-2 rounded-md border border-edge bg-paper-2 px-3 py-2 text-xs text-ink-2">
				{effectiveInvoiceRefreshMessage}
			</div> : null}
			<div className="flex flex-wrap gap-2">
				{files.map((attachment) => {
					const url = getAttachmentUrl(mailboxId, emailId, attachment.id);
					const isImage = attachment.mimetype?.startsWith("image/");
					const attachmentInvoiceStatus = invoiceStatusByAttachment.get(attachment.id);

					return (
						<div
							key={attachment.id}
							className="group flex min-w-[220px] max-w-full items-center gap-2 rounded-lg border border-edge bg-paper px-2.5 py-2 text-sm shadow-[var(--shadow-1)] transition-colors hover:bg-paper-2"
						>
							<button
								type="button"
								onClick={() => setPendingDownload({ attachment, url })}
								className="flex min-w-0 flex-1 items-center gap-2 text-left"
								aria-label={`下载附件 ${attachment.filename}`}
							>
								<span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-paper-3 text-ink-3 group-hover:text-coral">
									{isImage ? (
										<ImageIcon size={17} weight="regular" />
									) : (
										<FileIcon size={17} weight="regular" />
									)}
								</span>
								<span className="min-w-0">
									<span className="block max-w-[190px] truncate font-medium text-ink">
										{attachment.filename}
									</span>
									<span className="block text-xs text-ink-3">
										{formatBytes(attachment.size)} · 点击下载
									</span>
									{attachmentInvoiceStatus ? (
										<InvoiceAttachmentStatusLabel status={attachmentInvoiceStatus} />
									) : null}
								</span>
							</button>
							{isImage && onPreviewImage ? (
								<button
									type="button"
									onClick={() => onPreviewImage(url, attachment.filename)}
									className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-ink-3 hover:bg-paper-3 hover:text-ink"
									aria-label={`预览附件 ${attachment.filename}`}
								>
									<EyeIcon size={16} />
								</button>
							) : null}
							<button
								type="button"
								onClick={() => setPendingDownload({ attachment, url })}
								className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-ink-3 hover:bg-paper-3 hover:text-coral"
								aria-label={`下载 ${attachment.filename}`}
							>
								<DownloadSimpleIcon size={16} />
							</button>
						</div>
					);
				})}
			</div>
			<Dialog
				open={!!pendingDownload}
				onOpenChange={(open) => {
					if (!open) setPendingDownload(null);
				}}
			>
				<DialogContent className="max-w-[380px]">
					<div className="space-y-2">
						<DialogTitle>下载附件？</DialogTitle>
						<DialogDescription>
							将下载“{pendingDownload?.attachment.filename}”
							{pendingDownload?.attachment.size
								? `（${formatBytes(pendingDownload.attachment.size)}）`
								: ""}
							到本机。
						</DialogDescription>
					</div>
					<DialogFooter>
						<Button
							variant="secondary"
							size="sm"
							onClick={() => setPendingDownload(null)}
						>
							取消
						</Button>
						<Button
							size="sm"
							onClick={handleConfirmDownload}
						>
							下载
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}

const INVOICE_STATUS_LABEL: Record<InvoiceAttachmentStatusValue, string> = {
	not_started: "未发起上传",
	not_uploaded: "未上传",
	upload_failed: "上传失败",
	uploaded: "已上传",
	associated_self: "本人已关联",
	associated_other: "已被他人关联",
};

const INVOICE_STATUS_CLASS: Record<InvoiceAttachmentStatusValue, string> = {
	not_started: "text-ink-3",
	not_uploaded: "text-amber",
	upload_failed: "text-amber",
	uploaded: "text-green",
	associated_self: "text-green",
	associated_other: "text-amber",
};

function InvoiceAttachmentStatusLabel({ status }: { status: InvoiceAttachmentStatus }) {
	// P2.6 round 8: the platform rejection parsing (the bounded "平台核验未
	// 通过" reason and the expense-binding judgment) is edition semantics
	// (`internal/src/allowance/invoiceShared.ts`). The open edition keeps
	// the generic status label and the generic retry hint; the whole label
	// only renders behind the `allowanceInvoice` feature anyway.
	return (
		<span className="mt-0.5 block text-xs">
			<span className={INVOICE_STATUS_CLASS[status.status]}>
				{INVOICE_STATUS_LABEL[status.status]}
			</span>
			{status.lastError ? (
				<span className="block max-w-[260px] whitespace-normal break-words text-ink-3">
					{"上传没有完成，请查看执行卡片中的原因"}
				</span>
			) : null}
		</span>
	);
}
