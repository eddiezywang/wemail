// Copyright (c) 2026 Cloudflare, Inc.
// Modified for WeMail.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * upstream-aligned email detail toolbar.
 *
 * Recon (`upstream recon notes > 07-email-detail.detailToolbar`) gives:
 *   [双箭头, 回复, 转发, 标签/标记, 星标, 更多]
 * and a More menu of 8 items. We mirror that, splitting the items by
 * destructiveness in the dropdown so the pattern reads cleanly.
 *
 * Draft folder still gets a Send + Edit pair instead of Reply/Forward.
 * All low-frequency actions (mark read, view source, move to folder,
 * delete, archive, mark spam, etc.) live in the More dropdown.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { ArchiveIcon } from "@phosphor-icons/react/Archive";
import { ArrowBendUpLeftIcon } from "@phosphor-icons/react/ArrowBendUpLeft";
import { ArrowBendDoubleUpLeftIcon } from "@phosphor-icons/react/ArrowBendDoubleUpLeft";
import { ArrowBendUpRightIcon } from "@phosphor-icons/react/ArrowBendUpRight";
import { CaretDoubleRightIcon } from "@phosphor-icons/react/CaretDoubleRight";
import { CheckSquareIcon } from "@phosphor-icons/react/CheckSquare";
import { CodeIcon } from "@phosphor-icons/react/Code";
import { DotsThreeVerticalIcon } from "@phosphor-icons/react/DotsThreeVertical";
import { EnvelopeOpenIcon } from "@phosphor-icons/react/EnvelopeOpen";
import { EnvelopeSimpleIcon } from "@phosphor-icons/react/EnvelopeSimple";
import { FunnelIcon } from "@phosphor-icons/react/Funnel";
import { FileTextIcon } from "@phosphor-icons/react/FileText";
import { PaperPlaneTiltIcon } from "@phosphor-icons/react/PaperPlaneTilt";
import { PencilSimpleIcon } from "@phosphor-icons/react/PencilSimple";
import { PrinterIcon } from "@phosphor-icons/react/Printer";
import { StarIcon } from "@phosphor-icons/react/Star";
import { TagIcon } from "@phosphor-icons/react/Tag";
import { TrashIcon } from "@phosphor-icons/react/Trash";
import { WarningIcon } from "@phosphor-icons/react/Warning";
import { Button } from "~/components/ui/button";
import SmartTagPickerPopover from "~/components/wemail/SmartTagPickerPopover";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "~/components/ui/tooltip";
import type { Email } from "~/types";
import { useIntelligence } from "~/queries/intelligence";

interface EmailPanelToolbarProps {
	email: Email;
	mailboxId?: string;
	secondaryReady: boolean;
	isDraftFolder: boolean;
	isSending: boolean;
	lastReceivedMessage?: Email;
	onBack: () => void;
	onSendDraft: () => void;
	onEditDraft: () => void;
	onReply: () => void;
	onReplyAll: () => void;
	onForward: () => void;
	onToggleStar: () => void;
	onToggleRead: () => void;
	onViewSource: () => void;
	onViewAiText: () => void;
	onDelete: () => void;
	onArchive?: () => void;
	onMarkSpam: () => void;
	onCreateTodo: () => void;
	onFilterSimilar: () => void;
}

function IconButton({
	tooltip,
	ariaLabel,
	onClick,
	icon,
	className,
	disabled,
}: {
	tooltip: string;
	ariaLabel: string;
	onClick: () => void;
	icon: React.ReactNode;
	className?: string;
	disabled?: boolean;
}) {
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<Button
					variant="ghost"
					size="sm"
					onClick={onClick}
					aria-label={ariaLabel}
					disabled={disabled}
					className={`h-8 w-8 p-0 ${className ?? ""}`}
				>
					{icon}
				</Button>
			</TooltipTrigger>
			<TooltipContent side="bottom">{tooltip}</TooltipContent>
		</Tooltip>
	);
}

export default function EmailPanelToolbar({
	email,
	mailboxId,
	secondaryReady,
	isDraftFolder,
	isSending,
	onBack,
	onSendDraft,
	onEditDraft,
	onReply,
	onReplyAll,
	onForward,
	onToggleStar,
	onToggleRead,
	onViewSource,
	onViewAiText,
	onDelete,
	onArchive,
	onMarkSpam,
	onCreateTodo,
	onFilterSimilar,
}: EmailPanelToolbarProps) {
	return (
		<div className="flex h-[56px] shrink-0 items-center gap-1 border-b border-edge-3 bg-workbench-surface px-3 md:px-4">
			{/* Back arrow (recon: 双箭头) */}
			<IconButton
				tooltip="返回列表"
				ariaLabel="Back to list"
				onClick={onBack}
				icon={<CaretDoubleRightIcon size={16} weight="bold" />}
			/>

			{isDraftFolder ? (
				<>
					<Button
						variant="default"
						size="sm"
						onClick={onSendDraft}
						disabled={isSending}
					>
						{!isSending && <PaperPlaneTiltIcon size={14} />}
						{isSending ? "发送中…" : "发送"}
					</Button>
					<Button
						variant="secondary"
						size="sm"
						onClick={onEditDraft}
						disabled={isSending}
					>
						<PencilSimpleIcon size={14} />
						编辑
					</Button>
				</>
			) : (
				<>
					<IconButton
						tooltip="回复"
						ariaLabel="Reply"
						onClick={onReply}
						icon={<ArrowBendUpLeftIcon size={18} />}
					/>
					<IconButton
						tooltip="回复全部"
						ariaLabel="Reply all"
						onClick={onReplyAll}
						icon={<ArrowBendDoubleUpLeftIcon size={18} />}
					/>
					<IconButton
						tooltip="转发"
						ariaLabel="Forward"
						onClick={onForward}
						icon={<ArrowBendUpRightIcon size={18} />}
					/>
					<TagsButton
						emailId={email.id}
						accountId={mailboxId}
						secondaryReady={secondaryReady}
					/>
					<IconButton
						tooltip={email.starred ? "取消星标" : "加星标"}
						ariaLabel={email.starred ? "Unstar" : "Star"}
						onClick={onToggleStar}
						icon={
							<StarIcon
								size={18}
								weight={email.starred ? "fill" : "regular"}
								className={email.starred ? "text-amber" : ""}
							/>
						}
					/>
					<MoreMenu
						email={email}
						onReplyAll={onReplyAll}
						onToggleRead={onToggleRead}
						onViewSource={onViewSource}
						onViewAiText={onViewAiText}
						onDelete={onDelete}
						onArchive={onArchive}
						onMarkSpam={onMarkSpam}
						onCreateTodo={onCreateTodo}
						onFilterSimilar={onFilterSimilar}
					/>
				</>
			)}

			<div className="flex-1" />
		</div>
	);
}

/**
 * Smart tag management entry. Folder movement remains separate from
 * user-defined intelligent tags so the tag icon always means "标签处理".
 */
function TagsButton({
	emailId,
	accountId,
	secondaryReady,
}: {
	emailId: string;
	accountId: string | undefined;
	secondaryReady: boolean;
}) {
	// Self-subscribe to the intelligence tags so EmailPanel's shell never has
	// to subscribe to intelligence (which would re-render the whole panel).
	// React Query dedups this with EmailIntelligenceSection's subscription.
	const intelligence = useIntelligence(secondaryReady ? emailId : undefined);
	const appliedTags = useMemo(
		() =>
			new Set(
				(intelligence.data?.tags?.result?.tags ?? []).map((tag) => tag.name),
			),
		[intelligence.data?.tags?.result?.tags],
	);
	return (
		<SmartTagPickerPopover
			emailId={emailId}
			accountId={accountId}
			appliedTags={appliedTags}
		>
			<Button
				variant="ghost"
				size="sm"
				aria-label="标签处理"
				title="标签处理"
				className="h-8 w-8 p-0"
			>
				<TagIcon size={18} />
			</Button>
		</SmartTagPickerPopover>
	);
}

/**
 * The 8-item More dropdown. Recon order:
 *   创建待办 / 归档 / 回收站 / 垃圾邮件 / 标记为未读 /
 *   不分屏 / 创建类似规则 / 打印
 *
 * We keep the labels upstream uses but split destructive (回收站 / 垃圾邮件)
 * to the bottom under a separator. "不分屏" is wired to a no-op placeholder
 * — reserved for the layout-toggle feature.
 */
function MoreMenu({
	email,
	onReplyAll,
	onToggleRead,
	onViewSource,
	onViewAiText,
	onDelete,
	onArchive,
	onMarkSpam,
	onCreateTodo,
	onFilterSimilar,
}: {
	email: Email;
	onReplyAll: () => void;
	onToggleRead: () => void;
	onViewSource: () => void;
	onViewAiText: () => void;
	onDelete: () => void;
	onArchive?: () => void;
	onMarkSpam: () => void;
	onCreateTodo: () => void;
	onFilterSimilar: () => void;
}) {
	const [open, setOpen] = useState(false);
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!open) return;
		const handler = (e: MouseEvent) => {
			if (ref.current && !ref.current.contains(e.target as Node)) {
				setOpen(false);
			}
		};
		document.addEventListener("mousedown", handler);
		return () => document.removeEventListener("mousedown", handler);
	}, [open]);

	const close = () => setOpen(false);

	return (
		<div ref={ref} className="relative">
			<IconButton
				tooltip="更多"
				ariaLabel="More actions"
				onClick={() => setOpen((o) => !o)}
				icon={<DotsThreeVerticalIcon size={18} weight="bold" />}
			/>
			{open ? (
				<div
					className="absolute top-full left-0 z-50 mt-1 min-w-[200px] rounded-md border border-edge bg-paper-2 shadow-lg py-1"
					data-testid="email-more-menu"
				>
					<MenuItem
						icon={<CheckSquareIcon size={14} />}
						label="创建待办"
						onClick={() => {
							onCreateTodo();
							close();
						}}
					/>
					<MenuItem
						icon={<ArrowBendUpLeftIcon size={14} weight="bold" />}
						label="回复全部"
						onClick={() => {
							onReplyAll();
							close();
						}}
					/>
					{onArchive ? (
						<MenuItem
							icon={<ArchiveIcon size={14} />}
							label="归档"
							onClick={() => {
								onArchive();
								close();
							}}
						/>
					) : null}
					<MenuItem
						icon={
							email.read ? (
								<EnvelopeSimpleIcon size={14} />
							) : (
								<EnvelopeOpenIcon size={14} />
							)
						}
						label={email.read ? "标记为未读" : "标记为已读"}
						onClick={() => {
							onToggleRead();
							close();
						}}
					/>
					<MenuItem
						icon={<FunnelIcon size={14} />}
						label="创建类似规则"
						onClick={() => {
							onFilterSimilar();
							close();
						}}
					/>
					<MenuItem
						icon={<PrinterIcon size={14} />}
						label="打印"
						onClick={() => {
							window.print();
							close();
						}}
					/>
					<MenuItem
						icon={<FileTextIcon size={14} />}
						label="显示纯文本"
						onClick={() => {
							onViewAiText();
							close();
						}}
					/>
					<MenuItem
						icon={<CodeIcon size={14} />}
						label="显示原始邮件"
						onClick={() => {
							onViewSource();
							close();
						}}
					/>
					<div className="my-1 h-px bg-edge-3" />
					<MenuItem
						icon={<WarningIcon size={14} />}
						label="标记为垃圾邮件"
						onClick={() => {
							onMarkSpam();
							close();
						}}
						destructive
					/>
					<MenuItem
						icon={<TrashIcon size={14} />}
						label="移到回收站"
						onClick={() => {
							onDelete();
							close();
						}}
						destructive
					/>
				</div>
			) : null}
		</div>
	);
}

function MenuItem({
	icon,
	label,
	onClick,
	destructive,
}: {
	icon: React.ReactNode;
	label: string;
	onClick: () => void;
	destructive?: boolean;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			className={`flex items-center gap-2.5 w-full text-left px-3 py-1.5 text-sm transition-colors ${
				destructive
					? "text-red hover:bg-red-bg/40"
					: "text-ink hover:bg-paper-3"
			}`}
		>
			<span className="shrink-0">{icon}</span>
			<span className="flex-1">{label}</span>
		</button>
	);
}
