import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import SnoozeMenu from "./SnoozeMenu";

describe("SnoozeMenu", () => {
	it("explains why an invalid custom time cannot be submitted", async () => {
		const user = userEvent.setup();
		const onPick = vi.fn();
		render(
			<SnoozeMenu onPick={onPick}>
				<button type="button">延后处理</button>
			</SnoozeMenu>,
		);

		await user.click(screen.getByRole("button", { name: "延后处理" }));
		const input = screen.getByLabelText("自定义时间");
		await user.clear(input);
		await user.click(screen.getByRole("button", { name: "确定" }));

		expect(screen.getByRole("alert")).toHaveTextContent("请选择一个时间");
		expect(input).toHaveAttribute("aria-invalid", "true");
		expect(onPick).not.toHaveBeenCalled();
	});
});
