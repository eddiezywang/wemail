import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import api, {
	ApiError,
	initializeDesktopApiEndpointBridge,
	resetApiEndpointRuntimeForTests,
} from "./api";

type DesktopBridge = NonNullable<Window["wemailDesktop"]>;
type DesktopMailDatabase = NonNullable<DesktopBridge["mailDatabase"]>;
type DesktopMailCore = NonNullable<DesktopBridge["mailCore"]>;

function installCanonicalMailBridge(overrides: {
	mailDatabase?: Partial<DesktopMailDatabase>;
	mailCore?: Partial<DesktopMailCore>;
} = {}) {
	const previousDesktop = window.wemailDesktop;
	const mailDatabase = {
		isConnected: vi.fn(() => true),
		cancelRequest: vi.fn(),
		getMailSnapshot: vi.fn(async () => ({
			message: null,
			bodyState: "missing" as const,
			commitVersion: 0,
		})),
		listMail: vi.fn(async () => ({ messages: [], totalCount: 0, unreadCount: 0 })),
		listFolders: vi.fn(async () => []),
		search: vi.fn(async () => ({ messages: [], totalCount: 0 })),
		enqueueSend: vi.fn(async () => ({
			commitVersion: 1,
			changes: [],
			value: { outboxId: "outbox-1", messageIdHeader: "<sent@example.com>" },
		})),
		...overrides.mailDatabase,
	} as unknown as DesktopMailDatabase;
	const mailCore = {
		isConnected: vi.fn(() => true),
		refreshMail: vi.fn(async (accountId: string) => ({
			status: "queued" as const,
			accountId,
			jobId: 1,
		})),
		...overrides.mailCore,
	} as unknown as DesktopMailCore;
	window.wemailDesktop = {
		...previousDesktop,
		mailDatabase,
		mailCore,
	};
	return { previousDesktop, mailDatabase, mailCore };
}

describe("desktop API endpoint recovery", () => {
	test("cancels a stale request and retries once on the restarted Mail Core port", async () => {
		const previousDesktop = window.wemailDesktop;
		let endpointListener:
			| ((state: {
					state: "recovering" | "ready";
					baseUrl?: string;
					generation: number;
			  }) => void)
			| undefined;
		window.wemailDesktop = {
			apiBaseUrl: "http://127.0.0.1:50926",
			onApiEndpointChanged: (listener) => {
				endpointListener = listener;
				return () => {
					endpointListener = undefined;
				};
			},
		} as typeof window.wemailDesktop;
		resetApiEndpointRuntimeForTests();
		initializeDesktopApiEndpointBridge();

		const fetchMock = vi.spyOn(globalThis, "fetch")
			.mockImplementationOnce((_input, init) => new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => {
					reject(new DOMException("stale endpoint", "AbortError"));
				}, { once: true });
			}))
			.mockResolvedValueOnce(new Response(JSON.stringify({
				account: {
					id: "acct-1",
					emailAddress: "user@example.com",
					displayName: "User",
				},
			}), {
				status: 200,
				headers: { "content-type": "application/json" },
			}));

		try {
			const mailboxesPromise = api.listMailboxes();
			await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
			endpointListener?.({ state: "recovering", generation: 1 });
			endpointListener?.({
				state: "ready",
				baseUrl: "http://127.0.0.1:51251",
				generation: 2,
			});

			await expect(mailboxesPromise).resolves.toEqual([
				{ id: "acct-1", email: "user@example.com", name: "User" },
			]);
			expect(fetchMock.mock.calls[0]?.[0]).toBe(
				"http://127.0.0.1:50926/api/account/current",
			);
			expect(fetchMock.mock.calls[1]?.[0]).toBe(
				"http://127.0.0.1:51251/api/account/current",
			);
		} finally {
			resetApiEndpointRuntimeForTests();
			window.wemailDesktop = previousDesktop;
			vi.restoreAllMocks();
		}
	});
});

describe("api.sendWemailDraft", () => {
	test("tracks attempted and succeeded send events", async () => {
		const previousDesktop = window.wemailDesktop;
		const track = vi.fn();
		const enqueueSend = vi.fn(async () => ({
			commitVersion: 1,
			changes: [],
			value: { outboxId: "outbox-1", messageIdHeader: "<sent@example.com>" },
		}));
		window.wemailDesktop = {
			telemetry: { track },
			mailDatabase: {
				isConnected: () => true,
				enqueueSend,
			} as unknown as DesktopMailDatabase,
		} as typeof window.wemailDesktop;

		try {
			await api.sendWemailDraft({
				accountId: "acct-1",
				to: [{ email: "recipient@example.com" }],
				cc: [],
				bcc: [],
				subject: "Hello",
				bodyText: "Hello",
				bodyHtml: "<p>Hello</p>",
				attachments: [],
			});

			expect(track).toHaveBeenNthCalledWith(
				1,
				"wemail_mail_send_attempted",
				{
					compose_mode: "new",
					has_attachment: false,
					recipient_count_bucket: "1",
				},
			);
			expect(enqueueSend).toHaveBeenCalledWith(expect.objectContaining({
				accountId: "acct-1",
				attachments: [],
				idempotencyKey: expect.stringMatching(/^send:acct-1:/),
			}));
			expect(track).toHaveBeenNthCalledWith(
				2,
				"wemail_mail_send_succeeded",
				expect.objectContaining({
					compose_mode: "new",
					has_attachment: false,
					recipient_count_bucket: "1",
					duration_bucket: expect.any(String),
				}),
			);
		} finally {
			window.wemailDesktop = previousDesktop;
			vi.restoreAllMocks();
		}
	});
});

describe("api.searchDirectoryContacts", () => {
	test("prefers the desktop IPC bridge over renderer HTTP", async () => {
		const previousDesktop = window.wemailDesktop;
		const searchDirectoryContacts = vi.fn().mockResolvedValue({
			ok: true,
			contacts: [
				{
					id: "evan",
					accountId: "acct-1",
					name: "Evan",
					email: "evan@example.com",
					aliases: [],
				},
			],
			total: 1,
			remoteAvailable: true,
		});
		window.wemailDesktop = { searchDirectoryContacts };
		const fetchMock = vi.spyOn(globalThis, "fetch");

		try {
			await expect(api.searchDirectoryContacts("evan", {
				departmentId: "root",
				includeDescendants: true,
				limit: 8,
			})).resolves.toMatchObject({
				contacts: [{ email: "evan@example.com" }],
				remoteAvailable: true,
			});
			expect(searchDirectoryContacts).toHaveBeenCalledWith("evan", {
				departmentId: "root",
				includeDescendants: true,
				limit: 8,
				offset: undefined,
			});
			expect(fetchMock).not.toHaveBeenCalled();
		} finally {
			window.wemailDesktop = previousDesktop;
			vi.restoreAllMocks();
		}
	});
});

describe("api.syncMail", () => {
	let canonicalBridge: ReturnType<typeof installCanonicalMailBridge>;

	beforeEach(() => {
		canonicalBridge = installCanonicalMailBridge();
	});

	afterEach(() => {
		window.wemailDesktop = canonicalBridge.previousDesktop;
		vi.restoreAllMocks();
	});

	test("queues an incremental sync through Mail Core", async () => {
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(
				new Response(JSON.stringify({ account: { id: "acct-1" } }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
			);

		await expect(api.syncMail({ mode: "incremental", days: 1 })).resolves.toEqual({
			queued: true,
			inserted: 0,
			updated: 0,
		});

		expect(fetchMock).toHaveBeenCalledWith(
			"http://localhost:3000/api/account/current",
			expect.objectContaining({ method: "GET" }),
		);
		expect(canonicalBridge.mailCore.refreshMail).toHaveBeenCalledWith("acct-1");
	});

	test("surfaces Mail Core sync failures without an HTTP fallback", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ account: { id: "acct-1" } }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);
		vi.mocked(canonicalBridge.mailCore.refreshMail).mockRejectedValueOnce(
			new Error("mail-core-sync-failed"),
		);

		await expect(api.syncMail({ days: 30 })).rejects.toThrow("mail-core-sync-failed");
	});

	test("does not impose the HTTP request timeout on Mail Core sync admission", async () => {
		vi.useFakeTimers();
		let resolveRefresh!: (value: {
			status: "queued";
			accountId: string;
			jobId: number;
		}) => void;
		let rejected: unknown;
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ account: { id: "acct-1" } }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);
		vi.mocked(canonicalBridge.mailCore.refreshMail).mockImplementationOnce(
			() => new Promise((resolve) => {
				resolveRefresh = resolve;
			}),
		);

		const syncPromise = api.syncMail({ mode: "window", days: 30, deep: true })
			.catch((error) => {
				rejected = error;
				throw error;
			});

		await vi.advanceTimersByTimeAsync(31_000);

		expect(rejected).toBeUndefined();
		resolveRefresh({ status: "queued", accountId: "acct-1", jobId: 9 });
		await expect(syncPromise).resolves.toEqual({
			queued: true,
			inserted: 0,
			updated: 0,
		});
		vi.useRealTimers();
	});

	test("lists the current mailbox through the local account endpoint in dev web", async () => {
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(
				new Response(
					JSON.stringify({
						account: {
							id: "acct-1",
							emailAddress: "user@example.com",
							displayName: "User",
						},
					}),
					{
						status: 200,
						headers: { "content-type": "application/json" },
					},
				),
			);

		const mailboxes = await api.listMailboxes();

		expect(mailboxes).toEqual([
			{ id: "acct-1", email: "user@example.com", name: "User" },
		]);
		expect(fetchMock).toHaveBeenCalledWith(
			"http://localhost:3000/api/account/current",
			expect.objectContaining({ method: "GET" }),
		);
	});

	test("lists system folders through the canonical database bridge", async () => {
		vi.mocked(canonicalBridge.mailDatabase.listFolders).mockResolvedValueOnce([
			{ id: "inbox", name: "Inbox", unreadCount: 0 },
			{ id: "sent", name: "Sent", unreadCount: 0 },
			{ id: "draft", name: "Drafts", unreadCount: 0 },
			{ id: "archive", name: "Archive", unreadCount: 0 },
			{ id: "trash", name: "Trash", unreadCount: 0 },
		]);

		const folders = await api.listFolders("acct-1");

		expect(folders.map((folder) => folder.id)).toEqual([
			"inbox",
			"sent",
			"draft",
			"archive",
			"trash",
		]);
		expect(canonicalBridge.mailDatabase.listFolders).toHaveBeenCalledWith("acct-1");
	});

	test("queries summary health account-wide for view scopes", async () => {
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(
				JSON.stringify({
					ok: true,
					status: {
						total: 0,
						succeeded: 0,
						failed: 0,
						missing: 0,
						invalid: 0,
						pending: 0,
						running: 0,
						skipped: 0,
						retryable: 0,
						items: [],
					},
				}),
				{
					status: 200,
					headers: { "content-type": "application/json" },
				},
			),
		);

		await api.getSummaryHealth(
			"acct-1",
			{ scopeKind: "view", scopeKey: "account-summary-work" },
			{ state: "failed", query: "发票", limit: 20, offset: 40, pageOnly: true },
		);

		const url = new URL(String(fetchMock.mock.calls[0][0]));
		expect(url.pathname).toBe("/api/digests/summary-health");
		expect(url.searchParams.has("accountId")).toBe(false);
		expect(url.searchParams.get("state")).toBe("failed");
		expect(url.searchParams.get("q")).toBe("发票");
		expect(url.searchParams.get("limit")).toBe("20");
		expect(url.searchParams.get("offset")).toBe("40");
		expect(url.searchParams.get("pageOnly")).toBe("true");
		expect(url.searchParams.has("folder")).toBe(false);
	});

	test("queries summary health with multiple task states", async () => {
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(
				JSON.stringify({
					ok: true,
					status: {
						total: 0,
						succeeded: 0,
						failed: 0,
						missing: 0,
						invalid: 0,
						pending: 0,
						running: 0,
						skipped: 0,
						retryable: 0,
						items: [],
					},
				}),
				{
					status: 200,
					headers: { "content-type": "application/json" },
				},
			),
		);

		await api.getSummaryHealth(
			"acct-1",
			{ scopeKind: "folder", scopeKey: "INBOX" },
			{ states: ["failed", "missing", "invalid", "pending", "running"] },
		);

		const url = new URL(String(fetchMock.mock.calls[0][0]));
		expect(url.pathname).toBe("/api/digests/summary-health");
		expect(url.searchParams.get("folder")).toBe("INBOX");
		expect(url.searchParams.getAll("state")).toEqual([
			"failed",
			"missing",
			"invalid",
			"pending",
			"running",
		]);
	});

	test("maps desktop message attachment metadata for the email detail view", async () => {
		vi.mocked(canonicalBridge.mailDatabase.getMailSnapshot).mockResolvedValueOnce(
			{
					message: {
						id: "msg-1",
						accountId: "acct-1",
						folder: "INBOX",
						messageId: "<msg-1@example.com>",
						from: { email: "alice@example.com", name: "Alice" },
						to: [{ email: "me@example.com", name: "Me", directoryName: "eddiewang(王振宇)" }],
						cc: [{ email: "copy@example.com" }],
						bcc: [{ email: "audit@example.com" }],
						subject: "Report",
						snippet: "See attachment",
						receivedAt: "2026-04-27T12:00:00.000Z",
						bodyHtml: '<p><img src="cid:chart-1"></p>',
						hasAttachments: true,
						attachments: [
							{
								id: "2",
								filename: "chart.png",
								mimetype: "image/png",
								size: 2048,
								contentId: "chart-1",
								disposition: "inline",
							},
							{
								id: "3",
								filename: "report.pdf",
								mimetype: "application/pdf",
								size: 4096,
								disposition: "attachment",
							},
						],
						flags: { seen: true, flagged: false, answered: false, draft: false },
					},
					bodyState: "ready",
					commitVersion: 1,
			},
		);

		const email = await api.getEmail("acct-1", "msg-1");

		expect(canonicalBridge.mailDatabase.getMailSnapshot).toHaveBeenCalledWith(
			"msg-1",
			undefined,
			expect.stringMatching(/^renderer-detail-/),
		);
		expect(email.hasAttachments).toBe(true);
		expect(email.recipient).toBe("eddiewang(王振宇) <me@example.com>");
		expect(email.toAddresses).toEqual([{
			email: "me@example.com",
			name: "Me",
			directoryName: "eddiewang(王振宇)",
		}]);
		expect(email.ccAddresses).toEqual([{ email: "copy@example.com" }]);
		expect(email.bccAddresses).toEqual([{ email: "audit@example.com" }]);
		expect(email.attachments).toEqual([
			{
				id: "2",
				filename: "chart.png",
				mimetype: "image/png",
				size: 2048,
				content_id: "chart-1",
				contentId: "chart-1",
				disposition: "inline",
			},
			{
				id: "3",
				filename: "report.pdf",
				mimetype: "application/pdf",
				size: 4096,
				disposition: "attachment",
			},
		]);
	});

	test("preserves desktop message html and text bodies separately", async () => {
		vi.mocked(canonicalBridge.mailDatabase.getMailSnapshot).mockResolvedValueOnce(
			{
					message: {
						id: "msg-body",
						accountId: "acct-1",
						folder: "INBOX",
						messageId: "<msg-body@example.com>",
						from: { email: "alice@example.com" },
						to: [{ email: "me@example.com" }],
						subject: "Body",
						snippet: "Plain",
						receivedAt: "2026-04-27T12:00:00.000Z",
						bodyText: "Plain\nbody",
						bodyHtml: "<p>HTML body</p>",
						hasAttachments: false,
						attachments: [],
						flags: { seen: true, flagged: false, answered: false, draft: false },
					},
					bodyState: "ready",
					commitVersion: 1,
			},
		);

		const email = await api.getEmail("acct-1", "msg-body");

		expect(email.bodyHtml).toBe("<p>HTML body</p>");
		expect(email.bodyText).toBe("Plain\nbody");
		expect(email.body).toBe("<p>HTML body</p>");
	});

	test("cancels the exact DB Service detail request when selection becomes stale", async () => {
		let rejectSnapshot!: (error: Error) => void;
		let activeRequestId = "";
		vi.mocked(canonicalBridge.mailDatabase.getMailSnapshot).mockImplementationOnce(
			(_id, _traceId, requestId) => {
				activeRequestId = requestId ?? "";
				return new Promise((_resolve, reject) => {
					rejectSnapshot = reject;
				});
			},
		);
		vi.mocked(canonicalBridge.mailDatabase.cancelRequest).mockImplementationOnce(
			(requestId) => {
				expect(requestId).toBe(activeRequestId);
				const error = new Error("detail-request-cancelled");
				error.name = "AbortError";
				rejectSnapshot(error);
			},
		);
		const controller = new AbortController();

		const detail = api.getEmail("acct-1", "msg-stale", {
			signal: controller.signal,
			traceId: "rapid-selection",
		});
		await vi.waitFor(() => {
			expect(canonicalBridge.mailDatabase.getMailSnapshot).toHaveBeenCalledOnce();
		});
		controller.abort();

		await expect(detail).rejects.toMatchObject({ name: "AbortError" });
		expect(canonicalBridge.mailDatabase.cancelRequest).toHaveBeenCalledWith(
			expect.stringMatching(/^renderer-detail-/),
		);
	});

	test("keeps desktop list attachment markers even when summaries omit attachment metadata", async () => {
		vi.mocked(canonicalBridge.mailDatabase.listMail).mockResolvedValueOnce(
			{
					messages: [
						{
							id: "msg-1",
							accountId: "acct-1",
							folder: "INBOX",
							messageId: "<msg-1@example.com>",
							from: { email: "alice@example.com", name: "Alice" },
							to: [{ email: "me@example.com" }],
							subject: "Report",
							snippet: "See attachment",
							receivedAt: "2026-04-27T12:00:00.000Z",
							hasAttachments: true,
							flags: { seen: false, flagged: false, answered: false, draft: false },
						},
					],
					totalCount: 1,
					unreadCount: 1,
			},
		);

		const result = await api.listEmails("acct-1", {});

		expect(result).toEqual({
			emails: [
				expect.objectContaining({
					id: "msg-1",
					hasAttachments: true,
					attachments: [],
				}),
			],
			totalCount: 1,
			unreadCount: 1,
			hasMore: false,
			nextCursor: undefined,
		});
	});

	test("maps desktop invoice status tag from list summaries", async () => {
		vi.mocked(canonicalBridge.mailDatabase.listMail).mockResolvedValueOnce(
			{
					messages: [
						{
							id: "msg-1",
							accountId: "acct-1",
							folder: "INBOX",
							messageId: "<msg-1@example.com>",
							from: { email: "alice@example.com", name: "Alice" },
							to: [{ email: "me@example.com" }],
							subject: "发票",
							snippet: "附件发票",
							receivedAt: "2026-04-27T12:00:00.000Z",
							hasAttachments: true,
							invoiceStatusTag: "未处理发票",
							flags: { seen: false, flagged: false, answered: false, draft: false },
						},
					],
					totalCount: 1,
					unreadCount: 1,
			},
		);

		const result = await api.listEmails("acct-1", {});

		expect(result.emails[0]).toMatchObject({
			id: "msg-1",
			invoiceStatusTag: "未处理发票",
		});
	});

	test("maps desktop invoice attachment status from message detail", async () => {
		vi.mocked(canonicalBridge.mailDatabase.getMailSnapshot).mockResolvedValueOnce(
			{
					message: {
						id: "msg-1",
						accountId: "acct-1",
						folder: "INBOX",
						messageId: "<msg-1@example.com>",
						from: { email: "alice@example.com", name: "Alice" },
						to: [{ email: "me@example.com" }],
						subject: "发票",
						snippet: "附件发票",
						receivedAt: "2026-04-27T12:00:00.000Z",
						hasAttachments: true,
						attachments: [
							{
								id: "part-2",
								filename: "invoice.pdf",
								mimetype: "application/pdf",
								size: 4096,
								disposition: "attachment",
							},
						],
						flags: { seen: true, flagged: false, answered: false, draft: false },
					},
					invoiceStatus: {
						tag: "已处理发票",
						state: "associated_other",
						statuses: [
							{
								accountId: "acct-1",
								emailId: "msg-1",
								attachmentId: "part-2",
								filename: "invoice.pdf",
								status: "associated_other",
								lastError: "已被其他人关联",
								createdAt: "2026-04-27T12:00:00.000Z",
								updatedAt: "2026-04-27T12:01:00.000Z",
							},
						],
					},
					bodyState: "ready",
					commitVersion: 1,
			},
		);

		const email = await api.getEmail("acct-1", "msg-1");

		expect(email.invoiceStatus?.tag).toBe("已处理发票");
		expect(email.invoiceStatusState).toBe("associated_other");
		expect(email.invoiceStatus?.statuses[0]).toMatchObject({
			attachmentId: "part-2",
			status: "associated_other",
			lastError: "已被其他人关联",
		});
	});

	test("refreshes desktop invoice status through the local platform endpoint", async () => {
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(
				JSON.stringify({
					ok: true,
					updated: 1,
					invoiceStatus: { tag: "已处理发票", state: "uploaded", statuses: [] },
					results: [],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			),
		);

		await api.refreshInvoiceStatus("msg-1");

		expect(fetchMock).toHaveBeenCalledWith(
			"http://localhost:3000/api/mail/messages/msg-1/invoice-status/refresh",
			expect.objectContaining({ method: "POST" }),
		);
	});

	test("forwards smart tag category filters to the desktop mail list route", async () => {
		await api.listEmails("acct-1", {
			category: "发票",
			unread: "1",
			hasAttachment: "1",
		});

		expect(canonicalBridge.mailDatabase.listMail).toHaveBeenCalledWith({
			accountId: "acct-1",
			category: "发票",
			hasAttachment: true,
			unread: true,
		});
	});

	test("preserves custom folder casing when listing desktop mail", async () => {
		await api.listEmails("acct-1", {
			folder: "chatgpt",
		});

		expect(canonicalBridge.mailDatabase.listMail).toHaveBeenCalledWith({
			accountId: "acct-1",
			folder: "chatgpt",
		});
	});

	test("routes desktop search through the canonical search reader", async () => {
		await api.searchEmails("acct-1", {
			query: "roadmap friday",
			from: "planner@example.com",
			folder: "inbox",
			is_read: "false",
			is_starred: "true",
			has_attachment: "true",
			unread: "1",
			toMe: "1",
			ccMe: "1",
			olderThan: "30d",
			date_start: "2026-04-01T00:00:00.000Z",
			date_end: "2026-04-30T23:59:59.999Z",
			limit: "25",
		});

		expect(canonicalBridge.mailDatabase.search).toHaveBeenCalledWith({
			accountId: "acct-1",
			query: "roadmap friday",
			from: "planner@example.com",
			folder: "INBOX",
			read: false,
			starred: true,
			hasAttachment: true,
			unread: true,
			toMe: true,
			ccMe: true,
			olderThan: "30d",
			dateFrom: "2026-04-01T00:00:00.000Z",
			dateTo: "2026-04-30T23:59:59.999Z",
			limit: 25,
		});
	});

	test("downloads desktop attachments from the local mail route", async () => {
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("pdf bytes", {
				status: 200,
				headers: { "content-type": "application/pdf" },
			}),
		);

		await api.getAttachment("acct-1", "msg-1", "part-2");

		expect(fetchMock).toHaveBeenCalledWith(
			"http://localhost:3000/api/mail/messages/msg-1/attachments/part-2",
			expect.objectContaining({ method: "GET" }),
		);
	});

	test("streams agent chat events over SSE", async () => {
		const base = {
			schemaVersion: 1,
			conversationId: "conversation-1",
			runId: "run-1",
			messageId: "message-1",
			timestamp: "2026-08-02T04:00:00.000Z",
		};
		const body =
			"event: text_completed\n" +
			`data: ${JSON.stringify({ ...base, sequence: 0, type: "text_completed", partId: "text:0", text: "hello" })}\n\n` +
			"event: run_settled\n" +
			`data: ${JSON.stringify({ ...base, sequence: 1, type: "run_settled" })}\n\n`;
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(body, {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			}),
		);
		const events: string[] = [];

		await api.streamAgentChat(
			{ userText: "hi", sessionId: "acct-1", context: { mailboxId: "acct-1" } },
			{ onEvent: (event) => events.push(event.type) },
		);

		expect(fetchMock).toHaveBeenCalledWith(
			"http://localhost:3000/api/agent/chat",
			expect.objectContaining({
				method: "POST",
				headers: expect.objectContaining({
					Accept: "text/event-stream",
					"Content-Type": "application/json",
				}),
				body: JSON.stringify({
					userText: "hi",
					sessionId: "acct-1",
					context: { mailboxId: "acct-1" },
				}),
			}),
		);
		expect(events).toEqual(["text_completed", "run_settled"]);
	});

	test("rejects legacy unversioned agent SSE events", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(
				'event: assistant_text\ndata: {"type":"assistant_text","text":"legacy"}\n\n',
				{
					status: 200,
					headers: { "content-type": "text/event-stream" },
				},
			),
		);

		await expect(
			api.streamAgentChat(
				{ userText: "hi" },
				{ onEvent: () => undefined },
			),
		).rejects.toThrow("Invalid agent event stream");
	});

	test("forwards confirmDangerous when running automation rules", async () => {
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(
				JSON.stringify({ ok: true, matchedCount: 2, appliedCount: 2 }),
				{
					status: 200,
					headers: { "content-type": "application/json" },
				},
			),
		);

		await api.runAutomationRule("rule-1", { confirmDangerous: true });

		expect(fetchMock).toHaveBeenCalledWith(
			"http://localhost:3000/api/automation/rules/rule-1/run",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({ confirmDangerous: true }),
			}),
		);
	});
});

describe("api.completeTodo", () => {
	test("coalesces repeated completion requests for the same todo", async () => {
		// Module-level endpoint state (base URL cache + subscriptions) leaks
		// across tests in this file — reset so post() resolves through the
		// default local base and reaches the spied global fetch.
		resetApiEndpointRuntimeForTests();
		delete window.wemailDesktop;

		let resolveRequest!: (response: Response) => void;
		const fetchMock = vi.spyOn(globalThis, "fetch").mockReturnValue(
			new Promise<Response>((resolve) => {
				resolveRequest = resolve;
			}),
		);

		const first = api.completeTodo("todo-1");
		const second = api.completeTodo("todo-1");
		expect(second).toBe(first);

		resolveRequest(new Response(JSON.stringify({ ok: true }), {
			status: 200,
			headers: { "content-type": "application/json" },
		}));
		await expect(first).resolves.toEqual({ ok: true });
		fetchMock.mockRestore();
	});
});
