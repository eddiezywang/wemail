import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { ModelPicker } from "./ModelPicker";

describe("ModelPicker", () => {
	it("selects discovered model ids without speculative labels", async () => {
		const user = userEvent.setup();
		const onChange = vi.fn();
		render(
			<ModelPicker
				value="current-model"
				onChange={onChange}
				models={[{ id: "model-a", ownedBy: "provider" }, { id: "model-b" }]}
				status="success"
			/>,
		);

		await user.click(screen.getByRole("button", { name: "显示模型列表" }));
		expect(screen.getByRole("option", { name: /model-a/ })).toBeInTheDocument();
		expect(screen.queryByText(/推荐|高质量|经济|性能/)).not.toBeInTheDocument();
		await user.click(screen.getByRole("option", { name: /model-b/ }));
		expect(onChange).toHaveBeenCalledWith("model-b");
	});

	it("keeps manual custom model entry available when discovery fails", async () => {
		const user = userEvent.setup();
		const onChange = vi.fn();
		function Harness() {
			const [value, setValue] = useState("");
			return (
				<ModelPicker
					value={value}
					onChange={(next) => {
						setValue(next);
						onChange(next);
					}}
					models={[]}
					status="error"
					showStatus
				/>
			);
		}
		render(<Harness />);

		await user.type(screen.getByRole("combobox"), "private-model");
		expect(onChange).toHaveBeenCalled();
		expect(screen.getByText("未能获取模型列表，可直接输入模型 ID")).toBeInTheDocument();
		expect(screen.getByRole("option", { name: /使用“private-model”作为自定义模型 ID/ })).toBeInTheDocument();
	});

	it("includes a custom model in keyboard option navigation", async () => {
		const user = userEvent.setup();
		const onChange = vi.fn();
		function Harness() {
			const [value, setValue] = useState("");
			return (
				<ModelPicker
					value={value}
					onChange={(next) => {
						setValue(next);
						onChange(next);
					}}
					models={[{ id: "known-model" }]}
				/>
			);
		}
		render(<Harness />);
		const input = screen.getByRole("combobox");

		await user.type(input, "private-model");
		await user.keyboard("{End}{Enter}");

		expect(onChange).toHaveBeenLastCalledWith("private-model");
		expect(input).toHaveValue("private-model");
	});

	it("uses one stable input for opening, searching, and selecting", async () => {
		const user = userEvent.setup();
		function Harness() {
			const [value, setValue] = useState("");
			return (
				<ModelPicker
					value={value}
					onChange={setValue}
					models={[{ id: "gpt-5.3-codex-spark" }, { id: "gpt-5.3-chat" }]}
				/>
			);
		}
		render(<Harness />);
		const input = screen.getByRole("combobox");

		await user.click(input);
		expect(screen.getByRole("option", { name: "gpt-5.3-chat" })).toBeInTheDocument();
		await user.type(input, "codex");
		expect(screen.getByRole("option", { name: "gpt-5.3-codex-spark" })).toBeInTheDocument();
		expect(screen.queryByRole("option", { name: "gpt-5.3-chat" })).not.toBeInTheDocument();
		await user.click(input);
		expect(screen.getByRole("listbox")).toBeInTheDocument();
	});

	it("scrolls a long model list when the wheel event is captured by a modal lock", async () => {
		const user = userEvent.setup();
		render(
			<ModelPicker
				value=""
				onChange={vi.fn()}
				models={Array.from({ length: 20 }, (_, index) => ({ id: `model-${index}` }))}
			/>,
		);

		await user.click(screen.getByRole("button", { name: "显示模型列表" }));
		const listbox = screen.getByRole("listbox");
		Object.defineProperties(listbox, {
			clientHeight: { configurable: true, value: 100 },
			scrollHeight: { configurable: true, value: 800 },
			scrollTop: { configurable: true, writable: true, value: 0 },
		});

		fireEvent.wheel(listbox, { deltaY: 120 });
		expect(listbox.scrollTop).toBe(120);
		fireEvent.wheel(listbox, { deltaY: -40 });
		expect(listbox.scrollTop).toBe(80);
	});
});
