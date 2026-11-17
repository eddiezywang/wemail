// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Unified intelligence card. It keeps summary, tags, and todos in one
 * warm surface above the email body. File attachments stay in the mail
 * attachment section, not inside this summary surface.
 *
 * Visual model:
 * - Warm paper surface with a quiet coral edge, matching the unified WeMail UI.
 * - "摘要" header in coral on the left.
 * - Summary bullets (• coral mark, ink text).
 * - Tags as inline chips (re-using `EmailSmartTags`).
 * - Todos as a compact checklist with the same coral fill on completion.
 * - Smart links as coral-bordered pill buttons at the bottom.
 *
 * The card is intentionally absent until a real, renderable summary exists.
 * Queue, running, failed, skipped, and empty states stay invisible so the
 * email detail does not expose background processing to the user.
 */

import { ArrowSquareOutIcon } from "@phosphor-icons/react/ArrowSquareOut";
import { CheckCircleIcon } from "@phosphor-icons/react/CheckCircle";
import { CircleIcon } from "@phosphor-icons/react/Circle";
import { WarningIcon } from "@phosphor-icons/react/Warning";
import { ChartLineIcon } from "@phosphor-icons/react/ChartLine";
import { UploadSimpleIcon } from "@phosphor-icons/react/UploadSimple";
import { CaretDownIcon } from "@phosphor-icons/react/CaretDown";
import { ArrowRightIcon } from "@phosphor-icons/react/ArrowRight";
import { useEffect, useRef, useState } from "react";
import type {
	IntelligenceJob,
	LinkExtractionResult,
	MailSceneAction,
	TodoExtractionResult,
} from "shared/wemail/intelligence";
import type {
	IntelligenceStatus,
	SummaryResult,
	TagResult,
} from "~/types/wemail";
import { handleExternalLinkClick } from "~/lib/external-links";
import { useCompleteTodo } from "~/hooks/useTodos";
import {
	Popover,
	PopoverAnchor,
	PopoverContent,
} from "~/components/ui/popover";
import EmailSmartTags from "./EmailSmartTags";

export interface SummaryEmphasisSelection {
	target: "bullet" | "action";
	index: number;
	start: number;
	end: number;
}

export interface EmailIntelligenceCardProps {
	emailId: string;
	accountId?: string;
	summaryStatus: IntelligenceStatus;
	summary?: SummaryResult | null;
	/** Rendering-only emphasis ranges. Summary strings remain unchanged. */
	summaryEmphasis?: readonly SummaryEmphasisSelection[];
	/** Optional persistence hook for user-created emphasis ranges. */
	onSummaryEmphasisChange?: (selections: readonly SummaryEmphasisSelection[]) => void;
	summaryError?: string;
	summaryJob?: Pick<
		IntelligenceJob,
		"id" | "status" | "attempts" | "maxAttempts" | "createdAt" | "updatedAt" | "startedAt" | "finishedAt" | "error"
	>;
	canRetrySummary?: boolean;
	onRetrySummary?: () => void;
	onOpenSummaryCenter?: () => void;
	summaryRetrying?: boolean;
	tagsStatus: IntelligenceStatus;
	tags?: TagResult | null;
	todosStatus?: IntelligenceStatus;
	todos?: TodoExtractionResult | undefined;
	linksStatus?: IntelligenceStatus;
	links?: LinkExtractionResult | undefined;
	sceneActions?: MailSceneAction[];
	onSceneAction?: (action: MailSceneAction) => void;
}

const FILE_LINK_PATTERN = /\.(pdf|xml|ofd|docx?|xlsx?|pptx?|csv|txt|zip|rar|7z)(\?|#|$|\s)/i;
const STATIC_RESOURCE_PATH_PATTERN = /\.(?:png|jpe?g|gif|webp|svg|ico|bmp|css|m?js|map|woff2?|ttf|otf|eot)$/i;
const URL_PATTERN = /https?:\/\/[^\s<>"')]+/gi;

const MEETING_HOSTS = /(zoom\.us|meet\.google\.com|teams\.microsoft\.com|webex\.com|whereby\.com)/i;
const APPROVAL_HOSTS = /(docusign\.|adobesign\.|hellosign\.|eversign\.)/i;
const DOC_HOSTS = /(docs\.google\.com|drive\.google\.com|notion\.so|yuque\.com|feishu\.cn|larksuite\.com|sharepoint\.com|dropbox\.com|box\.com)/i;
const PAY_HOSTS = /(pay|billing|checkout|invoice|alipay|tenpay)/i;

/**
 * Hosts that only ever serve XML / HTML namespaces, schemas, or spec URIs.
 * They carry no business meaning and must never surface as action chips
 * (e.g. the xmlns="http://www.w3.org/1999/xhtml/" declaration picked out of
 * raw HTML by the bare-URL regex).
 */
const NOISE_HOSTS = /(?:^|\.)(?:w3\.org|schemas\.microsoft\.com|schemas\.openxmlformats\.org|purl\.org|xmlns\.com|ns\.adobe\.com|docs\.oasis-open\.org|www\.ietf\.org|rdfs\.org|www\.iso\.org)$/i;

const HTML_ANCHOR_PATTERN = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;

function decodeEntities(text: string): string {
	return text
		.replace(/&amp;/gi, "&")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&quot;/gi, '"')
		.replace(/&#39;/gi, "'")
		.replace(/<[^>]+>/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function isNoiseUrl(raw: string): boolean {
	try {
		const url = new URL(raw);
		return NOISE_HOSTS.test(url.hostname.toLowerCase()) || STATIC_RESOURCE_PATH_PATTERN.test(url.pathname);
	} catch {
		return false;
	}
}

function isUrlText(text: string): boolean {
	return /^https?:\/\//i.test(text.trim());
}

/**
 * Derive a meaningful action label from a URL when no anchor text is
 * available. Never leaks the low-quality "打开 {域名}" fallback — defaults
 * to "查看详情" for generic URLs.
 */
function labelForUrl(url: string): string {
	if (FILE_LINK_PATTERN.test(url)) return "下载文件";
	let host = "";
	try {
		host = new URL(url).hostname.toLowerCase();
	} catch {
		return "查看详情";
	}
	if (MEETING_HOSTS.test(host)) return "加入会议";
	if (APPROVAL_HOSTS.test(host)) return "查看审批";
	if (DOC_HOSTS.test(host)) return "查看文档";
	if (PAY_HOSTS.test(host)) return "查看账单";
	return "查看详情";
}

function labelFromUrlContext(body: string, urlIndex: number, url: string): string {
	const context = decodeEntities(body.slice(Math.max(0, urlIndex - 80), urlIndex))
		.replace(/<[^>]+>/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	const match = context.match(
		/([\p{L}\p{N}_·（）() -]{2,32}(?:系统|平台|门户|官网|中心|页面|文档|工单|问卷|申请))(?:地址|入口|链接|网址)\s*[:：]?\s*$/u,
	);
	return match?.[1]?.trim() || labelForUrl(url);
}

interface ExtractedLink {
	url: string;
	actionText: string;
	risk: boolean;
	riskReasons: never[];
	category: "navigate";
}

/**
 * Fallback link extractor used before server-side intelligence is available.
 *
 * Prefers real anchor text from HTML — the label comes from the email itself
 * ("查看告警" / "立即处理" / "查看PR #42" …), which is open-ended rather than a
 * fixed enum. Namespace / schema noise hosts (w3.org …) are filtered out so
 * declarations like xmlns="http://www.w3.org/1999/xhtml/" never become chips.
 * Bare URLs with no anchor fall back to host-derived semantic labels, then to
 * "查看详情".
 */
export function extractBodyLinks(body: string | null | undefined): ExtractedLink[] {
	if (!body) return [];
	const seen = new Set<string>();
	const out: ExtractedLink[] = [];
	const push = (url: string, label: string) => {
		const cleaned = url.replace(/[)>"']+$/, "");
		if (!cleaned || seen.has(cleaned) || isNoiseUrl(cleaned)) return;
		seen.add(cleaned);
		out.push({ url: cleaned, actionText: label, risk: false, riskReasons: [], category: "navigate" });
	};

	if (/<a\b/i.test(body)) {
		for (const match of body.matchAll(HTML_ANCHOR_PATTERN)) {
			const url = match[1]!;
			const anchorText = decodeEntities(match[2] ?? "").slice(0, 28);
			push(
				url,
				anchorText && !isUrlText(anchorText)
					? anchorText
					: labelFromUrlContext(body, match.index ?? 0, url),
			);
		}
	}
	for (const match of body.matchAll(URL_PATTERN)) {
		push(match[0], labelFromUrlContext(body, match.index ?? 0, match[0]));
	}
	return out.slice(0, 3);
}

function SceneActionIcon({ action }: { action: MailSceneAction }) {
	if (action.status === "completed") {
		return <CheckCircleIcon size={14} weight="fill" />;
	}
	return action.icon === "chart" ? (
		<ChartLineIcon size={14} weight="bold" />
	) : action.icon === "upload" ? (
		<UploadSimpleIcon size={14} weight="bold" />
	) : (
		<ArrowRightIcon size={14} weight="bold" />
	);
}

function SceneActionButton({
	action,
	onClick,
	showCaret = false,
	expanded,
}: {
	action: MailSceneAction;
	onClick: () => void;
	showCaret?: boolean;
	expanded?: boolean;
}) {
	const completed = action.status === "completed";
	return (
		<button
			type="button"
			disabled={completed}
			data-state={action.status}
			onClick={onClick}
			aria-haspopup={showCaret ? "menu" : undefined}
			aria-expanded={showCaret ? expanded : undefined}
			aria-label={
				showCaret
					? `${action.label}，默认当前邮件，可选择相似邮件`
					: undefined
			}
			className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
				completed
					? "cursor-default border-green/30 bg-green/10 text-green"
					: "border-coral/25 bg-paper text-coral hover:bg-coral/10"
			}`}
		>
			<SceneActionIcon action={action} />
			<span>{action.label}</span>
			{showCaret ? <CaretDownIcon size={12} weight="bold" className="ml-0.5 opacity-70" /> : null}
		</button>
	);
}

function isInsightAggregationAction(action: MailSceneAction) {
	return action.id === "insight-report.aggregate" ||
		action.id === "insight-report.aggregate_24h" ||
		action.id === "insight-report.aggregate_7d" ||
		action.id === "insight-report.regenerate_24h" ||
		action.id === "insight-report.regenerate_7d";
}

function isInsightScopePrimaryAction(action: MailSceneAction) {
	return action.id === "monitoring.generate_chart" || action.id === "insight-report.regenerate";
}

function InsightReportScopeMenu({
	primaryAction,
	aggregateActions,
	onAction,
}: {
	primaryAction: MailSceneAction;
	aggregateActions: MailSceneAction[];
	onAction: (action: MailSceneAction) => void;
}) {
	const [open, setOpen] = useState(false);
	const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const contentRef = useRef<HTMLDivElement | null>(null);

	const cancelScheduledClose = () => {
		if (closeTimerRef.current === null) return;
		clearTimeout(closeTimerRef.current);
		closeTimerRef.current = null;
	};
	const openMenu = () => {
		cancelScheduledClose();
		setOpen(true);
	};
	const scheduleClose = () => {
		cancelScheduledClose();
		closeTimerRef.current = setTimeout(() => {
			closeTimerRef.current = null;
			setOpen(false);
		}, 160);
	};
	const selectAction = (action: MailSceneAction) => {
		cancelScheduledClose();
		setOpen(false);
		onAction(action);
	};
	const handleBlur = (event: React.FocusEvent<HTMLElement>) => {
		const nextTarget = event.relatedTarget;
		if (
			nextTarget instanceof Node &&
			(event.currentTarget.contains(nextTarget) || contentRef.current?.contains(nextTarget))
		) {
			return;
		}
		scheduleClose();
	};

	useEffect(() => {
		return () => {
			if (closeTimerRef.current !== null) clearTimeout(closeTimerRef.current);
		};
	}, []);

	return (
		<Popover
			open={open}
			onOpenChange={(nextOpen) => {
				cancelScheduledClose();
				setOpen(nextOpen);
			}}
			modal={false}
		>
			<PopoverAnchor asChild>
				<div
					className="inline-flex"
					onPointerEnter={openMenu}
					onPointerLeave={scheduleClose}
					onFocusCapture={openMenu}
					onBlurCapture={handleBlur}
				>
					<SceneActionButton
						action={primaryAction}
						onClick={() => selectAction(primaryAction)}
						showCaret
						expanded={open}
					/>
				</div>
			</PopoverAnchor>
			<PopoverContent
				ref={contentRef}
				align="start"
				side="bottom"
				sideOffset={8}
				collisionPadding={8}
				role="menu"
				aria-label={`${primaryAction.label}范围`}
				onPointerEnter={openMenu}
				onPointerLeave={scheduleClose}
				onFocusCapture={openMenu}
				onBlurCapture={handleBlur}
				className="w-[min(18rem,calc(100vw-2rem))] max-h-[60vh] overflow-y-auto rounded-2xl border-edge-2 bg-paper-2 p-2"
			>
				<div className="relative px-2.5 pb-1.5 pt-1">
					<div className="text-sm font-semibold text-ink">{primaryAction.label}</div>
					<div className="mt-0.5 text-xs text-ink-3">默认分析当前邮件，也可以选择相似邮件范围</div>
				</div>
				<button
					type="button"
					role="menuitem"
					onClick={() => selectAction(primaryAction)}
					className="relative flex w-full items-start gap-2.5 rounded-xl px-2.5 py-2 text-left transition-colors hover:bg-paper-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
				>
					<span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-coral/10 text-coral">
						<ChartLineIcon size={14} weight="bold" />
					</span>
					<span className="min-w-0 flex-1">
						<span className="block text-sm font-medium text-ink">当前邮件</span>
						<span className="mt-0.5 block text-xs text-ink-3">只使用这封邮件 · 默认</span>
					</span>
				</button>
				{aggregateActions.map((aggregateAction) => {
					const preset = aggregateAction.agentContext?.lookbackPreset;
					const windowLabel = preset === "24h" ? "最近 24 小时" : "最近 7 天";
					return (
						<button
							key={aggregateAction.id}
							type="button"
							role="menuitem"
							disabled={aggregateAction.status === "completed"}
							onClick={() => selectAction(aggregateAction)}
							className="relative flex w-full items-start gap-2.5 rounded-xl px-2.5 py-2 text-left transition-colors hover:bg-paper-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:opacity-60"
						>
							<span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-paper-3 text-coral">
								<ChartLineIcon size={14} weight="bold" />
							</span>
							<span className="min-w-0 flex-1">
								<span className="block text-sm font-medium text-ink">相似邮件 · {windowLabel}</span>
								<span className="mt-0.5 block text-xs text-ink-3">
									聚合后{primaryAction.id === "insight-report.regenerate" ? "重新生成报告" : "生成洞察报告"}
								</span>
							</span>
						</button>
					);
				})}
			</PopoverContent>
		</Popover>
	);
}

function hasRenderableText(items: string[] | undefined) {
	return (items ?? []).some((item) => item.trim().length > 0);
}

function getRenderableItems(items: string[] | undefined) {
	return (items ?? []).filter((item) => item.trim().length > 0);
}

function getSummaryBullets(summary: SummaryResult | null | undefined) {
	if (!summary) return [];
	if (
		(summary.schemaVersion === 2 || summary.schemaVersion === 3) &&
		typeof summary.headline === "string"
	) {
		const headline = summary.headline.trim();
		if (summary.displayMode === "one_line") {
			return headline ? [headline] : [];
		}
		return [
			headline,
			...getRenderableItems(summary.details),
		].filter((item) => item.trim().length > 0);
	}
	return getRenderableItems(summary.bullets);
}

function getSummaryActionItems(summary: SummaryResult | null | undefined) {
	if (!summary) return [];
	if (
		(summary.schemaVersion === 2 || summary.schemaVersion === 3) &&
		Array.isArray(summary.actions)
	) {
		if (summary.displayMode === "one_line") return [];
		return getRenderableItems(summary.actions);
	}
	return getRenderableItems(summary.actionItems);
}

function hasRenderableSummary(summary: SummaryResult | null | undefined) {
	return getSummaryBullets(summary).length > 0 ||
		getSummaryActionItems(summary).length > 0;
}

function EmphasizedSummaryText({
	text,
	selections,
}: {
	text: string;
	selections: readonly Pick<SummaryEmphasisSelection, "start" | "end">[];
}) {
	const ranges = selections
		.map(({ start, end }) => ({
			start: Math.max(0, Math.min(text.length, start)),
			end: Math.max(0, Math.min(text.length, end)),
		}))
		.filter(({ start, end }) => end > start)
		.sort((a, b) => a.start - b.start || a.end - b.end)
		.reduce<Array<{ start: number; end: number }>>((merged, range) => {
			const previous = merged.at(-1);
			if (previous && range.start <= previous.end) {
				previous.end = Math.max(previous.end, range.end);
				return merged;
			}
			merged.push({ ...range });
			return merged;
		}, []);

	if (ranges.length === 0) return text;

	const parts: Array<{ text: string; emphasized: boolean }> = [];
	let cursor = 0;
	for (const range of ranges) {
		if (range.start > cursor) {
			parts.push({ text: text.slice(cursor, range.start), emphasized: false });
		}
		parts.push({ text: text.slice(range.start, range.end), emphasized: true });
		cursor = range.end;
	}
	if (cursor < text.length) {
		parts.push({ text: text.slice(cursor), emphasized: false });
	}

	return (
		<>
			{parts.map((part, index) =>
				part.emphasized ? (
					<strong key={`${index}-${part.text}`} className="font-semibold text-ink">
						{part.text}
					</strong>
				) : (
					<span key={`${index}-${part.text}`}>{part.text}</span>
				),
			)}
		</>
	);
}

function textOffsetWithin(root: Node, container: Node, offset: number): number {
	const range = document.createRange();
	range.selectNodeContents(root);
	range.setEnd(container, offset);
	return range.toString().length;
}

function toggleSummaryRange(
	current: readonly SummaryEmphasisSelection[],
	selection: SummaryEmphasisSelection,
): SummaryEmphasisSelection[] {
	const matching = current.filter(
		(item) => item.target === selection.target && item.index === selection.index,
	);
	const fullyCovered = matching.some(
		(item) => item.start <= selection.start && item.end >= selection.end,
	);
	if (!fullyCovered) return [...current, selection];
	return current.flatMap((item) => {
		if (item.target !== selection.target || item.index !== selection.index) return [item];
		if (item.end <= selection.start || item.start >= selection.end) return [item];
		const pieces: SummaryEmphasisSelection[] = [];
		if (item.start < selection.start) pieces.push({ ...item, end: selection.start });
		if (item.end > selection.end) pieces.push({ ...item, start: selection.end });
		return pieces;
	});
}

function readStoredSummaryEmphasis(emailId: string): SummaryEmphasisSelection[] {
	if (typeof window === "undefined") return [];
	try {
		const raw = window.localStorage.getItem(`wemail:summary-emphasis:${emailId}`);
		if (!raw) return [];
		const parsed = JSON.parse(raw) as unknown;
		return Array.isArray(parsed) ? parsed as SummaryEmphasisSelection[] : [];
	} catch {
		return [];
	}
}

function isAttachmentLikeLink(link: LinkExtractionResult["links"][number]) {
	const text = `${link.actionText} ${link.url}`;
	try {
		return link.category === "download" || FILE_LINK_PATTERN.test(text) || STATIC_RESOURCE_PATH_PATTERN.test(new URL(link.url).pathname);
	} catch {
		return link.category === "download" || FILE_LINK_PATTERN.test(text);
	}
}

function isContactLink(link: LinkExtractionResult["links"][number]) {
	return /^mailto:/i.test(link.url);
}

export default function EmailIntelligenceCard(props: EmailIntelligenceCardProps) {
	const completeTodo = useCompleteTodo(props.emailId);
	const [emphasisRanges, setEmphasisRanges] = useState<SummaryEmphasisSelection[]>(
		() => props.summaryEmphasis ? [...props.summaryEmphasis] : readStoredSummaryEmphasis(props.emailId),
	);
	const [activeSelection, setActiveSelection] = useState<
		(SummaryEmphasisSelection & { text: string }) | null
	>(null);
	useEffect(() => {
		setEmphasisRanges(
			props.summaryEmphasis
				? [...props.summaryEmphasis]
				: readStoredSummaryEmphasis(props.emailId),
		);
	}, [props.emailId, props.summaryEmphasis]);
	const captureSummarySelection = () => {
		const selection = window.getSelection();
		if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
			setActiveSelection(null);
			return;
		}
		const range = selection.getRangeAt(0);
		const startElement =
			range.startContainer instanceof Element
				? range.startContainer
				: range.startContainer.parentElement;
		const endElement =
			range.endContainer instanceof Element
				? range.endContainer
				: range.endContainer.parentElement;
		const startTarget = startElement?.closest<HTMLElement>("[data-summary-target]");
		const endTarget = endElement?.closest<HTMLElement>("[data-summary-target]");
		if (!startTarget || startTarget !== endTarget) {
			setActiveSelection(null);
			return;
		}
		const target = startTarget.dataset.summaryTarget;
		const index = Number(startTarget.dataset.summaryIndex);
		if ((target !== "bullet" && target !== "action") || !Number.isInteger(index)) {
			setActiveSelection(null);
			return;
		}
		const start = textOffsetWithin(startTarget, range.startContainer, range.startOffset);
		const end = textOffsetWithin(startTarget, range.endContainer, range.endOffset);
		if (end <= start || !selection.toString().trim()) {
			setActiveSelection(null);
			return;
		}
		setActiveSelection({ target, index, start, end, text: selection.toString() });
	};
	const applySummaryEmphasis = () => {
		if (!activeSelection) return;
		const { text: _text, ...range } = activeSelection;
		const next = toggleSummaryRange(emphasisRanges, range);
		setEmphasisRanges(next);
		props.onSummaryEmphasisChange?.(next);
		if (!props.summaryEmphasis && typeof window !== "undefined") {
			try {
				window.localStorage.setItem(
					`wemail:summary-emphasis:${props.emailId}`,
					JSON.stringify(next),
				);
			} catch {
				// Local persistence is best-effort; rendering remains immediate.
			}
		}
		setActiveSelection(null);
		window.getSelection()?.removeAllRanges();
	};

	const renderableBullets = getSummaryBullets(props.summary);
	const renderableActionItems = getSummaryActionItems(props.summary);
	const summaryReady =
		props.summaryStatus === "succeeded" && hasRenderableSummary(props.summary);
	const sceneActions = props.sceneActions ?? [];
	const summaryBlocked = props.summaryStatus === "skipped" && !!props.summaryError;
	if (!summaryReady && !summaryBlocked && sceneActions.length === 0) return null;
	const tagList = props.tags?.tags ?? [];
	const hasSystemTags = props.tags?.system
		? Object.values(props.tags.system).some((signal) => signal.matched)
		: false;
	const hasContentTags = (props.tags?.contentTags?.length ?? 0) > 0;
	const showTags = tagList.length > 0 || hasSystemTags || hasContentTags;

	const todoList = props.todos?.todos ?? [];
	const linkList = (props.links?.links ?? []).filter(
		(link) => !isAttachmentLikeLink(link) && !isContactLink(link),
	);
	const hasLinks = linkList.length > 0 || !!props.links?.unsubscribeUrl;

	return (
		<section
			data-testid="wemail-intelligence-card"
			aria-label="智能摘要"
			className="rounded-[22px] bg-summary-surface px-3.5 py-3"
			onMouseUp={captureSummarySelection}
			onKeyUp={captureSummarySelection}
		>
			{activeSelection ? (
				<header className="mb-1 flex min-h-7 items-center">
					<button
						type="button"
						className="ml-auto inline-flex h-7 items-center gap-1 rounded-md bg-paper-2 px-2 text-xs font-semibold text-ink shadow-[var(--shadow-1)] transition-colors hover:bg-paper-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
						onMouseDown={(event) => event.preventDefault()}
						onClick={applySummaryEmphasis}
						aria-label="将选中的摘要文字切换为加粗"
						title={activeSelection.text}
					>
						<strong>B</strong>
						{emphasisRanges.some(
							(item) =>
								item.target === activeSelection.target &&
								item.index === activeSelection.index &&
								item.start <= activeSelection.start &&
								item.end >= activeSelection.end,
						) ? "取消加粗" : "加粗所选文字"}
					</button>
				</header>
			) : null}

			{summaryReady && renderableBullets.length > 0 ? (
				<ul
					className="space-y-0.5 text-[14px] leading-[21px] tracking-[-0.2px] text-ink select-text"
					data-testid="wemail-intelligence-bullets"
				>
					{renderableBullets.map((b, i) => (
						<li key={i} className="flex gap-1.5">
							<span className="shrink-0 text-coral/80">•</span>
							<span
								className="flex-1"
								data-summary-target="bullet"
								data-summary-index={i}
							>
								<EmphasizedSummaryText
									text={b}
									selections={emphasisRanges.filter(
										(selection) => selection.target === "bullet" && selection.index === i,
									)}
								/>
							</span>
						</li>
					))}
				</ul>
			) : null}

			{summaryReady && renderableActionItems.length > 0 ? (
				<ul
					className="mt-1.5 space-y-0.5 text-[14px] leading-[21px] tracking-[-0.2px] text-ink select-text"
					data-testid="wemail-intelligence-action-items"
				>
					{renderableActionItems.map((a, i) => (
						<li key={i} className="flex gap-1.5">
							<span className="shrink-0 text-coral">→</span>
							<span
								className="flex-1"
								data-summary-target="action"
								data-summary-index={i}
							>
								<EmphasizedSummaryText
									text={a}
									selections={emphasisRanges.filter(
										(selection) => selection.target === "action" && selection.index === i,
									)}
								/>
							</span>
						</li>
					))}
				</ul>
			) : null}

			{showTags ? (
				<div className="mt-3 min-w-0">
					<EmailSmartTags
						status={props.tagsStatus}
						tags={props.tags}
						emailId={props.emailId}
						accountId={props.accountId}
					/>
				</div>
			) : null}

			{summaryBlocked ? (
				<p className="text-[13px] leading-5 text-ink-3" data-testid="wemail-summary-blocked">
					{props.summaryError}
				</p>
			) : null}

			{todoList.length > 0 ? (
				<div className="mt-3 border-t border-edge/70 pt-2.5">
					<ul
						className="space-y-1.5 select-text"
						data-testid="wemail-intelligence-todos"
					>
						{todoList.map((todo, idx) => {
							const id = todo.id ?? `${props.emailId}-todo-${idx}`;
							const done = todo.status === "confirmed";
							return (
								<li key={id} className="flex items-start gap-2 text-sm">
									<button
										type="button"
										onClick={() => todo.id && completeTodo.mutate(todo.id)}
										disabled={done || !todo.id || completeTodo.isPending}
										aria-label={done ? "已完成" : "标记完成"}
										className="mt-0.5 text-ink-3 hover:text-coral disabled:cursor-default shrink-0"
									>
										{done ? (
											<CheckCircleIcon
												size={14}
												weight="fill"
												className="text-coral"
											/>
										) : (
											<CircleIcon size={14} weight="regular" />
										)}
									</button>
									<span
										className={`flex-1 leading-relaxed ${
											done ? "text-ink-3 line-through" : "text-ink"
										}`}
									>
										{todo.title}
									</span>
								</li>
							);
						})}
					</ul>
				</div>
			) : null}

			{hasLinks ? (
				<div className="mt-3 flex flex-wrap gap-1.5">
					{props.links?.unsubscribeUrl ? (
						<a
							href={props.links.unsubscribeUrl}
							rel="noreferrer"
							onClick={(event) =>
								handleExternalLinkClick(event.nativeEvent, props.links?.unsubscribeUrl)
							}
							className="wemail-pill inline-flex h-6 items-center gap-1 px-2.5 text-xs font-medium text-coral"
						>
							<ArrowSquareOutIcon size={11} weight="bold" />
							一键退订
						</a>
					) : null}
					{linkList.map((link, idx) => (
						<a
							key={`${link.url}-${idx}`}
							href={link.url}
							rel="noreferrer"
							onClick={(event) =>
								handleExternalLinkClick(event.nativeEvent, link.url)
							}
							title={link.url}
							className="wemail-pill inline-flex h-6 max-w-full items-center gap-1 px-2.5 text-xs font-medium text-coral"
						>
							{link.risk ? <WarningIcon size={11} weight="bold" /> : null}
							<span className="truncate max-w-[220px]">{link.actionText}</span>
						</a>
					))}
				</div>
			) : null}

			{sceneActions.length > 0 ? (
				<div
					className="mt-3 flex flex-wrap gap-2 border-t border-edge/70 pt-3"
					data-testid="wemail-scene-actions"
				>
					{sceneActions.map((action) => {
						if (isInsightAggregationAction(action)) {
										const hasScopePrimary = sceneActions.some(isInsightScopePrimaryAction);
										if (hasScopePrimary) return null;
									}
										if (isInsightScopePrimaryAction(action)) {
							const aggregateActions = sceneActions.filter(
								(candidate) => isInsightAggregationAction(candidate),
							);
							if (aggregateActions.length > 0) {
								return (
									<InsightReportScopeMenu
										key={action.id}
										primaryAction={action}
										aggregateActions={aggregateActions}
										onAction={(selectedAction) => props.onSceneAction?.(selectedAction)}
									/>
								);
							}
						}
						return (
							<SceneActionButton
								key={action.id}
								action={action}
								onClick={() => props.onSceneAction?.(action)}
							/>
						);
					})}
				</div>
			) : null}
		</section>
	);
}
