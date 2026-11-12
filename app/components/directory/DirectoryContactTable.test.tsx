import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DirectoryContactTable } from "./DirectoryContactTable";

const contacts = [
	{
		id: "evan",
		accountId: "acct-1",
		name: "Evan Xu",
		email: "evan@example.com",
		aliases: [],
		mobile: "13800000000",
		title: "开发工程师",
	},
	{
		id: "alice",
		accountId: "acct-1",
		name: "Alice Wang",
		email: "alice@example.com",
		aliases: [],
	},
];

describe("DirectoryContactTable", () => {
	it("selects the current page, composes, and paginates", () => {
		const onTogglePage = vi.fn();
		const onCompose = vi.fn();
		const onPageChange = vi.fn();
		render(
			<DirectoryContactTable
				title="开发一室"
				contacts={contacts}
				total={52}
				page={0}
				pageSize={50}
				loading={false}
				error={false}
				emptyHint=""
				selectedIds={new Set(contacts.map((contact) => contact.id))}
				selectedContacts={contacts}
				onToggle={vi.fn()}
				onTogglePage={onTogglePage}
				onClearSelection={vi.fn()}
				onCompose={onCompose}
				onPageChange={onPageChange}
				onRetry={vi.fn()}
			/>,
		);

		fireEvent.click(screen.getByRole("checkbox", { name: "选择当前页联系人" }));
		expect(onTogglePage).toHaveBeenCalledWith(contacts, false);

		fireEvent.click(screen.getByRole("button", { name: "写邮件" }));
		expect(onCompose).toHaveBeenCalledWith(contacts);

		fireEvent.click(screen.getByRole("button", { name: "下一页" }));
		expect(onPageChange).toHaveBeenCalledWith(1);
	});
});
