// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { ArchiveIcon } from "@phosphor-icons/react/Archive";
import { ArrowBendDoubleUpLeftIcon } from "@phosphor-icons/react/ArrowBendDoubleUpLeft";
import { ArrowBendUpLeftIcon } from "@phosphor-icons/react/ArrowBendUpLeft";
import { ArrowBendUpRightIcon } from "@phosphor-icons/react/ArrowBendUpRight";
import { CodeIcon } from "@phosphor-icons/react/Code";
import { DotsThreeIcon } from "@phosphor-icons/react/DotsThree";
import { EnvelopeOpenIcon } from "@phosphor-icons/react/EnvelopeOpen";
import { EnvelopeSimpleIcon } from "@phosphor-icons/react/EnvelopeSimple";
import { FileTextIcon } from "@phosphor-icons/react/FileText";
import { TrashIcon } from "@phosphor-icons/react/Trash";
import RecipientDetails from "~/components/email-panel/RecipientDetails";
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
import { formatDetailDate } from "~/lib/utils";
import type { Email } from "~/types";

export interface MessageSenderBarActions {
	onReply?: () => void;
	onReplyAll?: () => void;
	onForward?: () => void;
	onArchive?: () => void;
	onDelete?: () => void;
	onToggleRead?: () => void;
	onViewSource?: () => void;
	onViewAiText?: () => void;
}

interface MessageSenderBarProps extends MessageSenderBarActions {
	email: Email;
	mailboxEmail?: string;
}

function senderDisplayName(sender: string): string {
	const name = sender.match(/^\s*"?([^"<]+?)"?\s*</)?.[1]?.trim();
	if (name) return name;
	return sender.split("@")[0]?.trim() || sender;
}

function senderInitial(sender: string): string {
	return Array.from(senderDisplayName(sender))[0]?.toLocaleUpperCase() || "?";
}

export default function MessageSenderBar({
	email,
	mailboxEmail,
	onReply,
	onReplyAll,
	onForward,
	onArchive,
	onDelete,
	onToggleRead,
	onViewSource,
	onViewAiText,
}: MessageSenderBarProps) {
	const displayName = senderDisplayName(email.sender);
	const hasMoreActions =
		!!onReplyAll || !!onArchive || !!onDelete || !!onToggleRead || !!onViewSource || !!onViewAiText;

	return (
		<div
			className="relative flex min-h-14 shrink-0 items-start gap-3 border-b border-edge-3 px-4 py-2 md:px-6"
			aria-label="发件人信息"
		>
			<div
				className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-coral/12 text-sm font-semibold text-coral"
				aria-hidden="true"
			>
				{senderInitial(email.sender)}
			</div>

			<div className="min-w-0 flex-1 select-text">
				<div className="flex min-w-0 items-baseline justify-between gap-3 pr-[9rem]">
					<div className="truncate text-body font-semibold tracking-[-0.005em] text-ink">
						{displayName}
					</div>
					<time
						dateTime={email.date}
						className="shrink-0 text-xs tabular-nums text-ink-3"
					>
						{formatDetailDate(email.date)}
					</time>
				</div>
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

			<div
				className="absolute right-4 top-2 flex items-center gap-1 md:right-6"
				data-testid="message-sender-actions"
			>
				{onReply ? (
					<Tooltip>
						<TooltipTrigger asChild>
							<button
								type="button"
								onClick={onReply}
								className="inline-flex h-8 w-8 items-center justify-center rounded-full text-ink-3 transition-colors hover:bg-paper-3 hover:text-ink"
								aria-label="回复"
							>
								<ArrowBendUpLeftIcon size={15} weight="bold" />
							</button>
						</TooltipTrigger>
						<TooltipContent side="bottom">回复</TooltipContent>
					</Tooltip>
				) : null}
				{onReplyAll ? (
					<Tooltip>
						<TooltipTrigger asChild>
							<button
								type="button"
								onClick={onReplyAll}
								className="inline-flex h-8 w-8 items-center justify-center rounded-full text-ink-3 transition-colors hover:bg-paper-3 hover:text-ink"
								aria-label="回复全部"
							>
								<ArrowBendDoubleUpLeftIcon size={15} weight="bold" />
							</button>
						</TooltipTrigger>
						<TooltipContent side="bottom">回复全部</TooltipContent>
					</Tooltip>
				) : null}
				{hasMoreActions ? (
					<DropdownMenu>
						<Tooltip>
							<TooltipTrigger asChild>
									<DropdownMenuTrigger asChild>
										<button
											type="button"
											className="inline-flex h-8 w-8 items-center justify-center rounded-full text-ink-3 transition-colors hover:bg-paper-3 hover:text-ink"
											aria-label="更多操作"
										>
										<DotsThreeIcon size={17} weight="bold" />
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
							{onArchive || onDelete ? <DropdownMenuSeparator /> : null}
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
				) : null}
			</div>
		</div>
	);
}
