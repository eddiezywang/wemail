// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { ArchiveIcon } from "@phosphor-icons/react/Archive";
import { ArrowBendUpLeftIcon } from "@phosphor-icons/react/ArrowBendUpLeft";
import { ArrowBendUpRightIcon } from "@phosphor-icons/react/ArrowBendUpRight";
import { EnvelopeOpenIcon } from "@phosphor-icons/react/EnvelopeOpen";
import { EnvelopeSimpleIcon } from "@phosphor-icons/react/EnvelopeSimple";
import { TagIcon } from "@phosphor-icons/react/Tag";
import { TrashIcon } from "@phosphor-icons/react/Trash";
import { WarningIcon } from "@phosphor-icons/react/Warning";
import { useRef, useState, type ReactNode } from "react";
import { Popover, PopoverAnchor, PopoverContent } from "~/components/ui/popover";
import SmartTagPickerPopover from "~/components/wemail/SmartTagPickerPopover";
import { useIntelligence } from "~/queries/intelligence";
import type { Email } from "~/types";

export interface MailMenuAnchor {
	element: HTMLElement;
	point?: { x: number; y: number };
}

interface MailContextMenuProps {
	email: Email;
	anchor: MailMenuAnchor;
	accountId?: string;
	fallbackFocus: () => void;
	onClose: () => void;
	onReply: () => void;
	onReplyAll: () => void;
	onForward: () => void;
	onToggleRead: () => void;
	onArchive?: () => void;
	onMarkSpam: () => void;
	onDelete: () => void;
}

export default function MailContextMenu({
	email, anchor, accountId, fallbackFocus, onClose, onReply, onReplyAll, onForward,
	onToggleRead, onArchive, onMarkSpam, onDelete,
}: MailContextMenuProps) {
	const [showTags, setShowTags] = useState(false);
	const [returning, setReturning] = useState(false);
	const virtualRef = useRef({ getBoundingClientRect: () => new DOMRect() });
	virtualRef.current.getBoundingClientRect = () => anchor.point
		? new DOMRect(anchor.point.x, anchor.point.y, 0, 0)
		: anchor.element.getBoundingClientRect();
	const intelligence = useIntelligence(showTags ? email.id : undefined);
	const tags = intelligence.data?.tags?.result?.tags;
	const goBack = () => { setReturning(true); setShowTags(false); };
	const run = (action: () => void) => { onClose(); action(); };

	return (
		<Popover open onOpenChange={(open) => { if (!open) onClose(); }}>
			<PopoverAnchor virtualRef={virtualRef} />
			<PopoverContent
				id="mail-actions-menu"
				data-testid="mail-context-menu"
				aria-label={showTags ? "邮件智能标签" : "邮件操作"}
				align={anchor.point ? "start" : "end"}
				collisionPadding={8}
				className="max-h-[var(--radix-popover-content-available-height)] w-72 max-w-[calc(100vw-1rem)] overflow-y-auto overscroll-contain rounded-xl p-1.5"
				onInteractOutside={(event) => {
					if (document.querySelector('[data-testid="smart-tag-action-dialog"][data-state="open"]')) {
						event.preventDefault();
						return;
					}
					const target = event.target;
					if (target instanceof Element && (target.closest('[data-testid="smart-tag-action-dialog"]')
						|| (anchor.element instanceof HTMLButtonElement && anchor.element.contains(target)))) event.preventDefault();
				}}
				onCloseAutoFocus={(event) => {
					event.preventDefault();
					const active = document.activeElement;
					if (active && active !== document.body) return;
					if (anchor.element.isConnected) anchor.element.focus({ preventScroll: true });
					else fallbackFocus();
				}}
				onEscapeKeyDown={(event) => {
					if (!showTags) return;
					event.preventDefault();
					goBack();
				}}
				onKeyDown={(event) => {
					if (event.defaultPrevented || showTags || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
					const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button"));
					if (items.length === 0) return;
					event.preventDefault();
					const index = items.indexOf(document.activeElement as HTMLButtonElement);
					const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
						: (index + (event.key === "ArrowUp" ? (index < 0 ? 0 : -1) : 1) + items.length) % items.length;
					items[next]?.focus();
				}}
			>
				{showTags ? (
					<SmartTagPickerPopover
						emailId={email.id}
						accountId={accountId}
						appliedTags={new Set(tags?.map((tag) => tag.name))}
						appliedTagsStatus={intelligence.isLoading ? "loading" : intelligence.isError && !intelligence.data ? "error" : undefined}
						onRetryAppliedTags={() => void intelligence.refetch()}
						onBack={goBack}
					/>
				) : (
					<>
						<ContextMenuItem icon={<ArrowBendUpLeftIcon size={16} />} label="回复" onClick={() => run(onReply)} />
						<ContextMenuItem icon={<ArrowBendUpLeftIcon size={16} weight="bold" />} label="回复全部" onClick={() => run(onReplyAll)} />
						<ContextMenuItem icon={<ArrowBendUpRightIcon size={16} />} label="转发" onClick={() => run(onForward)} />
						<hr className="my-1 border-edge" />
						<ContextMenuItem icon={<TagIcon size={16} />} label="智能标签" autoFocus={returning} onClick={() => setShowTags(true)} />
						<ContextMenuItem icon={email.read ? <EnvelopeSimpleIcon size={16} /> : <EnvelopeOpenIcon size={16} />} label={email.read ? "标记为未读" : "标记为已读"} onClick={() => run(onToggleRead)} />
						{onArchive ? <ContextMenuItem icon={<ArchiveIcon size={16} />} label="归档" onClick={() => run(onArchive)} /> : null}
						<hr className="my-1 border-edge" />
						<ContextMenuItem icon={<WarningIcon size={16} />} label="垃圾邮件" onClick={() => run(onMarkSpam)} destructive />
						<ContextMenuItem icon={<TrashIcon size={16} />} label="移到回收站" onClick={() => run(onDelete)} destructive />
					</>
				)}
			</PopoverContent>
		</Popover>
	);
}

function ContextMenuItem({ icon, label, onClick, destructive, autoFocus }: {
	icon: ReactNode;
	label: string;
	onClick: () => void;
	destructive?: boolean;
	autoFocus?: boolean;
}) {
	return (
		<button type="button" onClick={onClick} autoFocus={autoFocus}
			className={`flex min-h-11 w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm hover:bg-paper-3 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring ${destructive ? "text-red" : "text-ink"}`}>
			<span aria-hidden className="shrink-0">{icon}</span>
			{label}
		</button>
	);
}
