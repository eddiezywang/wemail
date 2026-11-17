// Copyright (c) 2026 Cloudflare, Inc.
// Modified for WeMail.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { ArchiveIcon } from "@phosphor-icons/react/Archive";
import { ArrowBendUpLeftIcon } from "@phosphor-icons/react/ArrowBendUpLeft";
import { ArrowBendDoubleUpLeftIcon } from "@phosphor-icons/react/ArrowBendDoubleUpLeft";
import { ArrowBendUpRightIcon } from "@phosphor-icons/react/ArrowBendUpRight";
import { CaretDownIcon } from "@phosphor-icons/react/CaretDown";
import { CaretUpIcon } from "@phosphor-icons/react/CaretUp";
import { CodeIcon } from "@phosphor-icons/react/Code";
import { DotsThreeIcon } from "@phosphor-icons/react/DotsThree";
import { EnvelopeOpenIcon } from "@phosphor-icons/react/EnvelopeOpen";
import { EnvelopeSimpleIcon } from "@phosphor-icons/react/EnvelopeSimple";
import { FileTextIcon } from "@phosphor-icons/react/FileText";
import { PaperPlaneTiltIcon } from "@phosphor-icons/react/PaperPlaneTilt";
import { PencilSimpleIcon } from "@phosphor-icons/react/PencilSimple";
import { TrashIcon } from "@phosphor-icons/react/Trash";
import { useEffect, useState } from "react";
import { Button } from "~/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "~/components/ui/tooltip";
import EmailAttachmentList from "~/components/EmailAttachmentList";
import EmailBodyRenderer from "~/components/email-panel/EmailBodyRenderer";
import RecipientDetails from "~/components/email-panel/RecipientDetails";
import {
	formatDetailDate,
	formatShortDate,
	stripHtml,
} from "~/lib/utils";
import type { Email } from "~/types";

interface ThreadMessageProps {
	email: Email;
	traceId?: string;
	highlightTerms?: string[];
	mailboxId?: string;
	mailboxEmail?: string;
	isLast: boolean;
	isDraft?: boolean;
	isSending?: boolean;
	isExpanded: boolean;
	onToggleExpand: () => void;
	onSendDraft?: () => void;
	onEditDraft?: () => void;
	onDeleteDraft?: () => void;
	onViewSource?: () => void;
	onViewAiText?: () => void;
	onPreviewImage?: (url: string, filename: string) => void;
	onRefreshInvoiceStatus?: () => void;
	isRefreshingInvoiceStatus?: boolean;
	invoiceRefreshMessage?: string;
	isBodyLoading?: boolean;
	bodyLoadFailed?: boolean;
	bodyTooLarge?: boolean;
	onRetryBody?: () => void;
	onLoadBody?: () => void;
	bodyRetryable?: boolean;
	onReply?: () => void;
	onReplyAll?: () => void;
	onForward?: () => void;
	onArchive?: () => void;
	onDelete?: () => void;
	onToggleRead?: () => void;
}

function DraftBadge() {
	return (
		<span className="inline-flex min-h-7 items-center rounded-full border border-amber/30 bg-amber-bg px-2 text-xs font-medium uppercase tracking-wider text-amber">
			Draft
		</span>
	);
}

export default function ThreadMessage({
	email,
	traceId,
	highlightTerms,
	mailboxId,
	mailboxEmail,
	isLast,
	isDraft,
	isSending,
	isExpanded,
	onToggleExpand,
	onSendDraft,
	onEditDraft,
	onDeleteDraft,
	onViewSource,
	onViewAiText,
	onPreviewImage,
	onRefreshInvoiceStatus,
	isRefreshingInvoiceStatus,
	invoiceRefreshMessage,
	isBodyLoading,
	bodyLoadFailed,
	bodyTooLarge = false,
	onRetryBody,
	onLoadBody,
	bodyRetryable = true,
	onReply,
	onReplyAll,
	onForward,
	onArchive,
	onDelete,
	onToggleRead,
}: ThreadMessageProps) {
	const [expandedEmailId, setExpandedEmailId] = useState(isExpanded ? email.id : null);
	useEffect(() => {
		if (isExpanded) setExpandedEmailId(email.id);
	}, [email.id, isExpanded]);
	const isSelf = email.sender === mailboxEmail;
	const hasMoreActions =
		!!onArchive ||
		!!onDelete ||
		!!onToggleRead ||
		!!onViewSource ||
		!!onViewAiText ||
		!!onReplyAll ||
		!!onForward;
	const containerClassName = `${!isLast ? "border-b border-edge" : ""} ${isDraft ? "border-l-2 border-l-amber bg-amber-bg/20" : ""}`;
	const senderLabel = isDraft ? "回复草稿" : isSelf ? "我" : email.sender;

	const collapsedView = (
		<div className={containerClassName}>
				<button
					type="button"
					onClick={onToggleExpand}
					className="w-full flex items-center gap-3 px-4 py-3 hover:bg-paper-2 rounded-lg text-left"
				>
					<div className="flex-1 min-w-0">
						<div className="flex items-center justify-between gap-3">
							<span className="truncate text-ui font-semibold tracking-[-0.005em] text-ink">
								{senderLabel}
							</span>
							<div className="flex items-center gap-2 shrink-0">
								{isDraft && <DraftBadge />}
								<span className="text-xs text-ink-3">
									{formatDetailDate(email.date)}
								</span>
							</div>
						</div>
						<p className="text-xs text-ink-3 truncate mt-0.5">
							{(
								email.bodyText ||
								stripHtml(email.bodyHtml || email.body || "")
							).slice(0, 80)}
						</p>
					</div>
					<CaretDownIcon size={14} className="text-ink-3 shrink-0" />
				</button>
		</div>
	);
	return (
		<>
			{!isExpanded ? collapsedView : null}
			{isExpanded || expandedEmailId === email.id ? (
				<div
					className={`group/thread-msg ${containerClassName}`}
					hidden={!isExpanded}
					aria-hidden={!isExpanded}
				>
			<div className="px-4 py-4 md:px-6">
				<div className="flex items-center justify-between gap-3" data-testid="thread-message-primary-meta">
					<div className="min-w-0 flex-1 select-text">
						<div className="flex items-center gap-2">
							<span className="truncate text-body font-semibold tracking-[-0.005em] text-ink">
								{senderLabel}
							</span>
							{isDraft && <DraftBadge />}
						</div>
					</div>
					<div className="flex items-center gap-1 shrink-0">
						<span className="text-xs text-ink-3">
							{formatShortDate(email.date)}
						</span>
						{!isDraft && onReply ? (
							<Tooltip>
								<TooltipTrigger asChild>
									<button
										type="button"
										onClick={onReply}
										className="ml-1 inline-flex h-9 w-9 items-center justify-center rounded-md text-ink-3 hover:text-ink hover:bg-paper-3"
										aria-label="回复"
									>
										<ArrowBendUpLeftIcon size={14} weight="bold" />
									</button>
								</TooltipTrigger>
								<TooltipContent side="bottom">回复</TooltipContent>
							</Tooltip>
						) : null}
						{!isDraft && onReplyAll ? (
							<Tooltip>
								<TooltipTrigger asChild>
									<button
										type="button"
										onClick={onReplyAll}
										className="ml-1 inline-flex h-9 w-9 items-center justify-center rounded-md text-ink-3 hover:text-ink hover:bg-paper-3"
										aria-label="回复全部"
									>
										<ArrowBendDoubleUpLeftIcon size={14} weight="bold" />
									</button>
								</TooltipTrigger>
								<TooltipContent side="bottom">回复全部</TooltipContent>
							</Tooltip>
						) : null}
						{!isDraft && hasMoreActions ? (
							<DropdownMenu>
								<Tooltip>
									<TooltipTrigger asChild>
										<DropdownMenuTrigger asChild>
											<button
												type="button"
												className="inline-flex h-9 w-9 items-center justify-center rounded-md text-ink-3 hover:text-ink hover:bg-paper-3"
												aria-label="更多操作"
											>
												<DotsThreeIcon size={16} weight="bold" />
											</button>
										</DropdownMenuTrigger>
									</TooltipTrigger>
									<TooltipContent side="bottom">更多</TooltipContent>
								</Tooltip>
								<DropdownMenuContent align="end" className="min-w-[180px]">
									{onReply ? (
										<DropdownMenuItem onSelect={onReply}>
											<ArrowBendUpLeftIcon size={14} weight="bold" />
											<span>回复</span>
										</DropdownMenuItem>
									) : null}
									{onReplyAll ? (
										<DropdownMenuItem onSelect={onReplyAll}>
											<ArrowBendUpLeftIcon size={14} weight="bold" />
											<span>回复全部</span>
										</DropdownMenuItem>
									) : null}
									{onForward ? (
										<DropdownMenuItem onSelect={onForward}>
											<ArrowBendUpRightIcon size={14} weight="bold" />
											<span>转发</span>
										</DropdownMenuItem>
									) : null}
									{onToggleRead ? (
										<DropdownMenuItem onSelect={onToggleRead}>
											{email.read ? (
												<EnvelopeSimpleIcon size={14} />
											) : (
												<EnvelopeOpenIcon size={14} />
											)}
											<span>{email.read ? "标记为未读" : "标记为已读"}</span>
										</DropdownMenuItem>
									) : null}
									{onViewAiText ? (
										<DropdownMenuItem onSelect={onViewAiText}>
											<FileTextIcon size={14} />
											<span>显示纯文本</span>
										</DropdownMenuItem>
									) : null}
									{onViewSource ? (
										<DropdownMenuItem onSelect={onViewSource}>
											<CodeIcon size={14} />
											<span>显示原始邮件</span>
										</DropdownMenuItem>
									) : null}
									{(onArchive || onDelete) ? <DropdownMenuSeparator /> : null}
									{onArchive ? (
										<DropdownMenuItem onSelect={onArchive}>
											<ArchiveIcon size={14} />
											<span>归档</span>
										</DropdownMenuItem>
									) : null}
									{onDelete ? (
										<DropdownMenuItem
											onSelect={onDelete}
											className="text-red focus:bg-red-bg/40 focus:text-red"
										>
											<TrashIcon size={14} />
											<span>移到回收站</span>
										</DropdownMenuItem>
									) : null}
								</DropdownMenuContent>
							</DropdownMenu>
						) : isDraft && onViewSource ? (
							<Tooltip>
								<TooltipTrigger asChild>
									<Button
										variant="ghost"
										size="sm"
										onClick={onViewSource}
									aria-label="显示原始邮件"
									className="h-9 w-9 p-0 transition-opacity"
									>
										<CodeIcon size={14} />
									</Button>
								</TooltipTrigger>
								<TooltipContent side="bottom">显示原始邮件</TooltipContent>
							</Tooltip>
						) : null}
						<button
							type="button"
							onClick={onToggleExpand}
							className="ml-1 inline-flex h-9 w-9 items-center justify-center rounded-md hover:bg-paper-3"
							aria-label="收起邮件"
						>
							<CaretUpIcon
								size={14}
								className="text-ink-3 hover:text-ink transition-colors"
							/>
						</button>
					</div>
				</div>
				<div className="mb-3" data-testid="thread-message-recipient-meta">
					<RecipientDetails
						messageId={email.id}
						selfAddress={mailboxEmail}
						sender={email.sender}
						date={email.date}
						to={email.toAddresses}
						cc={email.ccAddresses}
						bcc={email.bccAddresses}
						fallbackTo={email.recipient}
						fallbackCc={email.cc}
						fallbackBcc={email.bcc}
						delivery={email.delivery}
					/>
				</div>

				{isDraft && (onSendDraft || onEditDraft || onDeleteDraft) && (
					<div className="flex gap-2 mt-3">
						{onSendDraft && (
							<Button
								variant="default"
								size="sm"
								onClick={onSendDraft}
								disabled={isSending}
							>
								{!isSending && <PaperPlaneTiltIcon size={14} />}
								{isSending ? "正在发送…" : "发送"}
							</Button>
						)}
						{onEditDraft && (
							<Button
								variant="secondary"
								size="sm"
								onClick={onEditDraft}
								disabled={isSending}
							>
								<PencilSimpleIcon size={14} />
								编辑
							</Button>
						)}
						{onDeleteDraft && (
							<Button
								variant="ghost"
								size="sm"
								onClick={onDeleteDraft}
								disabled={isSending}
							>
								<TrashIcon size={14} />
								丢弃
							</Button>
						)}
					</div>
				)}

				<EmailAttachmentList
					mailboxId={mailboxId}
					emailId={email.id}
					attachments={email.attachments}
					invoiceStatus={email.invoiceStatus}
					onRefreshInvoiceStatus={onRefreshInvoiceStatus}
					isRefreshingInvoiceStatus={isRefreshingInvoiceStatus}
					invoiceRefreshMessage={invoiceRefreshMessage}
					onPreviewImage={onPreviewImage}
					className="mb-3"
					showHeading
				/>

				<div>
					{bodyLoadFailed ? (
						<div className="rounded-xl border border-edge bg-paper-2 px-5 py-8 text-center">
							{bodyTooLarge ? (
								<>
									<p className="text-sm font-medium text-ink">邮件正文较大（超过 5MB）</p>
									<p className="mt-1 text-xs text-ink-3">为避免卡顿未自动加载，可手动加载正文。</p>
									<button type="button" onClick={onLoadBody} disabled={!bodyRetryable} className="mt-4 min-h-10 rounded-full border border-edge bg-paper px-4 py-2 text-sm text-ink hover:bg-paper-3 disabled:cursor-not-allowed disabled:opacity-50">
										加载正文
									</button>
								</>
							) : (
								<>
									<p className="text-sm font-medium text-ink">邮件正文暂时无法加载</p>
									<button type="button" onClick={onRetryBody} disabled={!bodyRetryable} className="mt-4 min-h-10 rounded-full border border-edge bg-paper px-4 py-2 text-sm text-ink hover:bg-paper-3 disabled:cursor-not-allowed disabled:opacity-50">
										重新加载
									</button>
								</>
							)}
						</div>
					) : (
						<EmailBodyRenderer
							email={email}
							traceId={traceId}
							highlightTerms={highlightTerms}
							mailboxId={mailboxId}
							loading={isBodyLoading}
						/>
					)}
				</div>
			</div>
				</div>
			) : null}
		</>
	);
}
