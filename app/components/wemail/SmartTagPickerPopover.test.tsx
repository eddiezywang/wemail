import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import SmartTagPickerPopover from "./SmartTagPickerPopover";
import api from "~/services/api";

vi.hoisted(() => {
	vi.resetModules();
});

vi.mock("~/services/api", () => ({
	default: {
		applyMessageSmartTag: vi.fn(),
		listUserTags: vi.fn(),
		removeMessageSmartTag: vi.fn(),
	},
}));

vi.mock("~/hooks/useUIStore", () => ({
	useUIStore: () => ({
		openCreateTagDialog: vi.fn(),
	}),
}));

function renderWithClient(ui: ReactElement) {
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

describe("SmartTagPickerPopover", () => {
	it("splits selected smart tags into remove actions and unselected tags into apply actions", async () => {
		const user = userEvent.setup();
		vi.mocked(api.listUserTags).mockResolvedValue({
			ok: true,
			tags: [
				{
					id: "tag-invoice",
					accountId: "acct-1",
					name: "发票",
					description: "电子发票",
					prompt: "识别电子发票",
					createdAt: "2026-06-28T00:00:00.000Z",
					updatedAt: "2026-06-28T00:00:00.000Z",
				},
				{
					id: "tag-notice",
					accountId: "acct-1",
					name: "通知",
					description: "系统通知",
					prompt: "识别系统通知",
					createdAt: "2026-06-28T00:00:00.000Z",
					updatedAt: "2026-06-28T00:00:00.000Z",
				},
			],
		});
		vi.mocked(api.applyMessageSmartTag).mockResolvedValue({ ok: true });
		vi.mocked(api.removeMessageSmartTag).mockResolvedValue({ ok: true });

		renderWithClient(
			<SmartTagPickerPopover
				emailId="msg-1"
				accountId="acct-1"
				appliedTags={new Set(["发票"])}
			>
				<button type="button">标签处理</button>
			</SmartTagPickerPopover>,
		);

		await user.click(screen.getByRole("button", { name: "标签处理" }));

		expect(await screen.findByText("已选标签")).toBeInTheDocument();
		expect(screen.getByText("可移入标签")).toBeInTheDocument();
		expect(screen.getByTestId("smart-tag-picker-remove-发票")).toHaveTextContent(
			"移出",
		);
		expect(screen.queryByTestId("smart-tag-picker-apply-发票")).toBeNull();
		expect(screen.getByTestId("smart-tag-picker-apply-通知")).toHaveTextContent(
			"移入",
		);
		expect(screen.queryByTestId("smart-tag-picker-remove-通知")).toBeNull();

		await user.click(screen.getByTestId("smart-tag-picker-apply-通知"));
		await user.type(screen.getByLabelText("智能标签操作备注"), "人工纠正");
		await user.click(screen.getByTestId("smart-tag-action-confirm"));
		expect(api.applyMessageSmartTag).toHaveBeenCalledWith(
			"msg-1",
			"tag-notice",
			"人工纠正",
		);

		await user.click(screen.getByRole("button", { name: "标签处理" }));
		await user.click(screen.getByTestId("smart-tag-picker-remove-发票"));
		await user.click(screen.getByTestId("smart-tag-action-confirm"));
		expect(api.removeMessageSmartTag).toHaveBeenCalledWith(
			"msg-1",
			"tag-invoice",
			undefined,
		);
	});
});
