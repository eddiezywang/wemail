// Copyright (c) 2026 Cloudflare, Inc.
// Modified for WeMail.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Dev-only demo fixtures for the `__dev/demo-v1` verification route.
 *
 * Installs two shims so the REAL renderer code runs unchanged in a plain
 * browser without the Electron shell:
 *   1. `window.wemailDesktop` — the desktop IPC bridge (mail database,
 *      window controls) that folders/scheduled/categories/detail read from.
 *   2. `window.fetch` — intercepts the remaining `/api/*` HTTP calls.
 *
 * Imported only by the dev-gated `__dev/demo-v1` route, so it never
 * enters the production bundle.
 */

import type { Email, Folder } from "~/types";

type Json = Record<string, unknown>;

// ────────────────────────────────────────────────────────────
// Fixtures — mirrors a 163.com account with provider folders synced.
// NOTE: the provider syncs its own「已发送」folder, which duplicates the
// local system Sent folder. The Phase-1 sidebar dedupe hides it.
// ────────────────────────────────────────────────────────────

const ACCOUNT = {
	id: "demo-account",
	displayName: "Alex Rivera",
	emailAddress: "17371292896@163.com",
	imap: { host: "imap.163.com", port: 993, secure: true, username: "17371292896@163.com" },
	smtp: { host: "smtp.163.com", port: 465, secure: true, username: "17371292896@163.com" },
};

const FOLDERS: Folder[] = [
	{ id: "inbox", name: "收件箱", unreadCount: 2, totalCount: 19 },
	{ id: "sent", name: "已发送", unreadCount: 0, totalCount: 2 },
	{ id: "draft", name: "草稿", unreadCount: 0, totalCount: 1 },
	{ id: "archive", name: "归档", unreadCount: 0, totalCount: 0 },
	{ id: "trash", name: "回收站", unreadCount: 0, totalCount: 3 },
	{ id: "spam", name: "垃圾邮件", unreadCount: 0, totalCount: 7 },
	// 服务器端同步来的文件夹 —— 「已发送」与本地系统文件夹重复：
	{ id: "已发送", name: "已发送", unreadCount: 0, totalCount: 18 },
	{ id: "广告邮件", name: "广告邮件", unreadCount: 0, totalCount: 16 },
	{ id: "银行", name: "银行", unreadCount: 0, totalCount: 19 },
	{ id: "chargpt", name: "chargpt", unreadCount: 0, totalCount: 1 },
	{ id: "chatgpt", name: "chatgpt", unreadCount: 0, totalCount: 4 },
];

const CATEGORIES = [
	{ id: "important", label: "重要", count: 5, unreadCount: 1, system: true },
	{ id: "action_required", label: "需要行动", count: 3, unreadCount: 2, system: true },
];

function at(n: number, hours = 10): string {
	const d = new Date("2026-08-09T20:35:00+08:00");
	d.setUTCDate(d.getUTCDate() - n);
	d.setUTCHours(hours - 8, 24, 0, 0);
	return d.toISOString();
}

function email(partial: Partial<Email> & { id: string; subject: string }): Email {
	return {
		folder_id: "inbox",
		sender: "no_reply",
		recipient: "17371292896@163.com",
		date: at(1),
		read: true,
		starred: false,
		snippet: partial.subject,
		hasAttachments: false,
		...partial,
	} as Email;
}

const INBOX_EMAILS: Email[] = [
	email({ id: "i1", sender: "no_reply", subject: "Apple 提供的收据", date: at(0), hasAttachments: true }),
	email({ id: "i2", sender: "no-reply", subject: "ZHENYU, pack your bags - new deals just landed!", date: at(1) }),
	email({ id: "i3", sender: "no_reply", subject: "iCloud+ 订阅将在5天后到期", date: at(2), hasAttachments: true }),
	email({ id: "i4", sender: "info", subject: "湖北电信电子发票", date: at(4), hasAttachments: true }),
	email({ id: "i5", sender: "no-reply", subject: "ZHENYU, pack your bags - new deals just landed!", date: at(8) }),
	email({ id: "i6", sender: "noreply", subject: "New: Lower GPT-5.6 pricing and Fast mode for Sol", date: at(9) }),
	email({ id: "i7", sender: "notice-noreply", subject: "Qoder Voice is here: Talk to work", date: at(10) }),
	email({ id: "i8", sender: "safe", subject: "网易邮箱账号安全通知", date: at(13), read: false }),
	email({ id: "i9", sender: "member", subject: "登录安全，也能按你的习惯来", date: at(14) }),
	email({ id: "i10", sender: "safe", subject: "新设备登录提醒", date: at(14, 9) }),
	email({ id: "i11", sender: "no-reply", subject: "ZHENYU, pack your bags - new deals just landed!", date: at(15) }),
	email({ id: "i12", sender: "17371292896", subject: "WeMail IMAP INBOX E2E 2026-07-19T16-03-07-923Z", date: at(20), hasAttachments: true }),
	email({ id: "i13", sender: "17371292896", subject: "WeMail IMAP E2E 2026-07-19T16-00-24-113Z", date: at(20, 9) }),
	email({ id: "i14", sender: "bm.no-reply", subject: "GLM Coding Plan 团队版：开发提效，管理无忧", date: at(25) }),
	email({ id: "i15", sender: "no_reply", subject: "iCloud+ 订阅发票", date: at(27), hasAttachments: true }),
	email({ id: "i16", sender: "no_reply", subject: "iCloud+ 订阅将在5天后到期", date: at(33), hasAttachments: true }),
	email({ id: "i17", sender: "info", subject: "湖北电信电子发票", date: at(35), hasAttachments: true }),
];

// 本地「已发送」+ 服务器「已发送」的合并视图 —— 一期方案的数据形态。
const SENT_MERGED_EMAILS: Email[] = [
	email({
		id: "s1",
		folder_id: "sent",
		sender: "我",
		recipient: "safe@126.com",
		subject: "Re: 网易邮箱账号安全通知",
		date: at(13, 11),
		snippet: "已更新授权码，如仍有异常请联系我。",
	}),
	email({
		id: "s2",
		folder_id: "已发送",
		sender: "我",
		recipient: "产品组全员@rcrai.com",
		subject: "Q4 排期同步（网页版发出）",
		date: at(30, 16),
		snippet: "本周已通过公司 Web App 邮箱发出。",
	}),
	email({
		id: "s3",
		folder_id: "sent",
		sender: "我",
		recipient: "bm.no-reply@bigmodel.cn",
		subject: "Re: GLM Coding Plan 团队版咨询",
		date: at(24, 15),
		snippet: "确认可以，我们 12 月第一周走完内部审批。",
	}),
];

const EMAIL_DETAILS: Record<string, Email> = {
	s1: {
		...SENT_MERGED_EMAILS[0],
		read: true,
		bodyText: "已更新授权码，如仍有异常请联系我。\n\n—— 我",
		snippet: "已更新授权码，如仍有异常请联系我。",
	},
	s2: {
		...SENT_MERGED_EMAILS[1],
		read: true,
		bodyText: "各位好，Q4 排期已通过公司 Web App 邮箱发出，本邮件为同步副本。\n\n—— 我",
		snippet: "本周已通过公司 Web App 邮箱发出。",
	},
	s3: {
		...SENT_MERGED_EMAILS[2],
		read: true,
		bodyText: "确认可以，我们 12 月第一周走完内部审批。\n\n—— 我",
		snippet: "确认可以，我们 12 月第一周走完内部审批。",
	},
	i8: {
		...INBOX_EMAILS.find((e) => e.id === "i8")!,
		read: true,
		bodyText:
			"尊敬的用户，您好！\n\n我们检测到您的邮箱近期在异地设备上登录，为保障账号安全，系统已对客户端授权做出调整。使用第三方客户端（如 WeMail）的用户需要更新授权码后方可继续收发邮件。\n\n您可以前往网易邮箱网页版的「设置 › 客户端授权密码」生成新的授权码，更新后第三方客户端即可恢复正常同步。\n\n若本次登录为您本人操作，可忽略本邮件。",
		snippet: "我们检测到您的邮箱近期在异地设备上登录……",
	},
};

const KITCHEN_SINK: Json = {
	ok: true,
	entries: [],
	messages: [],
	items: [],
	files: [],
	skills: [],
	actions: [],
	todos: [],
	learnings: [],
	unread: 0,
	total: 0,
	totalCount: 0,
	unreadCount: 0,
	hasMore: false,
	account: null,
	llm: null,
};

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function routeApi(
	method: string,
	pathname: string,
	search: URLSearchParams,
): Response | undefined {
	if (method === "GET") {
		if (pathname === "/api/account/current") return jsonResponse({ ok: true, account: ACCOUNT });
		if (pathname === "/api/emails") {
			const folder = search.get("folder") ?? "inbox";
			const emails = folder === "sent" || folder === "已发送" ? SENT_MERGED_EMAILS
				: folder === "inbox" ? INBOX_EMAILS : [];
			return jsonResponse({
				ok: true,
				emails,
				totalCount: emails.length,
				unreadCount: emails.filter((e) => !e.read).length,
				hasMore: false,
			});
		}
		if (pathname === "/api/settings/llm") return jsonResponse({ ok: true, llm: null });
		if (pathname === "/api/system/llm-status") return jsonResponse({ ok: true, configured: false });
		if (pathname === "/api/agent/attention") return jsonResponse({ ok: true, active: [], failed: [], pausedConversationIds: [] });
		if (pathname.startsWith("/api/agent/pending-actions")) return jsonResponse({ ok: true, actions: [] });
		if (pathname.endsWith("/state")) return jsonResponse({ ok: true, state: null });
		if (pathname === "/api/agent/conversations") return jsonResponse({ ok: true, conversations: [] });
		if (pathname === "/api/channels/status") return jsonResponse({ ok: true, entries: [] });
		if (pathname === "/api/directory/status") return jsonResponse({ ok: true, status: { state: "completed", lastSyncAt: null, pendingCount: 0 } });
		if (pathname.startsWith("/api/user-tags") || pathname.startsWith("/api/smart-tags")) return jsonResponse({ ok: true, tags: [] });
		if (pathname.startsWith("/api/inbox-categories") || pathname.startsWith("/api/categories")) return jsonResponse({ ok: true, categories: CATEGORIES });
		if (pathname.startsWith("/api/application-messages")) return jsonResponse({ ok: true, messages: [], unread: 0, total: 0 });
		if (pathname === "/api/folders") return jsonResponse(FOLDERS);
		if (pathname === "/api/mail/folders") return jsonResponse(FOLDERS);
		return jsonResponse(KITCHEN_SINK);
	}
	return jsonResponse({ ok: true });
}

// ────────────────────────────────────────────────────────────
// Installer
// ────────────────────────────────────────────────────────────

let installed = false;

export function installDemoApi(): void {
	if (installed) return;
	installed = true;

	// 1) Desktop IPC bridge — folders / categories / scheduled / detail all
	//    read through `window.wemailDesktop.mailDatabase`.
	const bridge = {
		apiBaseUrl: undefined as string | undefined,
		platform: "win32",
		versions: { app: "1.1.4-demo" },
		getAppInfo: async () => ({
			name: "WeMail", version: "1.1.4-demo", platform: "win32", arch: "x64",
			electronVersion: "demo", chromeVersion: "demo", nodeVersion: "demo",
		}),
		window: {
			minimize: () => {},
			maximize: () => {},
			close: () => {},
			isMaximized: async () => false,
			getCloseBehavior: async () => "confirm" as const,
			onMaximizedChange: () => () => {},
			onCloseBehaviorChange: () => () => {},
		},
		storage: {
			getDataDirectory: async () => ({
				currentPath: "D:\\demo\\.wemail", defaultPath: "D:\\demo\\.wemail",
				custom: false, managedByEnvironment: false, lastMigration: undefined,
			}),
		},
		mailDatabase: {
			isConnected: () => true,
			listFolders: async () => FOLDERS,
			listCategories: async () => CATEGORIES,
			listMail: async (params: { folder?: string }) => {
				// Phase-1 merged Sent view: the "Sent" query unions the local sent
				// folder with the provider「已发送」copies. In production this union
				// lives in MailDatabaseQueryRepository.
				const folder = params.folder ?? "inbox";
				const source =
					folder === "Sent" || folder === "已发送"
						? SENT_MERGED_EMAILS
						: folder === "INBOX"
							? INBOX_EMAILS
							: [];
				const messages = source.map((e) => ({
					id: e.id,
					accountId: ACCOUNT.id,
					folder: e.folder_id ?? "inbox",
					messageId: `<demo-${e.id}@163.com>`,
					threadId: e.id,
					from: { email: e.sender, name: e.sender },
					to: [{ email: e.recipient ?? "" }],
					subject: e.subject,
					snippet: e.snippet ?? "",
					receivedAt: e.date,
					sentAt: e.date,
					hasAttachments: e.hasAttachments === true,
					flags: { seen: e.read === true, flagged: e.starred === true, answered: false, draft: false },
				}));
				return {
					messages,
					totalCount: messages.length,
					unreadCount: messages.filter((m) => !m.flags.seen).length,
					hasMore: false,
				};
			},
			listScheduled: async () => ({ scheduled: [] }),
			listScheduledPage: async (_accountId: string, page = 1, limit = 50) => ({
				scheduled: [], total: 0, page, limit, hasMore: false,
			}),
			cancelScheduled: async () => ({ ok: true, value: true }),
			deleteScheduled: async () => ({ ok: true, value: true }),
			saveDraft: async () => ({ ok: true, value: { id: "demo-draft" } }),
			getDraft: async () => null,
			listDrafts: async () => [],
			deleteDraft: async () => ({ ok: true, value: true }),
			enqueueSend: async () => ({ ok: true, value: { id: "demo-send", status: "queued" } }),
			setSnooze: async () => ({ ok: true, value: null }),
			listSnoozed: async () => [],
			ensureBody: async () => ({ status: "ready" }),
			focus: async () => ({ status: "focused" }),
			refresh: async () => ({ status: "queued" }),
			cancelRequest: () => {},
			search: async () => ({ messages: [], total: 0 }),
			mutateMail: async () => ({ ok: true, results: [] }),
			onChanged: () => () => {},
			getMailSnapshot: async (id: string) => {
				const detail = EMAIL_DETAILS[id];
				if (!detail) {
					return { message: null, bodyState: "missing", invoiceDetected: false, invoiceStatus: null };
				}
				const message = {
					id: detail.id,
					accountId: ACCOUNT.id,
					folder: detail.folder_id ?? "sent",
					messageId: `<demo-${detail.id}@163.com>`,
					from: { email: detail.sender, name: detail.sender },
					to: [{ email: detail.recipient ?? "" }],
					cc: [],
					bcc: [],
					subject: detail.subject,
					snippet: detail.snippet ?? "",
					bodyText: detail.bodyText ?? "",
					date: detail.date,
					flags: { seen: true, flagged: false, answered: false, draft: false },
					sizeEstimate: 1024,
				};
				return {
					message,
					bodyState: "ready",
					invoiceDetected: false,
					invoiceStatus: null,
				};
			},
		},
	};
	Object.defineProperty(window, "wemailDesktop", {
		configurable: true,
		value: bridge as unknown as typeof window.wemailDesktop,
	});

	// 2) HTTP shim for the remaining /api/* calls.
	const originalFetch = window.fetch.bind(window);
	window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
		const raw = typeof input === "string"
			? input
			: input instanceof URL
				? input.href
				: input.url;
		if (!raw.includes("/api/")) return originalFetch(input, init);
		const parsed = new URL(raw, window.location.origin);
		const method = (init?.method ?? "GET").toUpperCase();
		const routed = routeApi(method, parsed.pathname, parsed.searchParams);
		if (routed) return Promise.resolve(routed);
		return originalFetch(input, init);
	}) as typeof window.fetch;
}
