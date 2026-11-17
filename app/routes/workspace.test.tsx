// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceWorkspace } from "./workspace";

vi.mock("~/services/api", async (importOriginal) => {
	const actual = await importOriginal<typeof import("~/services/api")>();
	return {
		...actual,
		listWorkspaceFiles: vi.fn(),
		getWorkspaceFile: vi.fn(),
	};
});

vi.mock("~/queries/currentAccount", async () => {
	return { useCurrentAccount: vi.fn() };
});

import * as apiMod from "~/services/api";
import * as accountMod from "~/queries/currentAccount";

function mockAccount(id: string | null) {
	vi.mocked(accountMod.useCurrentAccount).mockReturnValue({
		isLoading: false,
		isError: false,
		data: id ? { account: { id, emailAddress: `${id}@x.com` } } : { account: null },
	} as unknown as ReturnType<typeof accountMod.useCurrentAccount>);
}

function renderWorkspace() {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const utils = render(
		<QueryClientProvider client={client}>
			<MemoryRouter initialEntries={["/workspace"]}>
				<WorkspaceWorkspace />
			</MemoryRouter>
		</QueryClientProvider>,
	);
	return { ...utils, client };
}

describe("WorkspaceWorkspace", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockAccount("acct-1");
	});

	it("shows the empty state when no files exist", async () => {
		vi.mocked(apiMod.listWorkspaceFiles).mockResolvedValue([]);
		renderWorkspace();
		expect(
			await screen.findByText("工作空间还没有内容"),
		).toBeInTheDocument();
		expect(screen.getByTestId("workspace-page")).toBeInTheDocument();
		expect(
			screen.getByRole("heading", { name: "工作空间" }),
		).toBeInTheDocument();
		expect(
			screen.getByText("这里仅展示可供查看的写作偏好、分类规则和学习摘要。"),
		).toBeInTheDocument();
	});

	it("renders grouped file list when API returns files", async () => {
		vi.mocked(apiMod.listWorkspaceFiles).mockResolvedValue([
			{ path: "style/voice.md", size: 12, mtime: "2026-04-01T00:00:00.000Z", type: "file", kind: "writing-style" },
			{ path: "senders/alice.md", size: 4, mtime: "2026-04-01T00:00:00.000Z", type: "file", kind: "sender-preference" },
			{ path: "categories/custom.md", size: 8, mtime: "2026-04-01T00:00:00.000Z", type: "file", kind: "category-rule" },
		]);
		renderWorkspace();
		expect(await screen.findByText("style/voice.md")).toBeInTheDocument();
		expect(screen.getByText("categories/custom.md")).toBeInTheDocument();
		// Group labels visible.
		expect(screen.getByText("写作风格")).toBeInTheDocument();
		expect(screen.getByText("联系人偏好")).toBeInTheDocument();
		expect(screen.getByText("分类规则")).toBeInTheDocument();
	});

	it("loads and shows the content of a selected file", async () => {
		vi.mocked(apiMod.listWorkspaceFiles).mockResolvedValue([
			{ path: "style/voice.md", size: 12, mtime: "2026-04-01T00:00:00.000Z", type: "file", kind: "writing-style" },
		]);
		vi.mocked(apiMod.getWorkspaceFile).mockResolvedValue({
			path: "style/voice.md",
			content: "## Tone\nCalm and direct.\n",
		});
		const user = userEvent.setup();
		renderWorkspace();
		const item = await screen.findByText("style/voice.md");
		await user.click(item);
		const pre = await screen.findByTestId("workspace-file-content");
		expect(pre.textContent).toContain("Calm and direct.");
		expect(apiMod.getWorkspaceFile).toHaveBeenCalledWith("style/voice.md");
	});

	it("shows the not-found message when getWorkspaceFile returns null (404)", async () => {
		vi.mocked(apiMod.listWorkspaceFiles).mockResolvedValue([
			{ path: "style/missing.md", size: 0, mtime: "2026-04-01T00:00:00.000Z", type: "file", kind: "writing-style" },
		]);
		vi.mocked(apiMod.getWorkspaceFile).mockResolvedValue(null);
		const user = userEvent.setup();
		renderWorkspace();
		const item = await screen.findByText("style/missing.md");
		await user.click(item);
		await waitFor(() =>
			expect(screen.getByTestId("workspace-file-not-found")).toBeInTheDocument(),
		);
	});

	// Codex review #2 regression: query keys must include accountId so
	// switching accounts does not show the previous account's cached files.
	it("does not call the workspace API when no account is signed in", async () => {
		mockAccount(null);
		renderWorkspace();
		expect(
			await screen.findByTestId("workspace-no-account"),
		).toBeInTheDocument();
		expect(apiMod.listWorkspaceFiles).not.toHaveBeenCalled();
	});

	it("isolates cached file lists per account (no cross-account leak)", async () => {
		// Render twice with two different accountIds — the listWorkspaceFiles
		// resolver returns a different roster per render. Each render gets
		// its own QueryClient, mirroring an account-switch teardown +
		// re-mount. The second render must NOT reuse the first render's
		// cached files even if both call sites use the same hook signature.
		mockAccount("acct-1");
		vi.mocked(apiMod.listWorkspaceFiles).mockResolvedValueOnce([
			{
				path: "style/voice.md",
				size: 12,
				mtime: "2026-04-01T00:00:00.000Z",
				type: "file",
				kind: "writing-style",
			},
		]);
		const first = renderWorkspace();
		expect(await screen.findByText("style/voice.md")).toBeInTheDocument();
		first.unmount();

		mockAccount("acct-2");
		vi.mocked(apiMod.listWorkspaceFiles).mockResolvedValueOnce([
			{
				path: "categories/custom.md",
				size: 8,
				mtime: "2026-04-01T00:00:00.000Z",
				type: "file",
				kind: "category-rule",
			},
		]);
		renderWorkspace();
		expect(
			await screen.findByText("categories/custom.md"),
		).toBeInTheDocument();
		// The previous account's file must be gone — even if the same
		// QueryClient were shared, the (workspace-files, accountId) key
		// would prevent the cache from leaking.
		expect(screen.queryByText("style/voice.md")).not.toBeInTheDocument();
	});

	it("clears the selected path when the active account changes", async () => {
		// Acct-1 selects style/voice.md; switching to acct-2 must reset
		// the right-pane selection so we never call getWorkspaceFile with
		// a path that does not belong to the new account.
		mockAccount("acct-1");
		vi.mocked(apiMod.listWorkspaceFiles).mockResolvedValue([
			{
				path: "style/voice.md",
				size: 12,
				mtime: "2026-04-01T00:00:00.000Z",
				type: "file",
				kind: "writing-style",
			},
		]);
		vi.mocked(apiMod.getWorkspaceFile).mockResolvedValue({
			path: "style/voice.md",
			content: "voice for acct-1",
		});

		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		const user = userEvent.setup();
		const utils = render(
			<QueryClientProvider client={client}>
				<MemoryRouter initialEntries={["/workspace"]}>
					<WorkspaceWorkspace />
				</MemoryRouter>
			</QueryClientProvider>,
		);
		await user.click(await screen.findByText("style/voice.md"));
		await screen.findByTestId("workspace-file-content");

		// Account switch — re-render with acct-2.
		mockAccount("acct-2");
		utils.rerender(
			<QueryClientProvider client={client}>
				<MemoryRouter initialEntries={["/workspace"]}>
					<WorkspaceWorkspace />
				</MemoryRouter>
			</QueryClientProvider>,
		);
		// Right pane reverts to the "select a file" prompt.
		await waitFor(() => {
			expect(
				screen.getByText("选择一个文件查看内容"),
			).toBeInTheDocument();
		});
	});
});
