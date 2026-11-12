// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Workbench, useActiveModal, useWorkbenchNavigation } from "./Workbench";

function renderAt(
	mode: "wide" | "medium" | "narrow",
	agent: React.ReactNode = <div>agent slot</div>,
	nav: React.ReactNode = <div>nav slot</div>,
) {
	return render(
		<Workbench
			initialViewportMode={mode}
			nav={nav}
			list={<div>list slot</div>}
			detail={<div>detail slot</div>}
			agent={agent}
		/>,
	);
}

function NavigationToggleProbe() {
	const navigation = useWorkbenchNavigation();
	return (
		<button type="button" onClick={navigation.toggle}>
			{navigation.collapsed ? "展开导航栏" : "收起导航栏"}
		</button>
	);
}

describe("Workbench", () => {
	beforeEach(() => {
		window.localStorage.clear();
	});

	afterEach(() => {
		window.localStorage.clear();
	});

	it("renders all four slots at wide viewport", () => {
		renderAt("wide");
		expect(screen.getByText("nav slot")).toBeInTheDocument();
		expect(screen.getByText("list slot")).toBeInTheDocument();
		expect(screen.getByText("detail slot")).toBeInTheDocument();
		expect(screen.getByText("agent slot")).toBeInTheDocument();
		expect(screen.getByTestId("workbench-main-surface")).toHaveStyle({
			left: "181px",
		});
	});

	it("keeps the message list mounted when opening the detail column", () => {
		let mounts = 0;
		function StatefulList() {
			useEffect(() => {
				mounts += 1;
			}, []);
			return <div>stateful list</div>;
		}
		const { rerender } = render(
			<Workbench
				initialViewportMode="wide"
				nav={<div>nav slot</div>}
				list={<StatefulList />}
				detail={<div>detail slot</div>}
				showDetailColumn={false}
			/>,
		);

		rerender(
			<Workbench
				initialViewportMode="wide"
				nav={<div>nav slot</div>}
				list={<StatefulList />}
				detail={<div>detail slot</div>}
				showDetailColumn
			/>,
		);

		expect(screen.getByText("stateful list")).toBeInTheDocument();
		expect(mounts).toBe(1);
		expect(screen.getByTestId("workbench")).toHaveClass("transition-none");
	});

	it("uses the 0A docked agent grid on wide viewport", () => {
		renderAt("wide");
		const grid = screen.getByTestId("workbench");
		expect(grid).toHaveAttribute("data-mode", "wide");
		expect(grid).toHaveAttribute("data-agent-placement", "docked");
		expect(grid).toHaveStyle({
			gridTemplateColumns: "180px 1px 340px 1px minmax(0,1fr) 16px 360px",
		});
		expect(screen.getByTestId("workbench-agent")).toBeInTheDocument();
		expect(screen.getByTestId("workbench-list-resizer")).toHaveAttribute("aria-valuemin", "260");
		expect(screen.getByTestId("workbench-agent-resizer")).toHaveAttribute("aria-valuemin", "240");
	});

	it("uses the 0A docked agent grid on medium viewport", () => {
		renderAt("medium");
		const grid = screen.getByTestId("workbench");
		expect(grid).toHaveAttribute("data-mode", "medium");
		expect(grid).toHaveAttribute("data-agent-placement", "docked");
		expect(grid).toHaveStyle({
			gridTemplateColumns: "180px 1px 300px 1px minmax(0,1fr) 16px 340px",
		});
		expect(screen.getByTestId("workbench-agent")).toBeInTheDocument();
	});

	it("collapses navigation to an icon rail and restores the expanded width", () => {
		renderAt("wide", <div>agent slot</div>, <NavigationToggleProbe />);
		const toggle = screen.getByRole("button", { name: "收起导航栏" });

		fireEvent.click(toggle);
		expect(screen.getByTestId("workbench")).toHaveAttribute("data-nav-collapsed", "true");
		expect(screen.getByTestId("workbench")).toHaveStyle({
			gridTemplateColumns: "56px 1px 340px 1px minmax(0,1fr) 16px 360px",
		});
		expect(window.localStorage.getItem("wemail.workbenchNavCollapsed.v1")).toBe("true");
		expect(screen.getByTestId("workbench-main-surface")).toHaveStyle({
			left: "57px",
		});

		fireEvent.click(screen.getByRole("button", { name: "展开导航栏" }));
		expect(screen.getByTestId("workbench")).toHaveAttribute("data-nav-collapsed", "false");
		expect(screen.getByTestId("workbench")).toHaveStyle({
			gridTemplateColumns: "180px 1px 340px 1px minmax(0,1fr) 16px 360px",
		});
		expect(window.localStorage.getItem("wemail.workbenchNavCollapsed.v1")).toBe("false");
	});

	it("hydrates the persisted navigation collapse state independently of pane widths", () => {
		window.localStorage.setItem("wemail.workbenchNavCollapsed.v1", "true");
		window.localStorage.setItem(
			"wemail.workbenchPaneSizes.v2",
			JSON.stringify({ wide: { nav: 196, list: 410, agent: 330 } }),
		);

		renderAt("wide", <div>agent slot</div>, <NavigationToggleProbe />);
		// The agent column always hydrates from the mode preset; only nav and
		// list widths hydrate from persisted storage.
		expect(screen.getByTestId("workbench")).toHaveStyle({
			gridTemplateColumns: "56px 1px 410px 1px minmax(0,1fr) 16px 360px",
		});

		fireEvent.click(screen.getByRole("button", { name: "展开导航栏" }));
		expect(screen.getByTestId("workbench")).toHaveStyle({
			gridTemplateColumns: "196px 1px 410px 1px minmax(0,1fr) 16px 360px",
		});
	});

	it("collapses agent into a drawer at narrow viewport", () => {
		renderAt("narrow");
		const grid = screen.getByTestId("workbench");
		expect(grid).toHaveAttribute("data-mode", "narrow");
		expect(grid).toHaveAttribute("data-drawer", "true");
		expect(grid).toHaveAttribute("data-agent-placement", "drawer");
		expect(grid).toHaveStyle({
			gridTemplateColumns: "156px 320px minmax(0,1fr)",
		});
		expect(screen.queryByTestId("workbench-agent")).not.toBeInTheDocument();
		expect(screen.queryByTestId("workbench-agent-drawer")).not.toBeInTheDocument();
	});

	it("renders all three primary slots even when agent is omitted", () => {
		render(
			<Workbench
				initialViewportMode="wide"
				nav={<div>n</div>}
				list={<div>l</div>}
				detail={<div>d</div>}
			/>,
		);
		expect(screen.queryByTestId("workbench-agent")).not.toBeInTheDocument();
	});

	it("drops the detail column when showDetailColumn is false", () => {
		render(
			<Workbench
				initialViewportMode="wide"
				nav={<div>nav slot</div>}
				list={<div>list slot</div>}
				detail={<div>detail slot</div>}
				agent={<div>agent slot</div>}
				showDetailColumn={false}
			/>,
		);
		const grid = screen.getByTestId("workbench");
		expect(grid).toHaveAttribute("data-detail", "closed");
		expect(grid).toHaveAttribute("data-agent-placement", "floating");
		expect(grid).toHaveStyle({
			gridTemplateColumns: "180px 1px minmax(0,1fr) 16px 360px",
		});
		expect(screen.getByTestId("workbench-detail")).toHaveClass("hidden");
		expect(screen.queryByTestId("workbench-agent")).not.toBeInTheDocument();
		expect(screen.getByTestId("workbench-agent-floating")).toBeInTheDocument();
		expect(screen.getByText("list slot")).toBeInTheDocument();
		expect(screen.getByText("agent slot")).toBeInTheDocument();
	});

	it("drops both detail and agent when showDetailColumn=false and no agent", () => {
		render(
			<Workbench
				initialViewportMode="wide"
				nav={<div>n</div>}
				list={<div>l</div>}
				detail={<div>d</div>}
				agent={null}
				showDetailColumn={false}
			/>,
		);
		const grid = screen.getByTestId("workbench");
		expect(grid).toHaveAttribute("data-detail", "closed");
		expect(grid).toHaveAttribute("data-agent", "closed");
		expect(grid).toHaveAttribute("data-agent-placement", "closed");
		expect(grid).toHaveStyle({
			gridTemplateColumns: "180px 1px minmax(0,1fr)",
		});
		expect(screen.getByTestId("workbench-detail")).toHaveClass("hidden");
	});

	it("does not remount the agent when the detail column is toggled", () => {
		let mounts = 0;
		function AgentProbe() {
			useEffect(() => {
				mounts += 1;
			}, []);
			return <div>agent slot</div>;
		}

		const { rerender } = render(
			<Workbench
				initialViewportMode="wide"
				nav={<div>n</div>}
				list={<div>l</div>}
				detail={<div>d</div>}
				agent={<AgentProbe />}
				showDetailColumn={false}
			/>,
		);
		expect(mounts).toBe(1);

		rerender(
			<Workbench
				initialViewportMode="wide"
				nav={<div>n</div>}
				list={<div>l</div>}
				detail={<div>d</div>}
				agent={<AgentProbe />}
				showDetailColumn
			/>,
		);

		expect(mounts).toBe(1);
	});

	it("drops the 4th column when agent is null", () => {
		render(
			<Workbench
				initialViewportMode="wide"
				nav={<div>n</div>}
				list={<div>l</div>}
				detail={<div>d</div>}
				agent={null}
			/>,
		);
		const grid = screen.getByTestId("workbench");
		expect(grid).toHaveAttribute("data-agent", "closed");
		expect(grid).toHaveAttribute("data-agent-placement", "closed");
		expect(grid).toHaveStyle({
			gridTemplateColumns: "180px 1px 340px 1px minmax(0,1fr)",
		});
		expect(screen.queryByTestId("workbench-agent")).not.toBeInTheDocument();
	});

	it("reinitializes the grid from shared widths when the agent toggles", () => {
		const { rerender } = render(
			<Workbench
				initialViewportMode="wide"
				nav={<div>n</div>}
				list={<div>l</div>}
				detail={<div>d</div>}
				agent={null}
			/>,
		);

		expect(screen.getByTestId("workbench")).toHaveStyle({
			gridTemplateColumns: "180px 1px 340px 1px minmax(0,1fr)",
		});

		rerender(
			<Workbench
				initialViewportMode="wide"
				nav={<div>n</div>}
				list={<div>l</div>}
				detail={<div>d</div>}
				agent={<div>agent slot</div>}
			/>,
		);

		expect(screen.getByTestId("workbench")).toHaveStyle({
			gridTemplateColumns: "180px 1px 340px 1px minmax(0,1fr) 16px 360px",
		});
	});

	it("renders draggable splitters on non-narrow layouts", () => {
		renderAt("wide");
		const navResizer = screen.getByTestId("workbench-nav-resizer");
		const agentResizer = screen.getByTestId("workbench-agent-resizer");
		expect(navResizer).toBeInTheDocument();
		expect(navResizer).toHaveClass("bg-transparent");
		expect(screen.getByTestId("workbench-list-resizer")).toBeInTheDocument();
		expect(agentResizer).toBeInTheDocument();
		expect(navResizer.firstElementChild).toHaveClass("right-0");
		expect(navResizer.firstElementChild).toHaveClass("bg-transparent");
		expect(navResizer.firstElementChild).not.toHaveClass("left-1/2");
		expect(agentResizer.firstElementChild).toHaveClass("right-0");
		expect(agentResizer.firstElementChild).not.toHaveClass("left-1/2");
	});

	it("renders the agent splitter while the agent is floating over the list", () => {
		render(
			<Workbench
				initialViewportMode="wide"
				nav={<div>n</div>}
				list={<div>l</div>}
				detail={<div>d</div>}
				agent={<div>agent slot</div>}
				showDetailColumn={false}
			/>,
		);
		expect(screen.getByTestId("workbench-agent-floating")).toBeInTheDocument();
		const agentResizer = screen.getByTestId("workbench-agent-resizer");
		expect(agentResizer).toBeInTheDocument();
		expect(agentResizer).toHaveClass("left-0");
		expect(agentResizer).not.toHaveClass("-left-4");
		expect(agentResizer.firstElementChild).toHaveClass("right-0");
		expect(agentResizer.firstElementChild).toHaveClass("-translate-x-4");
	});

	it("resizes the floating agent width from its left edge for the session", () => {
		render(
			<Workbench
				initialViewportMode="wide"
				nav={<div>n</div>}
				list={<div>l</div>}
				detail={<div>d</div>}
				agent={<div>agent slot</div>}
				showDetailColumn={false}
			/>,
		);

		fireEvent.pointerDown(screen.getByTestId("workbench-agent-resizer"), {
			clientX: 600,
		});
		fireEvent.pointerMove(window, { clientX: 540 });
		fireEvent.pointerUp(window);

		expect(screen.getByTestId("workbench")).toHaveStyle({
			gridTemplateColumns: "180px 1px minmax(0,1fr) 16px 420px",
		});
		expect(screen.getByTestId("workbench-agent-floating")).toHaveStyle({
			width: "420px",
		});
		// Agent drags are a session-level override, not a persisted pane size.
		expect(window.localStorage.getItem("wemail.workbenchPaneSizes.v2")).toBeNull();
	});

	it("preserves nav resizing on the floating-agent fallback layout", () => {
		render(
			<Workbench
				initialViewportMode="wide"
				nav={<div>n</div>}
				list={<div>l</div>}
				detail={<div>d</div>}
				agent={<div>agent slot</div>}
				showDetailColumn={false}
			/>,
		);

		fireEvent.pointerDown(screen.getByTestId("workbench-nav-resizer"), {
			clientX: 100,
		});
		fireEvent.pointerMove(window, { clientX: 160 });
		fireEvent.pointerUp(window);

		expect(screen.getByTestId("workbench")).toHaveStyle({
			gridTemplateColumns: "208px 1px minmax(0,1fr) 16px 360px",
		});
		expect(
			JSON.parse(window.localStorage.getItem("wemail.workbenchPaneSizes.v2") ?? "{}"),
		).toMatchObject({
			wide: { nav: 208 },
		});
	});

	it("resizes and persists navigation width while the detail column is open", () => {
		renderAt("wide");

		fireEvent.pointerDown(screen.getByTestId("workbench-nav-resizer"), {
			clientX: 168,
		});
		fireEvent.pointerMove(window, { clientX: 208 });
		fireEvent.pointerUp(window);

		expect(screen.getByTestId("workbench")).toHaveStyle({
			gridTemplateColumns: "208px 1px 340px 1px minmax(0,1fr) 16px 360px",
		});
		expect(
			JSON.parse(window.localStorage.getItem("wemail.workbenchPaneSizes.v2") ?? "{}"),
		).toMatchObject({
			wide: { nav: 208 },
		});
	});

	it("hydrates persisted pane widths from localStorage", () => {
		window.localStorage.setItem(
			"wemail.workbenchPaneSizes.v2",
			JSON.stringify({
				wide: { nav: 196, list: 444, agent: 500 },
			}),
		);
		renderAt("wide");
		expect(screen.getByTestId("workbench")).toHaveStyle({
			gridTemplateColumns: "196px 1px 444px 1px minmax(0,1fr) 16px 360px",
		});
	});

	it("migrates legacy widths while resetting only the oversized sidebar", () => {
		window.localStorage.setItem(
			"wemail.workbenchPaneSizes",
			JSON.stringify({
				wide: { nav: 320, list: 444, agent: 500 },
			}),
		);
		renderAt("wide");

		expect(screen.getByTestId("workbench")).toHaveStyle({
			gridTemplateColumns: "180px 1px 444px 1px minmax(0,1fr) 16px 360px",
		});
		expect(
			JSON.parse(window.localStorage.getItem("wemail.workbenchPaneSizes.v2") ?? "{}"),
		).toMatchObject({
			wide: { list: 444, agent: 500 },
		});
	});

	it("persists the docked list pane size after a completed resize drag", () => {
		renderAt("wide");

		fireEvent.pointerDown(screen.getByTestId("workbench-list-resizer"), {
			clientX: 340,
		});
		fireEvent.pointerMove(window, { clientX: 480 });
		fireEvent.pointerUp(window);

		expect(screen.getByTestId("workbench")).toHaveStyle({
			gridTemplateColumns: "180px 1px 480px 1px minmax(0,1fr) 16px 360px",
		});
		expect(
			JSON.parse(window.localStorage.getItem("wemail.workbenchPaneSizes.v2") ?? "{}"),
		).toMatchObject({
			wide: { list: 480 },
		});
	});
});

describe("useActiveModal", () => {
	it("starts with no active modal", () => {
		const probe = { current: null as ReturnType<typeof useActiveModal> | null };
		function Probe() {
			probe.current = useActiveModal();
			return null;
		}
		render(
			<Workbench
				initialViewportMode="wide"
				nav={<Probe />}
				list={null}
				detail={null}
			/>,
		);
		expect(probe.current?.active).toBeNull();
	});

	it("enforces single-modal: opening agent then compose flips active", () => {
		const probe = { current: null as ReturnType<typeof useActiveModal> | null };
		function Probe() {
			probe.current = useActiveModal();
			return null;
		}
		render(
			<Workbench
				initialViewportMode="wide"
				nav={<Probe />}
				list={null}
				detail={null}
			/>,
		);
		act(() => probe.current!.open("agent"));
		expect(probe.current?.active).toBe("agent");
		act(() => probe.current!.open("compose"));
		expect(probe.current?.active).toBe("compose");
		act(() => probe.current!.open("agent"));
		expect(probe.current?.active).toBe("agent");
		act(() => probe.current!.close());
		expect(probe.current?.active).toBeNull();
	});

	it("throws when called outside Workbench", () => {
		expect(() => renderHook(() => useActiveModal())).toThrow(
			/useActiveModal must be used inside <Workbench>/,
		);
	});
});
