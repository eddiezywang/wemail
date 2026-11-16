// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { PaperclipIcon } from "@phosphor-icons/react/Paperclip";
import { WarningCircleIcon } from "@phosphor-icons/react/WarningCircle";
import { StarIcon } from "@phosphor-icons/react/Star";
import { ArchiveIcon } from "@phosphor-icons/react/Archive";
import { EnvelopeOpenIcon } from "@phosphor-icons/react/EnvelopeOpen";
import { EnvelopeSimpleIcon } from "@phosphor-icons/react/EnvelopeSimple";
import { TrashIcon } from "@phosphor-icons/react/Trash";
import { memo, useState, type CSSProperties, type MouseEvent, type ReactNode } from "react";
import { cn } from "~/lib/cn";
import { Checkbox } from "~/components/ui/checkbox";
import { TagPin, type TagPinVariant } from "./TagPin";

export type MailItemAIStatus = "summarized" | "pending" | "none";

export type MailItemAccent = "coral" | "blue" | "amber" | "green" | "red";

export interface MailItemTag {
	label: string;
	variant?: TagPinVariant;
}

export interface MailItemProps {
	id: string;
	className?: string;
	style?: CSSProperties;
	sender: string;
	subject: string;
	snippet: string;
	highlightTerms?: string[];
	date: string | Date;
	unread?: boolean;
	hasAttachment?: boolean;
	aiStatus?: MailItemAIStatus;
	tags?: MailItemTag[];
	selected?: boolean;
	selectable?: boolean;
	checkboxSelected?: boolean;
	onToggleSelect?: (id: string, next: boolean) => void;
	starred?: boolean;
	onToggleStar?: (id: string, next: boolean) => void;
	onArchive?: (id: string) => void;
	onDelete?: (id: string) => void;
	onToggleRead?: (id: string, next: boolean) => void;
	onContextMenu?: (id: string, event: MouseEvent<HTMLDivElement>) => void;
	/** Optional left-edge importance/category accent stripe. */
	accent?: MailItemAccent;
	/**
	 * Inline failure strip (S7): an optimistic action on this row failed.
	 * Renders reason + Retry as an overlay at the row's bottom edge — the
	 * row height never changes, so the list never jumps.
	 */
	actionError?: { message: string; onRetry: () => void };
	onClick?: (id: string) => void;
}

const AI_BADGE_LABEL: Record<Exclude<MailItemAIStatus, "none">, string> = {
	summarized: "AI",
	pending: "AI...",
};

const AI_BADGE_CLASS: Record<Exclude<MailItemAIStatus, "none">, string> = {
	summarized: "bg-blue-bg text-blue",
	pending: "bg-paper-3 text-ink-3 animate-pulse motion-reduce:animate-none",
};

const ACCENT_CLASS: Record<MailItemAccent, string> = {
	coral: "bg-coral",
	blue: "bg-blue",
	amber: "bg-amber",
	green: "bg-green",
	red: "bg-red",
};

function formatDate(date: string | Date): string {
	if (date instanceof Date) {
		return date.toLocaleDateString(undefined, {
			month: "short",
			day: "numeric",
		});
	}
	return date;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function renderHighlightedText(text: string, terms: string[] | undefined): ReactNode {
	if (!terms || terms.length === 0) return text;
	const normalized = Array.from(
		new Set(terms.map((term) => term.trim()).filter(Boolean)),
	).sort((a, b) => b.length - a.length);
	if (normalized.length === 0) return text;
	const lowered = new Set(normalized.map((term) => term.toLocaleLowerCase()));
	const pattern = new RegExp(`(${normalized.map(escapeRegExp).join("|")})`, "giu");
	const parts = text.split(pattern);
	if (parts.length === 1) return text;
	return parts.map((part, index) =>
		lowered.has(part.toLocaleLowerCase()) ? (
			<mark
				key={`${part}-${index}`}
				className="rounded-sm bg-amber/35 px-[1px] text-inherit"
			>
				{part}
			</mark>
		) : (
			part
		),
	);
}

/**
 * Compact mail list item: when the detail pane is closed, rows keep sender +
 * subject on one line; opening the detail pane switches every row to a second
 * subject line.
 * Message body text never appears in the list row.
 */
function MailItemBase({
	id,
	className,
	style,
	sender,
	subject,
	highlightTerms,
	date,
	unread,
	hasAttachment,
	aiStatus = "none",
	tags,
	selected,
	selectable = false,
	checkboxSelected,
	onToggleSelect,
	starred,
	onToggleStar,
	onArchive,
	onDelete,
	onToggleRead,
	onContextMenu,
	accent,
	actionError,
	onClick,
}: MailItemProps) {
	const isCheckboxSelected = checkboxSelected ?? selected ?? false;
	const hasSignals = Boolean(hasAttachment || aiStatus !== "none" || (tags && tags.length > 0));
	const [isHovered, setIsHovered] = useState(false);

	const handleActivate = () => {
		onClick?.(id);
	};
	const renderSignals = () => {
		if (!hasSignals) return null;
		return (
			<div className="flex shrink-0 items-center gap-1.5 overflow-hidden whitespace-nowrap">
				{hasAttachment ? (
					<span data-testid="mail-item-attachment" aria-label="含附件" className="text-ink-3">
						<PaperclipIcon size={14} weight="regular" />
					</span>
				) : null}
				{aiStatus !== "none" ? (
					<span
						data-testid="mail-item-ai-status"
						data-status={aiStatus}
						className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium ${AI_BADGE_CLASS[aiStatus]}`}
					>
						{AI_BADGE_LABEL[aiStatus]}
					</span>
				) : null}
				{tags && tags.length > 0 ? (
					<div data-testid="mail-item-tags" className="flex shrink-0 items-center gap-2 overflow-hidden whitespace-nowrap">
						{tags.map((t) => (
							<TagPin key={t.label} label={t.label} variant={t.variant} />
						))}
					</div>
				) : null}
			</div>
		);
	};

	return (
		<div
			data-testid="mail-item"
			data-id={id}
			data-unread={unread ? "true" : "false"}
			data-selected={selected || isCheckboxSelected ? "true" : "false"}
			data-accent={accent ?? "none"}
			role="button"
			tabIndex={0}
			onClick={handleActivate}
			onContextMenu={(event) => {
				event.preventDefault();
				event.stopPropagation();
				onContextMenu?.(id, event);
			}}
			onKeyDown={(e) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					handleActivate();
				}
			}}
			className={cn(
				"relative flex cursor-pointer items-stretch overflow-hidden border-b border-edge-2 transition-colors",
				selected
					? "bg-paper-3/80"
					: isCheckboxSelected
						? "bg-paper-3/45"
						: "hover:bg-paper-3/60",
				className,
			)}
			style={style}
			onMouseEnter={() => setIsHovered(true)}
			onMouseLeave={() => setIsHovered(false)}
		>
			{accent && !selected ? (
				<span
					aria-hidden
					className={`absolute left-0 top-2 bottom-2 w-[3px] rounded-r ${ACCENT_CLASS[accent]}`}
				/>
			) : null}
			{selectable ? (
				<div className="flex w-5 shrink-0 items-center justify-center">
					<Checkbox
						checked={isCheckboxSelected}
						onChange={(next) => onToggleSelect?.(id, next)}
						onClick={(event) => event.stopPropagation()}
						onKeyDown={(event) => event.stopPropagation()}
						label={isCheckboxSelected ? "取消选择邮件" : "选择邮件"}
						size={14}
						boxClassName="rounded-[4px] border-edge-3 focus-visible:ring-offset-1"
					/>
				</div>
			) : null}
			<div className="flex min-w-0 flex-1 items-center px-2 py-2.5 text-left">
				<div className="flex min-w-0 flex-1 flex-col gap-0.5">
					<div className="flex min-w-0 items-center gap-2">
						<span
							data-testid="mail-item-unread"
							aria-hidden={!unread}
							className={`shrink-0 rounded-full ${
								unread ? "h-2 w-2 bg-coral" : "h-0 w-0 bg-transparent"
							}`}
						/>
						<span
							className={`mail-item-sender truncate text-ui ${
								unread ? "font-semibold text-ink" : "font-medium text-ink-2"
							}`}
						>
							{renderHighlightedText(sender, highlightTerms)}
						</span>
						<span
								data-testid="mail-item-subject"
								className={`mail-item-subject-inline min-w-0 flex-1 truncate text-ui ${
									unread ? "font-semibold text-ink" : "text-ink-2"
								}`}
							>
								{renderHighlightedText(subject, highlightTerms)}
						</span>
						<span className="mail-item-signals-inline contents">{renderSignals()}</span>
						<div className="relative shrink-0">
							<span className={`text-meta tabular-nums transition-opacity ${unread ? "text-ink-2" : "text-ink-3"} ${onToggleStar || onArchive || onDelete || onToggleRead ? isHovered ? "opacity-0" : "" : ""}`}>
								{formatDate(date)}
							</span>
							{onToggleStar || onArchive || onDelete || onToggleRead ? (
								<div className={`absolute right-0 top-1/2 flex -translate-y-1/2 items-center gap-1 transition-opacity ${isHovered ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0"}`}>
									{onToggleStar ? (
										<button type="button" data-testid="mail-item-star" className={`inline-flex h-7 w-7 items-center justify-center rounded-md bg-transparent transition-colors hover:bg-transparent ${starred ? "text-amber" : "text-ink-3"}`} onClick={(event) => { event.stopPropagation(); onToggleStar(id, !starred); }} aria-label={starred ? "取消星标" : "加星标"} title={starred ? "取消星标" : "加星标"}>
											<StarIcon size={14} weight={starred ? "fill" : "regular"} />
										</button>
									) : null}
									{onArchive ? (
										<button type="button" className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-transparent text-ink-3 transition-colors hover:bg-transparent hover:text-ink" onClick={(event) => { event.stopPropagation(); onArchive(id); }} aria-label="归档" title="归档"><ArchiveIcon size={14} /></button>
									) : null}
									{onDelete ? (
										<button type="button" className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-transparent text-ink-3 transition-colors hover:bg-transparent hover:text-red" onClick={(event) => { event.stopPropagation(); onDelete(id); }} aria-label="移到回收站" title="移到回收站"><TrashIcon size={14} /></button>
									) : null}
									{onToggleRead ? (
										<button type="button" className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-transparent text-ink-3 transition-colors hover:bg-transparent hover:text-ink" onClick={(event) => { event.stopPropagation(); onToggleRead(id, !unread); }} aria-label={unread ? "标记为已读" : "标记为未读"} title={unread ? "标记为已读" : "标记为未读"}>{unread ? <EnvelopeOpenIcon size={14} /> : <EnvelopeSimpleIcon size={14} />}</button>
									) : null}
								</div>
							) : null}
						</div>
					</div>
					<div className="mail-item-subject-detail flex min-w-0 items-center gap-1.5 overflow-hidden">
							<div
								data-testid="mail-item-subject"
								className={`min-w-0 flex-1 truncate text-ui ${
									unread ? "font-semibold text-ink" : "text-ink-2"
								}`}
							>
								{renderHighlightedText(subject, highlightTerms)}
							</div>
							{renderSignals()}
					</div>
				</div>
			</div>
			{actionError ? (
				<div
					data-testid="mail-item-error"
					role="alert"
					className="absolute inset-x-0 bottom-0 flex items-center gap-1.5 border-t border-red/20 bg-red-bg px-2 py-0.5 text-xs text-red"
				>
					<WarningCircleIcon size={12} weight="fill" className="shrink-0" />
					<span className="min-w-0 flex-1 truncate">{actionError.message}</span>
					<button
						type="button"
						data-testid="mail-item-error-retry"
						className="shrink-0 font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
						onClick={(event) => {
							event.stopPropagation();
							actionError.onRetry();
						}}
					>
						重试
					</button>
				</div>
			) : null}
		</div>
	);
}

function mailItemTagsEqual(
	a: MailItemTag[] | undefined,
	b: MailItemTag[] | undefined,
): boolean {
	if (a === b) return true;
	const aLen = a ? a.length : 0;
	const bLen = b ? b.length : 0;
	if (aLen !== bLen) return false;
	if (aLen === 0) return true;
	return a!.every(
		(t, i) => t.label === b![i]!.label && t.variant === b![i]!.variant,
	);
}

/**
 * Value-based prop comparison so a row skips re-rendering when nothing visually
 * changed — even though `style` / `tags` arrive as fresh objects each render.
 * Callbacks are intentionally NOT compared: callers pass stable identities
 * (useCallback, no selectedEmailId capture), so skipping them is safe.
 */
function mailItemPropsEqual(prev: MailItemProps, next: MailItemProps): boolean {
	return (
		prev.id === next.id &&
		prev.selected === next.selected &&
		prev.checkboxSelected === next.checkboxSelected &&
		prev.starred === next.starred &&
		prev.unread === next.unread &&
		prev.hasAttachment === next.hasAttachment &&
		prev.aiStatus === next.aiStatus &&
		prev.accent === next.accent &&
		prev.selectable === next.selectable &&
		prev.className === next.className &&
		prev.sender === next.sender &&
		prev.subject === next.subject &&
		prev.snippet === next.snippet &&
		prev.date === next.date &&
		prev.highlightTerms === next.highlightTerms &&
		prev.style?.top === next.style?.top &&
		prev.style?.height === next.style?.height &&
		mailItemTagsEqual(prev.tags, next.tags)
	);
}

export const MailItem = memo(MailItemBase, mailItemPropsEqual);
export default MailItem;
