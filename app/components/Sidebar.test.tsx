import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Sidebar from "./Sidebar";

vi.hoisted(() => {
	vi.resetModules();
});

const editionFeatures = vi.hoisted(() => ({
	enterpriseDirectory: false,
	allowanceInvoice: false,
}));

vi.mock("~/hooks/useEditionFeatures", () => ({
	useEditionFeatures: () => ({
		wecli: false,
		allowanceInvoice: editionFeatures.allowanceInvoice,
		enterpriseDirectory: editionFeatures.enterpriseDirectory,
		officeSceneDetection: false,
	}),
}));

vi.mock("~/queries/folders", () => ({
	useFolders: vi.fn(),
}));

vi.mock("~/queries/mailboxes", () => ({
	useMailbox: vi.fn(),
}));

vi.mock("~/queries/currentAccount", () => ({
	useCurrentAccount: vi.fn(),
}));

vi.mock("~/queries/scheduledDrafts", () => ({
	useScheduledDrafts: vi.fn(),
}));

vi.mock("~/queries/userTags", () => ({
	useUserTags: vi.fn(),
}));

vi.mock("~/queries/listCategories", () => ({
	useListCategories: vi.fn(),
}));
vi.mock("~/queries/applicationMessages", () => ({
	useApplicationMessages: vi.fn(),
}));
vi.mock("~/queries/integrationStatus", () => ({
	useIntegrationStatus: () => ({ data: null }),
}));
vi.mock("~/components/wemail/CreateSmartTagDialog", () => ({
	CreateSmartTagDialog: () => null,
}));

vi.mock("~/components/wemail/ManageSmartTagDialog", () => ({
	ManageSmartTagDialog: () => null,
}));

vi.mock("~/hooks/useUIStore", () => ({
	useUIStore: () => ({
		startCompose: vi.fn(),
		closeSidebar: vi.fn(),
		openSettings: vi.fn(),
		isCreateTagDialogOpen: false,
		openCreateTagDialog: vi.fn(),
		closeCreateTagDialog: vi.fn(),
	}),
}));

import { useCurrentAccount } from "~/queries/currentAccount";
import { useFolders } from "~/queries/folders";
import { useMailbox } from "~/queries/mailboxes";
import { useScheduledDrafts } from "~/queries/scheduledDrafts";
import { useUserTags } from "~/queries/userTags";
import { useListCategories } from "~/queries/listCategories";
import { useApplicationMessages } from "~/queries/applicationMessages";

function renderAt(initialPath: string) {
	return render(
		<MemoryRouter initialEntries={[initialPath]}>
			<Sidebar />
		</MemoryRouter>,
	);
}

function renderCompact(initialPath: string) {
	return render(
		<MemoryRouter initialEntries={[initialPath]}>
			<Sidebar compact />
		</MemoryRouter>,
	);
}

describe("Sidebar", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		localStorage.clear();
		editionFeatures.enterpriseDirectory = false;
		editionFeatures.allowanceInvoice = false;
		vi.mocked(useCurrentAccount).mockReturnValue({
			data: { account: { id: "acct-1", emailAddress: "user@example.com" } },
		} as unknown as ReturnType<typeof useCurrentAccount>);
		vi.mocked(useFolders).mockReturnValue({
			data: [],
		} as unknown as ReturnType<typeof useFolders>);
		vi.mocked(useMailbox).mockReturnValue({
			data: {
				id: "acct-1",
				email: "user@example.com",
				name: "User",
				settings: {},
			},
		} as unknown as ReturnType<typeof useMailbox>);
		vi.mocked(useScheduledDrafts).mockReturnValue({
			data: { scheduled: [] },
		} as unknown as ReturnType<typeof useScheduledDrafts>);
		vi.mocked(useUserTags).mockReturnValue({
			data: [],
		} as unknown as ReturnType<typeof useUserTags>);
		vi.mocked(useListCategories).mockReturnValue({
			data: [],
		} as unknown as ReturnType<typeof useListCategories>);
		vi.mocked(useApplicationMessages).mockReturnValue({
			data: { messages: [], total: 0, unread: 0 },
		} as unknown as ReturnType<typeof useApplicationMessages>);
	});

	it("does not expose the newsletter module in the primary navigation", () => {
		const { container } = renderAt("/");

		expect(screen.getByText("收件箱")).toBeInTheDocument();
		expect(screen.getByText("待办")).toBeInTheDocument();
		expect(screen.getByRole("link", { name: "定时发送" })).toBeInTheDocument();
		expect(screen.queryByRole("link", { name: "已延后" })).not.toBeInTheDocument();
		expect(screen.queryByRole("link", { name: "归档" })).not.toBeInTheDocument();
		expect(screen.getByRole("link", { name: "自动化" })).toHaveAttribute(
			"href",
			"/automation",
		);
		expect(screen.queryByText("newsletter")).not.toBeInTheDocument();
		expect(container.firstElementChild).toHaveAttribute(
			"data-testid",
			"mail-sidebar",
		);
		expect(container.firstElementChild).toHaveClass("bg-sidebar");
		expect(
			screen.queryByTestId("sidebar-connected-integrations"),
		).not.toBeInTheDocument();
	});

	it("hides the enterprise directory entry in the open edition", () => {
		editionFeatures.enterpriseDirectory = false;
		renderAt("/");
		expect(screen.queryByRole("link", { name: "通讯录" })).toBeNull();
	});

	it("shows the enterprise directory entry when the edition enables it", () => {
		editionFeatures.enterpriseDirectory = true;
		renderAt("/");
		expect(screen.getByRole("link", { name: "通讯录" })).toHaveAttribute(
			"href",
			"/directory",
		);
	});

	it("keeps low-frequency history centers out of primary navigation", () => {
		renderAt("/digests");

		expect(screen.queryByRole("link", { name: /行动中心/ })).toBeNull();
		expect(screen.queryByRole("link", { name: /摘要中心/ })).toBeNull();
		expect(screen.queryByRole("link", { name: /工作空间/ })).toBeNull();
	});

	it("shows unread counts in the sidebar and keeps totals out of the primary badge", () => {
		vi.mocked(useFolders).mockReturnValue({
			data: [
				{
					id: "inbox",
					name: "Inbox",
					unreadCount: 14,
					totalCount: 20,
				},
				{
					id: "chatgpt",
					name: "chatgpt",
					unreadCount: 2,
					totalCount: 7,
				},
			],
		} as unknown as ReturnType<typeof useFolders>);

		const { container } = renderAt("/folder/chatgpt");

		const inboxLink = container.querySelector('a[data-folder="inbox"]');
		expect(inboxLink).not.toBeNull();
		expect(inboxLink!.textContent).toContain("收件箱");
		expect(inboxLink!.textContent).toContain("14");
		expect(inboxLink!.textContent).not.toContain("20");

		const customFolderLink = container.querySelector('a[data-folder="chatgpt"]');
		expect(customFolderLink).not.toBeNull();
		expect(customFolderLink!.textContent).toContain("chatgpt");
		expect(customFolderLink!.textContent).toContain("2");
		expect(customFolderLink!.textContent).not.toContain("7");
	});

	it("groups categories, smart tags, and mailbox folders under All Mail", () => {
		editionFeatures.allowanceInvoice = true;
		vi.mocked(useFolders).mockReturnValue({
			data: [
				{ id: "inbox", name: "Inbox", unreadCount: 14, totalCount: 20 },
				{ id: "chatgpt", name: "chatgpt", unreadCount: 2, totalCount: 7 },
			],
		} as unknown as ReturnType<typeof useFolders>);
		vi.mocked(useListCategories).mockReturnValue({
			data: [
				{ id: "important", label: "Important", count: 9, unreadCount: 4, system: true },
				{ id: "action_required", label: "Action required", count: 5, unreadCount: 2, system: true },
				{ id: "invoice", label: "Invoice", count: 3, unreadCount: 1, system: true },
			],
		} as unknown as ReturnType<typeof useListCategories>);
		vi.mocked(useUserTags).mockReturnValue({
			data: [
				{
					id: "tag-1",
					accountId: "acct-1",
					name: "项目阿尔法",
					description: "项目邮件",
					prompt: "项目邮件",
					createdAt: "2026-06-28T00:00:00.000Z",
					updatedAt: "2026-06-28T00:00:00.000Z",
					unreadCount: 3,
				},
			],
		} as unknown as ReturnType<typeof useUserTags>);

		const { container } = renderAt("/");

		expect(screen.getByTestId("all-mail-children")).toBeInTheDocument();
		expect(screen.getByText("发票")).toBeInTheDocument();
		expect(screen.getByText("项目阿尔法")).toBeInTheDocument();
		expect(screen.getByText("chatgpt")).toBeInTheDocument();
		expect(screen.getByTestId("system-classification-heading")).toHaveTextContent("智能分类");
		expect(screen.getByTestId("user-smart-tags-heading")).toHaveTextContent("我的智能标签");
		expect(screen.getByTestId("user-smart-tags-heading")).not.toHaveTextContent("自定义");
		expect(screen.getByTestId("mailbox-folders-heading")).toHaveTextContent("邮箱文件夹");
		for (const testId of ["system-classification-heading", "user-smart-tags-heading", "mailbox-folders-heading"]) {
			expect(screen.getByTestId(testId)).toHaveClass("text-control", "font-semibold");
		}
		expect(container.querySelectorAll('a[data-folder="inbox"]')).toHaveLength(1);
		const allMailLink = container.querySelector('a[data-folder="all-mail"]');
		expect(allMailLink?.textContent).toBe("所有邮件");
		expect(allMailLink).toHaveAttribute("href", "/folder/all-mail");
		expect(allMailLink?.parentElement).toHaveClass("text-ui");
	});

	it("renders a compact icon rail without nested mailbox navigation", () => {
		renderCompact("/");

		expect(screen.getByTestId("mail-sidebar")).toHaveAttribute("data-compact", "true");
		expect(screen.getByRole("link", { name: "所有邮件" })).toHaveAttribute(
			"href",
			"/folder/all-mail",
		);
		expect(screen.queryByTestId("all-mail-navigation-group")).toBeNull();
		expect(screen.getByTestId("compose-button").querySelector("span:last-child")).toHaveClass(
			"sr-only",
		);
	});

	it("collapses each All Mail subgroup independently", () => {
		vi.mocked(useFolders).mockReturnValue({
			data: [
				{ id: "inbox", name: "Inbox", unreadCount: 14, totalCount: 20 },
				{ id: "chatgpt", name: "chatgpt", unreadCount: 2, totalCount: 7 },
			],
		} as unknown as ReturnType<typeof useFolders>);
		vi.mocked(useListCategories).mockReturnValue({
			data: [
				{ id: "important", label: "Important", count: 9, unreadCount: 4, system: true },
			],
		} as unknown as ReturnType<typeof useListCategories>);
		vi.mocked(useUserTags).mockReturnValue({
			data: [
				{
					id: "tag-1",
					accountId: "acct-1",
					name: "项目阿尔法",
					description: "项目邮件",
					prompt: "项目邮件",
					createdAt: "2026-06-28T00:00:00.000Z",
					updatedAt: "2026-06-28T00:00:00.000Z",
				},
			],
		} as unknown as ReturnType<typeof useUserTags>);

		renderAt("/");
		const systemHeading = screen.getByTestId("system-classification-heading");
		const smartTagHeading = screen.getByTestId("user-smart-tags-heading");
		const mailboxHeading = screen.getByTestId("mailbox-folders-heading");

		expect(systemHeading).toHaveAttribute("aria-expanded", "true");
		expect(smartTagHeading).toHaveAttribute("aria-expanded", "true");
		expect(mailboxHeading).toHaveAttribute("aria-expanded", "true");

		fireEvent.click(systemHeading);
		expect(screen.queryByTestId("system-classification-items")).toBeNull();
		expect(screen.getByTestId("user-smart-tags-items")).toBeInTheDocument();
		expect(screen.getByTestId("mailbox-folder-items")).toBeInTheDocument();

		fireEvent.click(smartTagHeading);
		expect(screen.queryByTestId("user-smart-tags-items")).toBeNull();
		expect(screen.getByTestId("mailbox-folder-items")).toBeInTheDocument();

		fireEvent.click(mailboxHeading);
		expect(screen.queryByTestId("mailbox-folder-items")).toBeNull();

		fireEvent.click(systemHeading);
		expect(screen.getByTestId("system-classification-items")).toBeInTheDocument();
	});

	it("toggles children without navigating the All Mail link", () => {
		renderAt("/");
		const toggle = screen.getByTestId("all-mail-toggle");
		const link = screen.getByRole("link", { name: /所有邮件/ });
		const row = toggle.parentElement;

		expect(link).toHaveAttribute("href", "/folder/all-mail");
		expect(row?.firstElementChild).toBe(link);
		expect(row?.lastElementChild).toBe(toggle);
		expect(screen.getByTestId("all-mail-children")).toBeInTheDocument();
		fireEvent.click(toggle);
		expect(screen.queryByTestId("all-mail-children")).toBeNull();
		expect(link).toHaveAttribute("href", "/folder/all-mail");
		fireEvent.click(toggle);
		expect(screen.getByTestId("all-mail-children")).toBeInTheDocument();
	});

	it("selects only the system category named by the URL query", () => {
		editionFeatures.allowanceInvoice = true;
		vi.mocked(useListCategories).mockReturnValue({
			data: [
				{ id: "important", label: "Important", count: 9, unreadCount: 4, system: true },
				{ id: "invoice", label: "Invoice", count: 12, unreadCount: 6, system: true },
			],
		} as unknown as ReturnType<typeof useListCategories>);

		const { container } = renderAt("/folder/all-mail?category=important");
		const important = container.querySelector('a[data-folder="category:important"]');
		const invoice = container.querySelector('a[data-folder="category:invoice"]');
		const allMail = container.querySelector('a[data-folder="all-mail"]');

		expect(important).not.toBeNull();
		expect(invoice).not.toBeNull();
		expect(important!.className).not.toMatch(/bg-sidebar-active/);
		expect(important!.className).toMatch(/text-coral/);
		expect(important!.querySelector("span span")?.className).toMatch(/bg-edge-3/);
		expect(invoice!.className).not.toMatch(/bg-sidebar-active/);
		expect(allMail!.className).not.toMatch(/bg-sidebar-active/);
	});

	it("hides the invoice system category when the edition feature is off", () => {
		// P2.6: the invoice smart category is an edition module capability;
		// legacy category rows stay in the DB but the nav hides the entry.
		vi.mocked(useListCategories).mockReturnValue({
			data: [
				{ id: "important", label: "Important", count: 9, unreadCount: 4, system: true },
				{ id: "invoice", label: "Invoice", count: 12, unreadCount: 6, system: true },
			],
		} as unknown as ReturnType<typeof useListCategories>);

		const { container } = renderAt("/folder/all-mail?category=invoice");
		const invoice = container.querySelector('a[data-folder="category:invoice"]');
		const important = container.querySelector('a[data-folder="category:important"]');
		expect(important).not.toBeNull();
		expect(invoice).toBeNull();
	});

	it("uses the same soft active state for smart tag navigation", () => {
		vi.mocked(useUserTags).mockReturnValue({
			data: [
				{
					id: "tag-1",
					accountId: "acct-1",
					name: "发票",
					description: "发票邮件",
					prompt: "发票邮件",
					createdAt: "2026-06-28T00:00:00.000Z",
					updatedAt: "2026-06-28T00:00:00.000Z",
				},
			],
		} as unknown as ReturnType<typeof useUserTags>);

		renderAt("/smart-tags/tag-1");

		const link = screen.getByText("发票").closest("a");
		expect(link).not.toBeNull();
		expect(link!.className).not.toMatch(/bg-blue\/10/);
		expect(link!.className).toMatch(/text-blue/);
		expect(link!.querySelector("span span")?.className).toMatch(/bg-edge-3/);
		expect(link!.className).not.toMatch(/text-\[#1683ff\]/);
		expect(link!.className).not.toMatch(/shadow-\[/);
		expect(link!.className).not.toMatch(/inset_3px/);
	});

	it("does not render invoice workflow states as third-level navigation", () => {
		vi.mocked(useUserTags).mockReturnValue({
			data: [
				{
					id: "tag-invoice",
					accountId: "acct-1",
					name: "发票",
					description: "来自商家的发票",
					prompt: "判断是否为发票",
					createdAt: "2026-06-28T00:00:00.000Z",
					updatedAt: "2026-06-28T00:00:00.000Z",
				},
			],
		} as unknown as ReturnType<typeof useUserTags>);

		renderAt("/?tag=invoice%3Anot_uploaded");

		expect(screen.queryByText("已上传")).toBeNull();
		expect(screen.queryByText("未上传")).toBeNull();
		expect(screen.getByText("发票")).toBeInTheDocument();
	});

	it("uses the same exact lightweight active state for custom folders", () => {
		vi.mocked(useFolders).mockReturnValue({
			data: [
				{ id: "inbox", name: "Inbox", unreadCount: 14, totalCount: 20 },
				{ id: "告警", name: "告警", unreadCount: 2, totalCount: 7 },
				{ id: "慢查询", name: "慢查询", unreadCount: 3, totalCount: 8 },
			],
		} as unknown as ReturnType<typeof useFolders>);

		const { container } = renderAt("/folder/%E5%91%8A%E8%AD%A6");
		const alertFolder = container.querySelector('a[data-folder="告警"]');
		const slowQueryFolder = container.querySelector('a[data-folder="慢查询"]');

		expect(alertFolder!.className).not.toMatch(/bg-sidebar-active/);
		expect(slowQueryFolder!.className).not.toMatch(/bg-sidebar-active/);
	});
});
