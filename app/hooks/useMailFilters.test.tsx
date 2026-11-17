import { act, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation, useNavigate } from "react-router";
import { useUIStore } from "./useUIStore";
import { useMailFilters } from "./useMailFilters";

function FilterScopeProbe() {
	const navigate = useNavigate();
	const location = useLocation();
	const filters = useMailFilters();

	return (
		<div>
			<span data-testid="pathname">{location.pathname}</span>
			<span data-testid="has-attachment">
				{filters.hasAttachment ? "on" : "off"}
			</span>
			<button type="button" onClick={() => navigate("/folder/all-mail")}>
				切换到所有邮件
			</button>
		</div>
	);
}

describe("useMailFilters", () => {
	beforeEach(() => {
		useUIStore.setState({
			mailFilters: {
				unread: false,
				toMe: false,
				ccMe: false,
				hasAttachment: true,
				olderThan: null,
			},
			mailFilterScope: "/inbox",
		});
	});

	it("clears filters when navigating to a different mail directory", async () => {
		render(
			<MemoryRouter initialEntries={["/inbox"]}>
				<FilterScopeProbe />
			</MemoryRouter>,
		);

		expect(screen.getByTestId("has-attachment")).toHaveTextContent("on");

		act(() => {
			screen.getByRole("button", { name: "切换到所有邮件" }).click();
		});

		await waitFor(() => {
			expect(screen.getByTestId("pathname")).toHaveTextContent(
				"/folder/all-mail",
			);
			expect(screen.getByTestId("has-attachment")).toHaveTextContent("off");
			expect(useUIStore.getState().mailFilterScope).toBe("/folder/all-mail");
			expect(useUIStore.getState().mailFilters.hasAttachment).toBe(false);
		});

		act(() => {
			useUIStore.getState().setMailFilter("hasAttachment", true);
		});

		await waitFor(() => {
			expect(screen.getByTestId("has-attachment")).toHaveTextContent("on");
		});
	});
});
