import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DirectoryTree } from "./DirectoryTree";

const { listDirectoryDepartments } = vi.hoisted(() => ({
	listDirectoryDepartments: vi.fn(),
}));

vi.mock("~/services/api", () => ({
	default: { listDirectoryDepartments },
}));

const root = {
	id: "root",
	accountId: "acct-1",
	name: "example.com",
	path: "example.com",
	childCount: 1,
	syncedAt: "2026-07-24T00:00:00.000Z",
};

const child = {
	id: "root/dev-one",
	accountId: "acct-1",
	parentId: "root",
	name: "开发一室",
	path: "example.com/科技事业群/开发一室",
	childCount: 0,
	syncedAt: "2026-07-24T00:00:00.000Z",
};

describe("DirectoryTree", () => {
	beforeEach(() => {
		listDirectoryDepartments.mockReset().mockImplementation((parentId?: string) =>
			Promise.resolve({
				ok: true,
				departments: parentId === root.id ? [child] : [root],
			}),
		);
	});

	it("loads direct children and selects a department by name", async () => {
		const onSelect = vi.fn();
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false, gcTime: Number.POSITIVE_INFINITY } },
		});
		const view = render(
			<QueryClientProvider client={client}>
				<DirectoryTree onSelect={onSelect} />
			</QueryClientProvider>,
		);

		fireEvent.click(await screen.findByRole("button", { name: "开发一室" }));

		expect(listDirectoryDepartments).toHaveBeenCalledWith("root");
		expect(onSelect).toHaveBeenCalledWith(child);
		view.unmount();
		client.clear();
	});
});
