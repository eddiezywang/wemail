// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Shared utility functions used across the frontend.
 *
 * Date formatting has been consolidated into `shared/dates.ts`.
 * Re-export for backwards compatibility with existing imports.
 */
import DOMPurify from "dompurify";
import { formatQuotedDate } from "shared/dates";
import type { WemailAddress } from "../../shared/wemail/mail";
import {
	resolveSignatureIdentity,
	SIGNATURE_BRAND,
	SIGNATURE_BRAND_COLOR,
} from "../../shared/wemail/signature";
import { resolveApiUrl } from "~/services/api";
import type { Attachment } from "~/types";

export {
	formatListDate,
	formatDetailDate,
	formatShortDate,
} from "shared/dates";

/** @deprecated Use `formatQuotedDate` from `shared/dates` directly. */
export const formatComposeDate = formatQuotedDate;

/**
 * Format a byte count as a human-readable file size.
 */
export function formatBytes(bytes: number, decimals = 1): string {
	if (bytes === 0) return "0 B";
	const k = 1024;
	const dm = decimals < 0 ? 0 : decimals;
	const sizes = ["B", "KB", "MB", "GB"];
	const i = Math.floor(Math.log(bytes) / Math.log(k));
	return `${Number.parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

/**
 * Compact token-count formatter for AI usage surfaces. Collapses large
 * counts to `M`/`k` suffixes (e.g. 16M, 5.5M, 246k) and falls back to a
 * locale-grouped integer for small values.
 */
export function formatTokenCount(value: number): string {
	if (value >= 1_000_000) {
		return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
	}
	if (value >= 1_000) {
		return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}k`;
	}
	return value.toLocaleString("zh-CN");
}

/**
 * Split a comma-separated email field into individual addresses.
 */
export function splitEmailList(value?: string | null): string[] {
	return (value || "")
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean);
}

/**
 * Convert a list of addresses into the API payload format.
 */
export function toEmailListValue(addresses: string[]): string | string[] | undefined {
	if (addresses.length === 0) return undefined;
	return addresses.length === 1 ? addresses[0] : addresses;
}

/**
 * Parse a single recipient string ("Alice <a@x>" / "a@x") into a
 * structured `WemailAddress`. Returns null when the trimmed input is
 * empty so callers can `.filter(Boolean)` cleanly.
 */
export function parseAddressString(input: string): WemailAddress | null {
	const trimmed = input.trim();
	if (!trimmed) return null;
	const angle = trimmed.match(/^(.*?)\s*<([^>]+)>\s*$/);
	if (angle) {
		const name = angle[1].trim().replace(/^"|"$/g, "");
		return { email: angle[2].trim(), name: name || undefined };
	}
	return { email: trimmed };
}

/**
 * Parse a comma-separated recipient list into structured
 * `WemailAddress[]` for the canonical draft and outbox protocols,
 * which require objects rather than strings.
 */
export function parseAddressList(value?: string | null): WemailAddress[] {
	const addrs: WemailAddress[] = [];
	for (const entry of splitEmailList(value)) {
		const parsed = parseAddressString(entry);
		if (parsed) addrs.push(parsed);
	}
	return addrs;
}

/**
 * Convert HTML content to plain text.
 * Uses DOM APIs so must only be called client-side.
 */
export function htmlToPlainText(html: string): string {
	// Sanitize with DOMPurify before DOM parsing to prevent XSS during innerHTML assignment.
	// DOMPurify strips all dangerous content (scripts, event handlers, etc.)
	// while preserving structural HTML for text extraction.
	const sanitized = DOMPurify.sanitize(html);
	const div = document.createElement("div");
	div.innerHTML = sanitized
		.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/p>/gi, "\n\n")
		.replace(/<p[^>]*>/gi, "")
		.replace(/<div[^>]*>/gi, "")
		.replace(/<\/div>/gi, "\n");
	return (div.textContent || div.innerText || "").trim();
}

/**
 * Strip all HTML tags from a string.
 */
export function stripHtml(html: string): string {
	const withoutNonContent = html
		.replace(/<(style|script|noscript|head)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
		.replace(/<(style|script|noscript|head)\b[^>]*>[\s\S]*/gi, " ");
	return decodeHtmlEntities(withoutNonContent.replace(/<[^>]*>/g, " "))
		.replace(/\s+/g, " ")
		.trim();
}

function decodeHtmlEntities(text: string): string {
	return text
		.replace(/&#(\d+);/g, (_match: string, code: string) =>
			String.fromCharCode(Number(code)),
		)
		.replace(/&#x([0-9a-f]+);/gi, (_match: string, hex: string) =>
			String.fromCharCode(Number.parseInt(hex, 16)),
		)
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&apos;/g, "'")
		.replace(/&nbsp;/g, " ");
}

export function getSnippetText(
	snippet?: string | null,
	maxLength = 100,
): string {
	if (!snippet) return "";

	const clean = decodeHtmlEntities(
		snippet
			.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
			.replace(/<style[^>]*>[\s\S]*/gi, "")
			.replace(/<[^>]*>/g, " ")
			.replace(/<[^>]*$/g, ""),
	)
		.replace(/\s+/g, " ")
		.trim();

	if (!clean) return "";
	return clean.length > maxLength ? `${clean.slice(0, maxLength)}...` : clean;
}

/**
 * Escape all five OWASP-recommended HTML special characters in plain text.
 * Safe for use in both text content and attribute contexts.
 */
export function escapeHtml(text: string): string {
	if (!text) return "";
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

/**
 * Generate the HTML signature block for compose forms.
 */
export function resolveSignatureText(input: {
	customText?: string;
	displayName?: string;
	emailAddress?: string;
	directoryName?: string;
}): string {
	const customText = input.customText?.trim();
	if (customText) return customText;
	return resolveSignatureIdentity(input);
}

export function getSignatureBlock(
	settings?: {
		signature?: { enabled: boolean; text?: string; html?: string };
	},
	brandUrl?: string,
): string {
	const sig = settings?.signature;
	if (sig?.enabled && (sig?.html || sig?.text)) {
		// Sanitize HTML signatures with DOMPurify to allow safe formatting
		// (bold, italic, links, etc.) while stripping scripts and event handlers.
		// Text signatures are HTML-escaped since they have no formatting.
		const content = sig.html
			? DOMPurify.sanitize(sig.html)
			: escapeHtml(sig.text || "").replace(/\r?\n/g, "<br>");
		const safeUrl = brandUrl?.trim() ?? "";
		const brand = safeUrl
			? `<a href="${escapeHtml(safeUrl)}" target="_blank" rel="noopener noreferrer" style="color: ${SIGNATURE_BRAND_COLOR}; text-decoration: none;"><strong><span style="color: ${SIGNATURE_BRAND_COLOR};">${SIGNATURE_BRAND}</span></strong></a>`
			: `<strong><span style="color: ${SIGNATURE_BRAND_COLOR};">${SIGNATURE_BRAND}</span></strong>`;
		return `<div data-wemail-signature="true" style="margin-top: 18px; text-align: left; color: #44403c; font-size: 14px; font-weight: 400; line-height: 1.45;"><div style="font-weight: 400;">--<br><br>${content}<br></div><p data-wemail-signature-brand="true" style="margin: 5px 0 0; color: #a8a29e; font-size: 11px; font-weight: 400;">Sent with ${brand}</p></div>`;
	}
	return "";
}

/**
 * Build a quoted reply block HTML string from original email data.
 */
export function buildQuotedReplyBlock(
	dateStr: string | undefined,
	sender: string,
	body: string,
): string {
	if (!body) return "";
	const formattedDate = formatComposeDate(dateStr);
	
	// HTML-escape sender to prevent <john@example.com> from disappearing as a tag
	const escapedSender = escapeHtml(sender);

	// Sanitize the body to plain text to prevent stored XSS.
	// The original HTML renders safely in the sandboxed iframe, but quoted
	// reply blocks are injected into the compose editor where raw HTML would
	// execute. Convert to escaped plain text instead.
	const bodyToQuote = escapeHtml(stripHtml(body)).replace(/\n/g, "<br>");

	return `<br><blockquote data-wemail-quoted-reply="true" style="border-left: 2px solid #ccc; margin: 0; padding-left: 1em; color: #666;">On ${formattedDate}, ${escapedSender} wrote:<br><br>${bodyToQuote}</blockquote>`;
}

/**
 * Rewrite CID references in email HTML to API URLs for inline images.
 * Replaces `src="cid:image001@example.com"` with the attachment API endpoint.
 */
export function rewriteInlineImages(
	body: string,
	mailboxId: string,
	emailId: string,
	attachments?: {
		id: string;
		mimetype?: string | null;
		contentId?: string | null;
		content_id?: string | null;
		disposition?: string | null;
	}[],
): string {
	void mailboxId;
	if (!body || !attachments?.length) return body;
	let result = body;
	for (const att of attachments) {
		const contentId = att.contentId ?? att.content_id;
		// Rewrite CID refs for inline parts AND multipart/related CID images
		// that carry no Content-Disposition (common for branded/marketing mail).
		// Deliberate superset of the parse-time capture (image/* with a CID):
		// every image we pre-cache is rendered here; non-image inline parts still
		// render on demand exactly as before.
		const isImage = (att.mimetype ?? "").toLowerCase().startsWith("image/");
		if (contentId && (att.disposition === "inline" || isImage)) {
			const url = resolveApiUrl(
				`/api/mail/messages/${encodeURIComponent(emailId)}/attachments/${encodeURIComponent(att.id)}`,
			);
			// Strip angle brackets from content_id if present
			const cid = contentId.startsWith("<")
				? contentId.slice(1, -1)
				: contentId;
			result = result.replace(new RegExp(`cid:${cid.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "gi"), url);
		}
	}
	// Lazy-load all images so the browser only requests visible ones — huge win
	// for screenshot-heavy alert/call-analysis emails with 10+ inline images.
	result = result.replace(/<img /gi, '<img loading="lazy" ');
	return result;
}

export function getNonInlineAttachments(attachments?: Attachment[]): Attachment[] {
	return attachments?.filter((attachment) => attachment.disposition !== "inline") ?? [];
}

export function getAttachmentUrl(
	mailboxId: string,
	emailId: string,
	attachmentId: string,
): string {
	void mailboxId;
	return resolveApiUrl(
		`/api/mail/messages/${encodeURIComponent(emailId)}/attachments/${encodeURIComponent(attachmentId)}`,
	);
}

/**
 * Time-bucket label for a chronologically-sorted list. Used by the
 * agent sidebar to render section headers (Today, Yesterday, Past 7
 * days, Past 30 days, Older months).
 *
 * Pure function; tests can pass a fixed `now` to make output stable.
 */
export type ConversationTimeBucket =
	| "today"
	| "yesterday"
	| "past7"
	| "past30"
	| "older";

export interface ConversationGroupKey {
	bucket: ConversationTimeBucket;
	/** Stable group identifier — distinguishes monthly older buckets. */
	id: string;
	/** Human-facing label (Chinese, matching the existing sidebar copy). */
	label: string;
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function startOfDay(d: Date): number {
	return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

const OLDER_LABEL_FORMATTER = new Intl.DateTimeFormat(undefined, {
	year: "numeric",
	month: "long",
});

/**
 * Resolve which group an ISO timestamp falls into relative to `now`.
 * Returns a stable id + label suitable for keying React lists.
 */
export function conversationGroupKey(
	iso: string,
	now: Date = new Date(),
): ConversationGroupKey {
	const ts = new Date(iso).getTime();
	if (Number.isNaN(ts)) {
		return { bucket: "older", id: "older-unknown", label: "更早" };
	}
	const todayStart = startOfDay(now);
	const yesterdayStart = todayStart - ONE_DAY_MS;
	const sevenDaysAgo = todayStart - 6 * ONE_DAY_MS;
	const thirtyDaysAgo = todayStart - 29 * ONE_DAY_MS;

	if (ts >= todayStart) {
		return { bucket: "today", id: "today", label: "今天" };
	}
	if (ts >= yesterdayStart) {
		return { bucket: "yesterday", id: "yesterday", label: "昨天" };
	}
	if (ts >= sevenDaysAgo) {
		return { bucket: "past7", id: "past7", label: "过去 7 天" };
	}
	if (ts >= thirtyDaysAgo) {
		return { bucket: "past30", id: "past30", label: "过去 30 天" };
	}
	const d = new Date(ts);
	const id = `older-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
	return { bucket: "older", id, label: OLDER_LABEL_FORMATTER.format(d) };
}

/**
 * Group a chronologically-sorted-DESC list of items by
 * {@link conversationGroupKey}. Preserves input order within each
 * group; group order matches first-occurrence in `items`.
 */
export function groupByConversationTime<T>(
	items: T[],
	getIso: (item: T) => string,
	now: Date = new Date(),
): { key: ConversationGroupKey; items: T[] }[] {
	const buckets = new Map<string, { key: ConversationGroupKey; items: T[] }>();
	const order: string[] = [];
	for (const item of items) {
		const key = conversationGroupKey(getIso(item), now);
		let bucket = buckets.get(key.id);
		if (!bucket) {
			bucket = { key, items: [] };
			buckets.set(key.id, bucket);
			order.push(key.id);
		}
		bucket.items.push(item);
	}
	return order.map((id) => buckets.get(id)!);
}

async function readDownloadError(res: Response): Promise<string> {
	const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
	const raw =
		typeof body?.error === "string" && body.error.length > 0
			? body.error
			: `Download failed: ${res.status}`;
	return mapDownloadErrorMessage(raw, res.status);
}

function mapDownloadErrorMessage(message: string, status: number): string {
	if (/fetch volume limit|限制附件下载/i.test(message)) {
		return "附件下载受邮箱服务器限制，请稍后重试。";
	}
	if (
		status >= 500 &&
		/attachment (?:fetch failed|content unavailable|unavailable)/i.test(message)
	) {
		return "附件下载连接异常，请重试。";
	}
	return message;
}

export async function downloadFile(url: string, filename: string): Promise<void> {
	const res = await fetch(url, { headers: { Accept: "*/*" } });
	if (!res.ok) {
		throw new Error(await readDownloadError(res));
	}
	const blob = await res.blob();
	const objectUrl = URL.createObjectURL(blob);
	const link = document.createElement("a");
	link.href = objectUrl;
	link.download = filename;
	document.body.appendChild(link);
	link.click();
	document.body.removeChild(link);
	window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
}
