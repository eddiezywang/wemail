import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RefObject } from "react";
import InlineFloatingCompose from "./InlineFloatingCompose";
import { useUIStore } from "~/hooks/useUIStore";

vi.mock("./ComposeBody", () => ({
	default: ({ renderHeader }: { renderHeader: (state: Record<string, unknown>) => React.ReactNode }) => (
		<>
			{renderHeader({
				formTitle: "Reply",
				isSending: false,
				isSavingDraft: false,
				formId: "compose-form",
				closeCompose: vi.fn(),
				handleSchedule: vi.fn(),
			})}
			<div>Compose content</div>
		</>
	),
}));

function containerRef(): RefObject<HTMLDivElement | null> {
	const element = document.createElement("div");
	vi.spyOn(element, "getBoundingClientRect").mockReturnValue({
		x: 200,
		y: 100,
		left: 200,
		top: 100,
		right: 1000,
		bottom: 800,
		width: 800,
		height: 700,
		toJSON: () => ({}),
	});
	return { current: element };
}

describe("InlineFloatingCompose", () => {
	beforeEach(() => {
		useUIStore.setState({
			isComposing: true,
			composeOptions: {
				mode: "reply",
				draftEmail: null,
				originalEmail: {
					id: "email-1",
					sender: "Alice <alice@example.com>",
					recipient: "me@example.com",
					subject: "Hello",
					date: "2026-07-17T00:00:00Z",
					body: "Hello",
				},
			},
		});
		Object.defineProperty(window, "innerWidth", { value: 1200, writable: true });
		Object.defineProperty(window, "innerHeight", { value: 900, writable: true });
		HTMLElement.prototype.setPointerCapture = vi.fn();
		HTMLElement.prototype.releasePointerCapture = vi.fn();
		HTMLElement.prototype.hasPointerCapture = vi.fn(() => true);
	});

	it("renders eight resize handles in floating mode", async () => {
		render(<InlineFloatingCompose containerRef={containerRef()} />);

		await screen.findByTestId("inline-floating-compose");
		expect(document.querySelectorAll("[data-resize-direction]")).toHaveLength(8);
	});

	it("restores the full floating rectangle after repeated maximize cycles", async () => {
		const user = userEvent.setup();
		render(<InlineFloatingCompose containerRef={containerRef()} />);
		const panel = await screen.findByTestId("inline-floating-compose");
		await waitFor(() => expect(panel.style.width).toBe("600px"));

		for (let cycle = 0; cycle < 3; cycle += 1) {
			await user.click(
				screen.getByRole("button", { name: "最大化写信窗口" }),
			);
			expect(panel.style.width).toBe("1180px");
			await user.click(
				screen.getByRole("button", { name: "还原写信窗口" }),
			);
			expect(panel.style.width).toBe("600px");
			expect(panel.style.height).toBe("520px");
		}
	});

	it("resizes from the east edge with pointer capture", async () => {
		render(<InlineFloatingCompose containerRef={containerRef()} />);
		const panel = await screen.findByTestId("inline-floating-compose");
		await waitFor(() => expect(panel.style.width).toBe("600px"));
		const handle = document.querySelector('[data-resize-direction="e"]');
		expect(handle).not.toBeNull();

		fireEvent.pointerDown(handle!, { pointerId: 1, clientX: 700, clientY: 300 });
		fireEvent.pointerMove(handle!, { pointerId: 1, clientX: 780, clientY: 300 });
		fireEvent.pointerUp(handle!, { pointerId: 1, clientX: 780, clientY: 300 });

		expect(panel.style.width).toBe("680px");
	});
});
