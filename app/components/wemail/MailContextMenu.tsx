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
import { createPortal } from "react-dom";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import SmartTagPickerPopover from "~/components/wemail/SmartTagPickerPopover";
import type { Email } from "~/types";

export interface MailContextMenuPosition {
	x: number;
	y: number;
}

export interface MailContextMenuProps {
	email: Email | null;
	position: MailContextMenuPosition | null;
	accountId?: string;
	appliedTags?: ReadonlySet<string>;
	onClose: () => void;
	onReply: () => void;
	onReplyAll: () => void;
	onForward: () => void;
	onToggleRead: () => void;
	onArchive?: () => void;
	onMarkSpam: () => void;
	onDelete: () => void;
}

const MENU_MARGIN = 8;

export default function MailContextMenu({
	email,
	position,
	accountId,
	appliedTags = new Set(),
	onClose,
	onReply,
	onReplyAll,
	onForward,
	onToggleRead,
	onArchive,
	onMarkSpam,
	onDelete,
}: MailContextMenuProps) {
	const menuRef = useRef<HTMLDivElement | null>(null);
	const [menuPosition, setMenuPosition] = useState<MailContextMenuPosition>(
		position ?? { x: MENU_MARGIN, y: MENU_MARGIN },
	);

	useLayoutEffect(() => {
		if (!position || typeof window === "undefined") return;
		const menu = menuRef.current;
		const width = menu?.offsetWidth ?? 232;
		const height = menu?.offsetHeight ?? 360;
		setMenuPosition({
			x: Math.max(
				MENU_MARGIN,
				Math.min(position.x, window.innerWidth - width - MENU_MARGIN),
			),
			y: Math.max(
				MENU_MARGIN,
				Math.min(position.y, window.innerHeight - height - MENU_MARGIN),
			),
		});
	}, [position]);

	useEffect(() => {
		if (!email || !position) return;
		const isMenuOverlay = (target: EventTarget | null) => {
			if (!(target instanceof Element)) return false;
			return Boolean(
				target.closest(
					'[data-testid="smart-tag-picker"], [data-testid="smart-tag-action-dialog"], [data-testid="snooze-menu"]',
				),
			);
		};
		const handlePointerDown = (event: PointerEvent) => {
			const target = event.target;
			if (menuRef.current?.contains(target as Node) || isMenuOverlay(target)) return;
			onClose();
		};
		const handleKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") onClose();
		};
		document.addEventListener("pointerdown", handlePointerDown);
		document.addEventListener("keydown", handleKeyDown);
		return () => {
			document.removeEventListener("pointerdown", handlePointerDown);
			document.removeEventListener("keydown", handleKeyDown);
		};
	}, [email, onClose, position]);

	if (!email || !position || typeof document === "undefined") return null;

	const run = (action: () => void) => {
		onClose();
		action();
	};

	return createContextMenuPortal(
		<div
			ref={menuRef}
			role="menu"
			aria-label="邮件操作"
			data-testid="mail-context-menu"
			style={{ left: menuPosition.x, top: menuPosition.y }}
			className="fixed z-[70] max-h-[calc(100vh-16px)] w-[232px] overflow-y-auto rounded-2xl border border-edge-2 bg-paper-2 p-1.5 text-ink shadow-[var(--shadow-3)]"
		>
			<ContextMenuItem
				icon={<ArrowBendUpLeftIcon size={16} weight="bold" />}
				label="回复"
				onClick={() => run(onReply)}
			/>
			<ContextMenuItem
				icon={<ArrowBendUpLeftIcon size={16} weight="bold" />}
				label="回复全部"
				onClick={() => run(onReplyAll)}
			/>
			<ContextMenuItem
				icon={<ArrowBendUpRightIcon size={16} weight="bold" />}
				label="转发"
				onClick={() => run(onForward)}
			/>

			<div className="my-1 h-px bg-edge-3" />

			<SmartTagPickerPopover
				emailId={email.id}
				accountId={accountId}
				appliedTags={appliedTags}
			>
				<button
					type="button"
					role="menuitem"
					className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm transition-colors hover:bg-paper-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
				>
					<TagIcon size={16} />
					<span>智能标签</span>
				</button>
			</SmartTagPickerPopover>
			<ContextMenuItem
				icon={
					email.read ? (
						<EnvelopeSimpleIcon size={16} />
					) : (
						<EnvelopeOpenIcon size={16} />
					)
				}
				label={email.read ? "标记为未读" : "标记为已读"}
				onClick={() => run(onToggleRead)}
			/>
			{onArchive ? (
				<ContextMenuItem
					icon={<ArchiveIcon size={16} />}
					label="归档"
					onClick={() => run(onArchive)}
				/>
			) : null}

			<div className="my-1 h-px bg-edge-3" />

			<ContextMenuItem
				icon={<WarningIcon size={16} />}
				label="垃圾邮件"
				onClick={() => run(onMarkSpam)}
				destructive
			/>
			<ContextMenuItem
				icon={<TrashIcon size={16} />}
				label="移到回收站"
				onClick={() => run(onDelete)}
				destructive
			/>
		</div>,
	);
}

function createContextMenuPortal(element: ReactNode) {
	return typeof document === "undefined" ? null : createPortal(element, document.body);
}

function ContextMenuItem({
	icon,
	label,
	onClick,
	destructive = false,
}: {
	icon: ReactNode;
	label: string;
	onClick: () => void;
	destructive?: boolean;
}) {
	return (
		<button
			type="button"
			role="menuitem"
			onClick={onClick}
			className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
				destructive
					? "text-red hover:bg-red-bg/40"
					: "text-ink hover:bg-paper-3"
			}`}
		>
			<span className="shrink-0 text-ink-2">{icon}</span>
			<span>{label}</span>
		</button>
	);
}
