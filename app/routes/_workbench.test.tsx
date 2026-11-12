// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "~/components/ui/tooltip";
import { useUIStore } from "~/hooks/useUIStore";
import * as currentAccountModule from "~/queries/currentAccount";
import type { Email } from "~/types";
import {
	MessageDetailView,
	MessageListView,
	RouteEmailSelectionReset,
} from "./_workbench";
import api from "~/services/api";

const { toastSuccessMock, listCategoriesMock, foldersMock } = vi.hoisted(() => ({
	toastSuccessMock: vi.fn(),
	listCategoriesMock: vi.fn(() => []),
	foldersMock: vi.fn(() => []),
}));

vi.mock("sonner", () => ({
	toast: {
		success: toastSuccessMock,
		error: vi.fn(),
		info: vi.fn(),
	},
}));

vi.mock("~/queries/currentAccount", () => ({
	useCurrentAccount: vi.fn(),
}));

vi.mock("~/queries/listCategories", () => ({
	useListCategories: () => ({ data: listCategoriesMock() }),
}));

vi.mock("~/queries/folders", () => ({
	useFolders: () => ({ data: foldersMock() }),
}));

vi.mock("~/components/EmailPanel", () => ({
	default: ({ onOpenSummaryCenter }: { onOpenSummaryCenter: () => void }) => (
		<button type="button" onClick={onOpenSummaryCenter}>
			智能中心
		</button>
	),
}));

function makeEmail(id: string, overrides: Partial<Email> = {}): Email {
	return {
		id,
		subject: `Subject ${id}`,
		sender: "Alice",
		recipient: "bob@example.com",
		date: "2026-04-27T12:00:00.000Z",
		read: false,
		starred: false,
		snippet: `Snippet ${id}`,
		...overrides,
	};
}

// P2.6: the invoice badge is an edition module capability. Round 8 moved
// the badge semantics to the edition module's renderer contribution, so
// the open suite pins "no badge" in both feature states.
const editionFeatures = vi.hoisted(() => ({ allowanceInvoice: true }));
vi.mock("~/hooks/useEditionFeatures", () => ({
	useEditionFeatures: () => ({
		wecli: false,
		allowanceInvoice: editionFeatures.allowanceInvoice,
		enterpriseDirectory: false,
		officeSceneDetection: false,
	}),
}));

function renderMessageList(
	emails: Email[],
	initialEntry = "/",
	props: Partial<ComponentProps<typeof MessageListView>> = {},
	queryOverrides: Record<string, unknown> = {},
) {
	const queryClient = new QueryClient();
	return render(
		<QueryClientProvider client={queryClient}>
			<TooltipProvider>
				<MemoryRouter initialEntries={[initialEntry]}>
					<LocationPathProbe />
					<MessageListView
						folder="inbox"
					query={{
							data: {
								emails,
								totalCount: emails.length,
								unreadCount: emails.filter((email) => !email.read).length,
							},
							isFetching: false,
							isLoading: false,
							hasNextPage: false,
							fetchNextPage: vi.fn(),
							isFetchingNextPage: false,
							...queryOverrides,
						} as never}
						{...props}
					/>
				</MemoryRouter>
			</TooltipProvider>
		</QueryClientProvider>,
	);
}

function LocationSearchProbe() {
	const location = useLocation();
	return <div data-testid="location-search">{location.search}</div>;
}

function renderMessageListWithLocation(
	emails: Email[],
	initialEntry = "/",
	props: Partial<ComponentProps<typeof MessageListView>> = {},
) {
	const queryClient = new QueryClient();
	return render(
		<QueryClientProvider client={queryClient}>
			<TooltipProvider>
				<MemoryRouter initialEntries={[initialEntry]}>
					<LocationSearchProbe />
					<MessageListView
						folder="inbox"
					query={{
							data: {
								emails,
								totalCount: emails.length,
								unreadCount: emails.filter((email) => !email.read).length,
							},
							isFetching: false,
							isLoading: false,
						} as never}
						{...props}
					/>
				</MemoryRouter>
			</TooltipProvider>
		</QueryClientProvider>,
	);
}

function LocationPathProbe() {
	const location = useLocation();
	return <div data-testid="location-probe">{location.pathname}{location.search}</div>;
}

function mockCurrentAccount() {
	vi.mocked(currentAccountModule.useCurrentAccount).mockReturnValue({
		isLoading: false,
		isError: false,
		data: { account: { id: "acct-1" } },
	} as unknown as ReturnType<typeof currentAccountModule.useCurrentAccount>);
}

describe("RouteEmailSelectionReset", () => {
	beforeEach(() => {
		useUIStore.setState({
			selectedEmailId: "msg-1",
			_previousEmailId: "msg-1",
			isComposing: false,
		});
	});

	it("clears stale message detail when entering a non-message destination", async () => {
		render(
			<MemoryRouter initialEntries={["/directory"]}>
				<RouteEmailSelectionReset />
			</MemoryRouter>,
		);

		await waitFor(() => {
			expect(useUIStore.getState().selectedEmailId).toBeNull();
			expect(useUIStore.getState()._previousEmailId).toBeNull();
		});
	});

	it("preserves the selection for an explicit message detail route", async () => {
		render(
			<MemoryRouter initialEntries={["/message/msg-1"]}>
				<RouteEmailSelectionReset />
			</MemoryRouter>,
		);

		await waitFor(() => {
			expect(useUIStore.getState().selectedEmailId).toBe("msg-1");
		});
	});
});

describe("MessageListView", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		window.localStorage.clear();
		toastSuccessMock.mockReset();
		listCategoriesMock.mockReturnValue([]);
		foldersMock.mockReturnValue([]);
		vi.spyOn(api, "semanticSearchMail").mockResolvedValue({ ok: true, results: [] });
		vi.spyOn(api, "updateEmail").mockResolvedValue({ ok: true });
		vi.spyOn(api, "getDigestStatus").mockResolvedValue({
			ok: true,
			status: { state: "hidden", reason: "none", emailCount: 0 },
		});
		vi.spyOn(api, "getLlmStatus").mockResolvedValue({
			configured: true,
			provider: "openai",
			model: "mock-model",
		});
		vi.spyOn(api, "getLatestDigest").mockResolvedValue({ ok: true, digest: null });
		vi.spyOn(api, "listDigests").mockResolvedValue({ ok: true, digests: [] });
		vi.spyOn(api, "generateDigest").mockResolvedValue({
			ok: true,
			digest: null,
		} as never);
		mockCurrentAccount();
		useUIStore.setState({
			selectedEmailId: null,
			isComposing: false,
			_previousEmailId: null,
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("offers a stop button while collecting unread mail", async () => {
		let finish!: (value: Awaited<ReturnType<typeof api.listEmails>>) => void;
		vi.spyOn(api, "listEmails").mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
		const update = vi.spyOn(api, "updateEmail");
		renderMessageList([makeEmail("visible", { read: false })], "/", { markAllReadParams: { folder: "inbox" } });
		await userEvent.click(screen.getByRole("button", { name: "全部标为已读" }));
		await userEvent.click(screen.getByRole("button", { name: "终止" }));
		expect(screen.getByRole("button", { name: "正在终止…" })).toBeDisabled();
		await act(async () => finish({ emails: [], totalCount: 0, unreadCount: 0, hasMore: false }));
		await waitFor(() => expect(screen.queryByRole("button", { name: "正在终止…" })).toBeNull());
		expect(update).not.toHaveBeenCalled();
	});

	it("marks all unread pages from the list header", async () => {
		const list = vi.spyOn(api, "listEmails").mockResolvedValue({ emails: [makeEmail("not-loaded", { read: false })],
			totalCount: 1, unreadCount: 1, hasMore: false });
		const update = vi.spyOn(api, "updateEmail").mockResolvedValue({ ok: true });
		renderMessageList([makeEmail("visible", { read: false })], "/", { markAllReadParams: { folder: "inbox" } });
		await userEvent.click(screen.getByRole("button", { name: "全部标为已读" }));
		await waitFor(() => expect(toastSuccessMock).toHaveBeenCalledWith("已将 1 封邮件标为已读"));
		expect(list).toHaveBeenCalledWith(expect.any(String), { folder: "inbox", unread: "1", limit: "500" }, { signal: expect.any(AbortSignal) });
		expect(update).toHaveBeenCalledWith(expect.any(String), "not-loaded", { read: true });
	});

	it("selects adjacent emails when navigation events fire", () => {
		renderMessageList([makeEmail("msg-1"), makeEmail("msg-2"), makeEmail("msg-3")]);
		useUIStore.getState().selectEmail("msg-2");

		act(() => {
			window.dispatchEvent(new CustomEvent("wemail:nav-next"));
		});
		expect(useUIStore.getState().selectedEmailId).toBe("msg-3");

		act(() => {
			window.dispatchEvent(new CustomEvent("wemail:nav-prev"));
		});
		expect(useUIStore.getState().selectedEmailId).toBe("msg-2");
	});

	it("keeps background synchronization progress and completion silent", async () => {
		renderMessageList([]);

		expect(screen.queryByTestId("startup-sync-progress")).toBeNull();
		expect(screen.queryByTestId("startup-sync-summary")).toBeNull();
		expect(screen.queryByText("同步完成")).toBeNull();
	});

	it("submits search when the toolbar magnifying-glass button is clicked", async () => {
		const user = userEvent.setup();
		renderMessageList([makeEmail("msg-1")]);

		await user.type(screen.getByRole("searchbox"), "hello world");
		await user.click(screen.getByRole("button", { name: "搜索邮件" }));

		await waitFor(() =>
			expect(screen.getByTestId("location-probe")).toHaveTextContent("/?q=hello+world"),
		);
	});

	it("offers one manual refresh action without exposing sync strategies", async () => {
		const user = userEvent.setup();
		let resolveRefresh!: (value: Awaited<ReturnType<typeof api.refreshMail>>) => void;
		const pending = new Promise<Awaited<ReturnType<typeof api.refreshMail>>>(
			(resolve) => { resolveRefresh = resolve; },
		);
		const refreshMail = vi.spyOn(api, "refreshMail").mockReturnValue(pending);
		renderMessageList([makeEmail("msg-1")], "/", {}, { isFetching: true });

		const refresh = screen.getByRole("button", { name: "手动刷新" });
		expect(refresh).toBeEnabled();
		expect(screen.queryByRole("button", { name: "同步选项" })).toBeNull();
		expect(screen.queryByText("深度同步最近 30 天")).toBeNull();

		await user.click(refresh);
		await user.click(refresh);
		expect(refreshMail).toHaveBeenCalledTimes(1);
		expect(refreshMail).toHaveBeenCalledWith();
		expect(refresh).toBeDisabled();

		resolveRefresh({
			ok: true,
			accountId: "acct-1",
			runId: "refresh-1",
			disposition: "accepted",
			status: "completed",
			changed: false,
			completedAt: "2026-07-28T00:00:00.000Z",
		});
		await waitFor(() => expect(refresh).toBeEnabled());
		expect(toastSuccessMock).not.toHaveBeenCalledWith("邮件已是最新");
	});

	it("clears the keyword with the visible clear button and restores the inbox route", async () => {
		const user = userEvent.setup();
		const syncMail = vi.spyOn(api, "syncMail");
		renderMessageList([makeEmail("msg-1")], "/?q=invoice");

		await user.click(screen.getByRole("button", { name: "清除搜索" }));

		await waitFor(() =>
			expect(screen.getByTestId("location-probe")).toHaveTextContent("/"),
		);
		expect(syncMail).not.toHaveBeenCalled();
	});

	it("bounds rendered mail rows to the viewport for large loaded lists", () => {
		renderMessageList(
			Array.from({ length: 500 }, (_, index) => makeEmail(`msg-${index + 1}`)),
		);
		const virtualList = screen.getByTestId("virtual-mail-list");
		const rows = screen.getAllByTestId("mail-item");
		expect(virtualList).toBeInTheDocument();
		expect(rows.length).toBeLessThan(30);
		expect(rows[0]?.parentElement).toBe(virtualList);
		expect(rows[0]).toHaveClass("absolute");
		expect(rows[0]).toHaveStyle({ height: "48px" });
	});

	it("uses a text searchbox so the custom clear button is the only clear control", () => {
		renderMessageList([makeEmail("msg-1")], "/?q=invoice");

		expect(screen.getByRole("searchbox")).toHaveAttribute("type", "text");
		expect(screen.getAllByRole("button", { name: "清除搜索" })).toHaveLength(1);
	});

	it("renders semantic-only search hits when the email detail is not cached", async () => {
		vi.mocked(api.semanticSearchMail).mockResolvedValueOnce({
			ok: true,
			results: [{
				email: makeEmail("semantic-1", {
					message_id: "<semantic-1@example.com>",
					subject: "Semantic result",
					snippet: "Matched only semantically",
				}),
				score: 0.91,
				snippet: "Matched only semantically",
			}],
		});

		renderMessageList([], "/?q=natural%20language");

		// The snippet column was removed from list rows; the semantic-only hit
		// itself must surface as a rendered subject row.
		expect(
			(await screen.findAllByText("Semantic result")).length,
		).toBeGreaterThan(0);
	});

	it("does not query or show digest availability for an empty folder view", () => {
		renderMessageList([], "/folder/chatgpt", { folder: "chatgpt" });

		expect(api.getDigestStatus).not.toHaveBeenCalled();
		expect(screen.queryByTestId("wemail-mail-digest-banner")).toBeNull();
		expect(screen.getByText("chatgpt 暂无邮件")).toBeInTheDocument();
	});

	it("uses persisted starred state in rows and unstars on toggle", async () => {
		const user = userEvent.setup();
		renderMessageList([makeEmail("msg-1", { starred: true })]);

		const star = screen.getByTestId("mail-item-star");
		expect(star).toHaveAttribute("aria-label", "取消星标");

		await user.click(star);

		await waitFor(() =>
			expect(api.updateEmail).toHaveBeenCalledWith(
				"acct-1",
				"msg-1",
				{ starred: false },
			),
		);
	});

	it("renders unread rows with unread styling metadata", () => {
		renderMessageList([makeEmail("msg-1", { read: false })]);

		expect(screen.getByTestId("mail-item")).toHaveAttribute("data-unread", "true");
		expect(screen.getByTestId("mail-item-unread")).toHaveAttribute("aria-hidden", "false");
	});

	it("renders no invoice tags in the open edition even with the feature on", () => {
		// P2.6 round 8: the invoice badge semantics (labels + state mapping)
		// moved to the edition module's renderer contribution
		// (`internal/src/allowance/renderer/invoice-display.ts`). The open
		// edition keeps only the feature gate — legacy rows carrying invoice
		// fields render no invoice tag either way.
		renderMessageList([
			makeEmail("msg-1", { invoiceStatusState: "not_uploaded" }),
		]);
		expect(screen.queryByTestId("mail-item-tags")).toBeNull();

		renderMessageList([
			makeEmail("msg-2", { invoiceDetected: true, invoiceStatusState: null }),
		]);
		expect(screen.queryByTestId("mail-item-tags")).toBeNull();
	});

	it("hides invoice tags when the edition feature is off", () => {
		// P2.6: the invoice badge is an edition module capability; legacy rows
		// carrying invoice fields render no invoice tag in the open edition.
		editionFeatures.allowanceInvoice = false;
		try {
			renderMessageList([
				makeEmail("msg-1", { invoiceDetected: true, invoiceStatusState: "not_uploaded" }),
			]);
			expect(screen.queryByTestId("mail-item-tags")).toBeNull();
		} finally {
			editionFeatures.allowanceInvoice = true;
		}
	});

	it("marks an unread email as read when it is opened", async () => {
		const user = userEvent.setup();
		renderMessageList([makeEmail("msg-1", { read: false })]);

		await user.click(screen.getAllByText("Subject msg-1")[0]);

		// Auto-read defers to an idle tick (jsdom falls back to a 1.5s timer).
		await waitFor(
			() =>
				expect(api.updateEmail).toHaveBeenCalledWith(
					"acct-1",
					"msg-1",
					{ read: true },
				),
			{ timeout: 4000 },
		);
	});

	it("does not loop automatic read attempts when a dirty message id fails", async () => {
		vi.mocked(api.updateEmail).mockRejectedValue(
			new Error("invalid message id"),
		);
		const user = userEvent.setup();
		renderMessageList([
			makeEmail("demo-monitoring-dirty", { read: false }),
		]);

		await user.click(
			screen.getAllByText("Subject demo-monitoring-dirty")[0],
		);

		await waitFor(
			() => {
				expect(api.updateEmail).toHaveBeenCalledTimes(1);
			},
			{ timeout: 4000 },
		);
		await act(async () => {
			await Promise.resolve();
			await Promise.resolve();
		});
		expect(api.updateEmail).toHaveBeenCalledTimes(1);
	});

	it("selects mail without using document view transitions", async () => {
		const user = userEvent.setup();
		const startViewTransition = vi.fn((callback: () => void) => {
			callback();
			return {};
		});
		Object.defineProperty(document, "startViewTransition", {
			configurable: true,
			value: startViewTransition,
		});
		renderMessageList([makeEmail("msg-1", { read: true })]);

		await user.click(screen.getAllByText("Subject msg-1")[0]);

		expect(useUIStore.getState().selectedEmailId).toBe("msg-1");
		expect(startViewTransition).not.toHaveBeenCalled();
	});

	it("renders the attachment marker from summary hasAttachments metadata", () => {
		renderMessageList([makeEmail("msg-1", { hasAttachments: true })]);

		expect(
			screen.getAllByTestId("mail-item-attachment").length,
		).toBeGreaterThan(0);
	});

	it("does not apply another directory's filter to the all-mail list", async () => {
		useUIStore.setState({
			mailFilters: {
				unread: false,
				toMe: false,
				ccMe: false,
				hasAttachment: true,
				olderThan: null,
			},
			mailFilterScope: "/",
		});

		renderMessageList(
			[makeEmail("msg-1", { hasAttachments: false })],
			"/folder/all-mail",
		);

		// Filtering is applied by the route-level query, not client-side; the
		// list itself must only adopt the active route's filter scope, so the
		// filters stored under "/" cannot bleed into the all-mail list.
		await waitFor(() => {
			expect(useUIStore.getState().mailFilterScope).toBe("/folder/all-mail");
		});
		expect(screen.getAllByText("Subject msg-1").length).toBeGreaterThan(0);
	});

	it("loads the next page when users scroll to the bottom of the mail list", async () => {
		const fetchNextPage = vi.fn();
		renderMessageList(
			Array.from({ length: 20 }, (_, index) => makeEmail(`msg-${index}`)),
			"/",
			{},
			{ hasNextPage: true, fetchNextPage },
		);

		const scroller = screen.getByTestId("mail-list-scroll");
		Object.defineProperties(scroller, {
			scrollHeight: { configurable: true, value: 1000 },
			clientHeight: { configurable: true, value: 400 },
			scrollTop: { configurable: true, value: 610 },
		});
		scroller.dispatchEvent(new Event("scroll", { bubbles: true }));

		await waitFor(() => {
			expect(fetchNextPage).toHaveBeenCalledTimes(1);
		});
	});

	it("does not request the same next page twice during one bottom-scroll burst", async () => {
		const fetchNextPage = vi.fn();
		renderMessageList(
			Array.from({ length: 20 }, (_, index) => makeEmail(`msg-${index}`)),
			"/",
			{},
			{ hasNextPage: true, fetchNextPage },
		);

		const scroller = screen.getByTestId("mail-list-scroll");
		Object.defineProperties(scroller, {
			scrollHeight: { configurable: true, value: 1000 },
			clientHeight: { configurable: true, value: 400 },
			scrollTop: { configurable: true, value: 610 },
		});
		scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
		scroller.dispatchEvent(new Event("scroll", { bubbles: true }));

		await waitFor(() => {
			expect(fetchNextPage).toHaveBeenCalledTimes(1);
		});
	});

	it("does not push digest-generation notifications into the mail list", () => {
		renderMessageList([makeEmail("msg-1")]);

		expect(api.getDigestStatus).not.toHaveBeenCalled();
		expect(toastSuccessMock).not.toHaveBeenCalledWith("每日摘要已生成");
	});

	it("navigates to 智能中心 from a fixed toolbar entry without a digest banner", async () => {
		const user = userEvent.setup();
		renderMessageList([makeEmail("msg-1")]);

		expect(screen.queryByRole("dialog", { name: "智能中心" })).toBeNull();

		await user.click(await screen.findByRole("button", { name: "打开智能中心" }));

		await waitFor(() => {
			expect(screen.getByTestId("location-probe")).toHaveTextContent(/^\/digests$/);
		});
		expect(screen.queryByRole("dialog", { name: "智能中心" })).toBeNull();
	});

	it("navigates to 智能中心 from the detail view without a message list", async () => {
		const user = userEvent.setup();
		useUIStore.setState({ selectedEmailId: "msg-1" });

		render(
			<MemoryRouter initialEntries={["/actions"]}>
				<LocationPathProbe />
				<MessageDetailView />
			</MemoryRouter>,
		);

		await user.click(
			await screen.findByRole("button", { name: "智能中心" }),
		);

		await waitFor(() => {
			expect(screen.getByTestId("location-probe")).toHaveTextContent(/^\/digests$/);
		});
	});

	it("writes the selected inbox category tab into the category query", async () => {
		listCategoriesMock.mockReturnValue([
			{ id: "important", label: "Important", count: 2, system: true },
		]);
		const user = userEvent.setup();

		renderMessageListWithLocation(
			[makeEmail("msg-1")],
			"/",
			{ showCategoryTabs: true },
		);

		await user.click(screen.getByRole("tab", { name: "重要" }));

		await waitFor(() => {
			expect(screen.getByTestId("location-search")).toHaveTextContent(
				"?category=important",
			);
		});
	});

	it("keeps invoice child filtering stable when it is not a top-level tab", () => {
		renderMessageList([makeEmail("msg-1")], "/?tag=invoice%3Anot_uploaded");

		expect(screen.getAllByText("Subject msg-1").length).toBeGreaterThan(0);
	});

	it("shows count-free system category tabs only when enabled", () => {
		listCategoriesMock.mockReturnValue([
			{ id: "important", label: "Important", count: 2, system: true },
			{ id: "动态", label: "动态", count: 2, system: false },
		]);

		renderMessageList(
			[makeEmail("msg-1"), makeEmail("msg-2"), makeEmail("msg-3")],
			"/",
			{ showCategoryTabs: true },
		);

		expect(screen.getByRole("tab", { name: "重要" })).toBeInTheDocument();
		expect(screen.getByRole("tab", { name: "全部" })).toBeInTheDocument();
		expect(screen.queryByRole("tab", { name: "动态" })).toBeNull();
		expect(screen.queryByRole("tab", { name: "重要 2" })).toBeNull();
		expect(screen.queryByRole("tab", { name: "全部 3" })).toBeNull();
	});

	it("hides category tabs unless the route explicitly enables them", () => {
		listCategoriesMock.mockReturnValue([
			{ id: "important", label: "Important", count: 2, system: true },
		]);

		renderMessageList([makeEmail("msg-1")]);

		expect(screen.queryByRole("tab", { name: "重要" })).toBeNull();
		expect(screen.queryByRole("tab", { name: "全部" })).toBeNull();
	});

	it("shows folder total and unread context above the message list", () => {
		foldersMock.mockReturnValue([
			{ id: "inbox", name: "Inbox", unreadCount: 2, totalCount: 5 },
		]);

		renderMessageList([makeEmail("msg-1")], "/", {}, {
			data: { emails: [makeEmail("msg-1")], totalCount: 5 },
		});

		expect(screen.getByTestId("mail-count-meta")).toHaveTextContent(
			/共\s*5\s*封.*2\s*未读/,
		);
	});

	it("never renders a digest banner when summaries are not configured", async () => {
		vi.mocked(api.getLlmStatus).mockResolvedValueOnce({ configured: false });

		renderMessageList([makeEmail("msg-1")]);

		expect(screen.queryByTestId("wemail-mail-digest-banner")).toBeNull();
		expect(screen.queryByText("邮件摘要需要先配置 AI 模型。")).toBeNull();
		expect(screen.queryByRole("button", { name: "打开智能中心" })).toBeNull();
		expect(api.getDigestStatus).not.toHaveBeenCalled();
	});

	it("never renders a digest banner when summaries are configured", async () => {
		vi.mocked(api.getLlmStatus).mockResolvedValueOnce({ configured: true });

		renderMessageList([makeEmail("msg-1")]);

		expect(screen.queryByTestId("wemail-mail-digest-banner")).toBeNull();
		expect(await screen.findByRole("button", { name: "打开智能中心" })).toBeInTheDocument();
		expect(api.getDigestStatus).not.toHaveBeenCalled();
	});

	it("does not mount digest controls when the list is a smart tag classification", () => {
		renderMessageList([makeEmail("msg-1")], "/smart-tags/utag-1", {
			folder: "发票",
			listTitle: "发票",
			hideCategoryTabs: true,
			digestEnabled: false,
			mailSyncEnabled: false,
		});

		// The list title itself moved to the smart-tag route header; here the
		// message list must render rows without any digest affordances.
		expect(screen.getAllByText("Subject msg-1").length).toBeGreaterThan(0);
		expect(screen.queryByRole("button", { name: "手动刷新" })).toBeNull();
		expect(screen.queryByRole("button", { name: "打开智能中心" })).toBeNull();
		expect(screen.queryByTestId("wemail-mail-digest-banner")).toBeNull();
		expect(api.getDigestStatus).not.toHaveBeenCalled();
	});

	it("renders smart tag empty state as a classification instead of a mailbox folder", () => {
		renderMessageList([], "/smart-tags/utag-1", {
			folder: "发票",
			listTitle: "发票",
			hideCategoryTabs: true,
			digestEnabled: false,
			emptyTitle: "这个智能标签里还没有邮件",
			emptyDescription: "AI 回填或手动移入后，匹配「发票」的邮件会出现在这里。",
			showComposeInEmptyState: false,
		});

		expect(screen.getByText("这个智能标签里还没有邮件")).toBeInTheDocument();
		expect(
			screen.getByText("AI 回填或手动移入后，匹配「发票」的邮件会出现在这里。"),
		).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "写邮件" })).toBeNull();
		expect(screen.queryByText("发票 is empty")).toBeNull();
	});
});
