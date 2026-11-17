import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useUIStore } from "~/hooks/useUIStore";
import { TooltipProvider } from "~/components/ui/tooltip";
import FloatingAiLauncher from "./FloatingAiLauncher";

function renderLauncher() {
	return render(
		<TooltipProvider delayDuration={0}>
			<FloatingAiLauncher />
		</TooltipProvider>,
	);
}

describe("FloatingAiLauncher", () => {
	beforeEach(() => {
		useUIStore.setState({ isAgentPanelOpen: false });
	});

	it("renders a fixed WeMail AI entry without a brand image or persistent chrome", () => {
		renderLauncher();

		const button = screen.getByRole("button", { name: "打开 WeMail AI" });
		expect(button).toHaveClass("fixed", "right-4");
		// Design-token surface (not raw white), still opaque and chrome-free.
		expect(button).toHaveClass("bg-paper-2");
		expect(button).not.toHaveClass("bg-transparent");
		expect(button).not.toHaveClass("border");
		expect(button).not.toHaveClass("shadow");
		expect(screen.queryByRole("img")).not.toBeInTheDocument();
	});

	it("opens WeMail AI on click and hides while the panel is open", () => {
		const { rerender } = renderLauncher();

		fireEvent.click(screen.getByRole("button", { name: "打开 WeMail AI" }));
		expect(useUIStore.getState().isAgentPanelOpen).toBe(true);

		rerender(
			<TooltipProvider delayDuration={0}>
				<FloatingAiLauncher />
			</TooltipProvider>,
		);
		expect(
			screen.queryByRole("button", { name: "打开 WeMail AI" }),
		).not.toBeInTheDocument();
	});
});
