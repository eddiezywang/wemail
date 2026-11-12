import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DirectoryRecipientInput } from "./DirectoryRecipientInput";

const { searchDirectoryContacts } = vi.hoisted(() => ({
	searchDirectoryContacts: vi.fn(),
}));

vi.mock("~/services/api", () => ({
	default: { searchDirectoryContacts },
}));

function Harness() {
	const [value, setValue] = useState("");
	return (
		<>
			<DirectoryRecipientInput value={value} onChange={setValue} ariaLabel="收件人" />
			<output aria-label="序列化收件人">{value}</output>
		</>
	);
}

describe("DirectoryRecipientInput", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		searchDirectoryContacts.mockReset();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("shows a persistent underline, waits 300ms, and turns a match into a removable tag", async () => {
		searchDirectoryContacts.mockResolvedValue({
			ok: true,
			remoteAvailable: true,
			total: 1,
			contacts: [{
				id: "evanxu@example.com",
				accountId: "acct-1",
				name: "evanxu(徐自然)",
				email: "evanxu@example.com",
				aliases: [],
				departmentPath: "个人金融事业群/财富产品部",
			}],
		});
		render(<Harness />);

		const input = screen.getByRole("combobox", { name: "收件人" });
		expect(input).not.toHaveAttribute("placeholder");
		expect(input.parentElement).toHaveClass(
			"border-b",
			"border-edge",
			"focus-within:border-coral",
		);
		fireEvent.focus(input);
		fireEvent.change(input, { target: { value: "evan" } });

		await act(async () => {
			await vi.advanceTimersByTimeAsync(299);
		});
		expect(searchDirectoryContacts).not.toHaveBeenCalled();

		await act(async () => {
			await vi.advanceTimersByTimeAsync(1);
		});
		expect(searchDirectoryContacts).toHaveBeenCalledTimes(1);
		expect(searchDirectoryContacts).toHaveBeenCalledWith("evan", expect.objectContaining({ limit: 8 }));

		const option = screen.getByRole("option", { name: /evanxu\(徐自然\)/ });
		fireEvent.mouseDown(option);
		fireEvent.click(option);

		expect(screen.getByLabelText("序列化收件人")).toHaveTextContent(
			"evanxu(徐自然) <evanxu@example.com>",
		);
		expect(screen.getByRole("button", { name: "移除收件人 evanxu(徐自然)" })).toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: "移除收件人 evanxu(徐自然)" }));
		expect(screen.getByLabelText("序列化收件人")).toBeEmptyDOMElement();
	});

	it("adds valid external emails directly and deduplicates them case-insensitively", () => {
		render(<Harness />);
		const input = screen.getByRole("combobox", { name: "收件人" });
		fireEvent.focus(input);
		fireEvent.change(input, { target: { value: "outside@example.com" } });
		fireEvent.keyDown(input, { key: "Enter" });

		expect(screen.getByLabelText("序列化收件人")).toHaveTextContent("outside@example.com");
		fireEvent.change(input, { target: { value: "OUTSIDE@example.com" } });
		fireEvent.keyDown(input, { key: "," });
		expect(screen.getAllByTitle(/outside@example\.com/i)).toHaveLength(1);
	});

	it("waits for IME composition to finish before starting the 300ms timer", async () => {
		searchDirectoryContacts.mockResolvedValue({
			ok: true,
			remoteAvailable: true,
			total: 0,
			contacts: [],
		});
		render(<Harness />);
		const input = screen.getByRole("combobox", { name: "收件人" });
		fireEvent.focus(input);
		fireEvent.compositionStart(input);
		fireEvent.change(input, { target: { value: "王" } });

		await act(async () => {
			await vi.advanceTimersByTimeAsync(1_000);
		});
		expect(searchDirectoryContacts).not.toHaveBeenCalled();

		fireEvent.compositionEnd(input);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(299);
		});
		expect(searchDirectoryContacts).not.toHaveBeenCalled();

		await act(async () => {
			await vi.advanceTimersByTimeAsync(1);
		});
		expect(searchDirectoryContacts).toHaveBeenCalledWith("王", expect.objectContaining({ limit: 8 }));
	});
});
