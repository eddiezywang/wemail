// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Canonical folder ID constants.
 *
 * Every part of the stack — API routes, Durable Object, MCP, agent,
 * frontend sidebar — references folder IDs. This module is the single
 * source of truth so we don't scatter magic strings everywhere.
 */

export const Folders = {
	INBOX: "inbox",
	SENT: "sent",
	DRAFT: "draft",
	ARCHIVE: "archive",
	TRASH: "trash",
	SPAM: "spam",
} as const;

export type FolderId = (typeof Folders)[keyof typeof Folders];

/**
 * Virtual folder IDs.
 *
 * These are UI-only views over the regular folders — there is no
 * server-side folder of this name. The renderer applies a predicate
 * over the inbox query to derive the list. Backend tools and the
 * agent prompt remain unchanged: they only see {@link Folders}.
 *
 * Snoozed and Scheduled need durable storage to survive a reload, but
 * we ship them now with a UI-store-backed local map so the UX matches
 * the upstream reference. The empty state surfaces "Local only — durable
 * storage coming soon" so we don't lie about persistence.
 */
export const VirtualFolders = {
	STARRED: "starred",
	SNOOZED: "snoozed",
	SCHEDULED: "scheduled",
	NEWSLETTER: "newsletter",
	TODOS: "todos",
	ALL_MAIL: "all-mail",
} as const;

export type VirtualFolderId =
	(typeof VirtualFolders)[keyof typeof VirtualFolders];

export const VIRTUAL_FOLDER_IDS: readonly VirtualFolderId[] = [
	VirtualFolders.STARRED,
	VirtualFolders.SNOOZED,
	VirtualFolders.SCHEDULED,
	VirtualFolders.NEWSLETTER,
	VirtualFolders.TODOS,
	VirtualFolders.ALL_MAIL,
];

export function isVirtualFolder(id: string): id is VirtualFolderId {
	return (VIRTUAL_FOLDER_IDS as readonly string[]).includes(id);
}

/**
 * System folder IDs that appear in the sidebar (excludes spam).
 * Order here matches the sidebar display order.
 */
export const SYSTEM_FOLDER_IDS: readonly FolderId[] = [
	Folders.INBOX,
	Folders.SENT,
	Folders.DRAFT,
	Folders.ARCHIVE,
	Folders.TRASH,
];

/**
 * Human-readable display names for folder IDs.
 * Used in the sidebar, search result badges, and tool descriptions.
 */
export const FOLDER_DISPLAY_NAMES: Record<string, string> = {
	[Folders.INBOX]: "收件箱",
	[Folders.SENT]: "已发送",
	[Folders.DRAFT]: "草稿",
	[Folders.ARCHIVE]: "归档",
	[Folders.TRASH]: "回收站",
	[Folders.SPAM]: "垃圾邮件",
	[VirtualFolders.STARRED]: "已加星标",
	[VirtualFolders.SNOOZED]: "已延后",
	[VirtualFolders.SCHEDULED]: "定时发送",
	[VirtualFolders.NEWSLETTER]: "订阅邮件",
	[VirtualFolders.TODOS]: "待办",
	[VirtualFolders.ALL_MAIL]: "所有邮件",
};

const FOLDER_DISPLAY_ALIASES: Record<string, string> = {
	inbox: "收件箱",
	"[gmail]/inbox": "收件箱",
	收件箱: "收件箱",
	sent: "已发送",
	"sent items": "已发送",
	"sent mail": "已发送",
	"sent messages": "已发送",
	已发送: "已发送",
	draft: "草稿",
	drafts: "草稿",
	草稿: "草稿",
	archive: "归档",
	archived: "归档",
	归档: "归档",
	trash: "回收站",
	bin: "回收站",
	"deleted items": "回收站",
	回收站: "回收站",
	已删除: "回收站",
	spam: "垃圾邮件",
	junk: "垃圾邮件",
	"junk mail": "垃圾邮件",
	垃圾邮件: "垃圾邮件",
	病毒邮件: "病毒邮件",
};

/** Formatted string for tool parameter descriptions (agent + MCP). */
export const FOLDER_TOOL_DESCRIPTION =
	"Folder to list: inbox, sent, draft, archive, trash";

/** Formatted string for move-email tool descriptions. */
export const MOVE_FOLDER_TOOL_DESCRIPTION =
	"Target folder: inbox, sent, draft, archive, trash";

/**
 * Look up a display name for a folder ID, preserving unknown provider names.
 */
export function getFolderDisplayName(folderId: string): string {
	const trimmed = folderId.trim();
	return FOLDER_DISPLAY_ALIASES[trimmed.toLowerCase()] ?? trimmed;
}

const SENT_FOLDER_ALIASES = new Set([
	"sent",
	"sent items",
	"sent mail",
	"sent messages",
	"[gmail]/sent mail",
	"已发送",
	"已寄出",
	"送信済み",
	"送信済みメール",
	"отправленные",
]);

/** Whether a physical provider folder contains messages sent by the user. */
export function isSentFolder(folder: string | null | undefined): boolean {
	return SENT_FOLDER_ALIASES.has(folder?.trim().toLowerCase() ?? "");
}

const DEFAULT_SEARCH_EXCLUDED_FOLDERS = new Set([
	"draft",
	"drafts",
	"草稿",
	"trash",
	"bin",
	"deleted items",
	"deleted messages",
	"回收站",
	"已删除",
	"已刪除",
	"spam",
	"junk",
	"junk mail",
	"垃圾邮件",
	"垃圾郵件",
	"病毒邮件",
	"病毒郵件",
]);

/** Whether a physical folder is excluded from the default global search. */
export function isDefaultSearchExcludedFolder(folder: string): boolean {
	const normalized = folder.trim().toLowerCase();
	if (!normalized) return false;
	if (DEFAULT_SEARCH_EXCLUDED_FOLDERS.has(normalized)) return true;
	return (
		normalized.includes("/trash") ||
		normalized.includes("/spam") ||
		normalized.includes("/junk") ||
		normalized.includes("/draft")
	);
}

/** Normalize RFC Message-ID for logical-mail comparisons. */
export function normalizeMailMessageId(messageId: string | null | undefined): string | null {
	const trimmed = messageId?.trim();
	if (!trimmed) return null;
	const inner = trimmed.replace(/^<+|>+$/g, "").trim().toLowerCase();
	return inner ? `<${inner}>` : null;
}

export function logicalMailKey(input: { id: string; messageId?: string | null }): string {
	return normalizeMailMessageId(input.messageId) ?? `id:${input.id}`;
}

function folderPreference(folder: string): number {
	const normalized = folder.trim().toLowerCase();
	if (normalized === "inbox" || normalized === "收件箱") return 0;
	if (["sent", "sent items", "sent mail", "已发送"].includes(normalized)) return 1;
	if (["archive", "archived", "all mail", "归档"].includes(normalized)) return 2;
	return 3;
}

export interface LogicalMailCopy {
	id: string;
	folder: string;
	messageId?: string | null;
	bodyText?: string | null;
	bodyHtml?: string | null;
	bodyState?: "ready" | "missing" | "failed";
	hasAttachments?: boolean;
	attachments?: unknown[];
	updatedAt?: string;
}

/** Pick the physical copy most likely to open successfully. */
export function selectPreferredMailCopy<T extends LogicalMailCopy>(copies: readonly T[]): T | undefined {
	return [...copies].sort((left, right) => {
		const bodyRank = (copy: T) => {
			if (copy.bodyState === "ready" || copy.bodyText?.trim() || copy.bodyHtml?.trim()) return 0;
			if (copy.bodyState === "failed") return 2;
			return 1;
		};
		const bodyDifference = bodyRank(left) - bodyRank(right);
		if (bodyDifference !== 0) return bodyDifference;
		const folderDifference = folderPreference(left.folder) - folderPreference(right.folder);
		if (folderDifference !== 0) return folderDifference;
		const attachmentRank = (copy: T) =>
			copy.hasAttachments && (copy.attachments?.length ?? 0) === 0 ? 1 : 0;
		const attachmentDifference = attachmentRank(left) - attachmentRank(right);
		if (attachmentDifference !== 0) return attachmentDifference;
		const updatedDifference = (right.updatedAt ?? "").localeCompare(left.updatedAt ?? "");
		return updatedDifference || left.id.localeCompare(right.id);
	})[0];
}
