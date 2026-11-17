# Workbench Resizable Panels Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Workbench's hand-written docked column resizing with `react-resizable-panels` so drag behavior is stable and persisted after completed user resizes.

**Architecture:** Keep Workbench's viewport-mode, modal, and agent-placement state in `Workbench.tsx`. Use `react-resizable-panels` only for non-narrow docked layouts, preserving the existing CSS-grid path for narrow and floating-agent modes. Persist pixel widths from the library's `onLayoutChanged` callback so storage is updated after drag completion instead of every pointer move.

**Tech Stack:** React 19, TypeScript, Vite/Vitest, `react-resizable-panels@4.12.1`.

## Global Constraints

- Work in `<repo-root>\.worktrees\workbench-resizable-panels` on branch `feat/workbench-resizable-panels`.
- Package manager is Bun; update `package.json` and `bun.lock`.
- Use `react-resizable-panels` exports: `Group`, `Panel`, `Separator`, and `Layout`.
- Preserve existing Workbench narrow drawer and floating-agent behavior.
- Preserve test ids: `workbench`, `workbench-nav`, `workbench-list`, `workbench-detail`, `workbench-agent`, `workbench-nav-resizer`, `workbench-list-resizer`, `workbench-agent-resizer`.
- Use focused verification first: `vitest run app/components/layout/Workbench.test.tsx`.
- Use TypeScript verification: `tsc -p tsconfig.json --noEmit --pretty false`.

---

### Task 1: Add Split Pane Dependency

**Files:**
- Modify: `package.json`
- Modify: `bun.lock`

**Interfaces:**
- Consumes: existing package manager setup in `bunfig.toml`.
- Produces: `react-resizable-panels@4.12.1` available to `Workbench.tsx`.

- [ ] **Step 1: Add dependency**

Run:

```powershell
bun add react-resizable-panels@4.12.1
```

Expected: `package.json` gains `"react-resizable-panels": "^4.12.1"` or exact equivalent, and `bun.lock` updates.

- [ ] **Step 2: If install is blocked by Electron/native dependency cleanup**

Run this lockfile-only fallback only if Step 1 cannot complete in the worktree:

```powershell
bun add react-resizable-panels@4.12.1 --lockfile-only
```

Expected: `package.json` and `bun.lock` update without requiring a full `node_modules` install.

- [ ] **Step 3: Verify package metadata**

Run:

```powershell
npm view react-resizable-panels@4.12.1 version peerDependencies license
```

Expected: version is `4.12.1`, peer dependencies allow React 19, license is `MIT`.

- [ ] **Step 4: Commit dependency**

Run:

```powershell
git add package.json bun.lock
git commit -m "chore: add resizable panels dependency"
```

### Task 2: Replace Docked Workbench Splitters With Regression Tests

**Files:**
- Modify: `app/components/layout/Workbench.test.tsx`
- Modify: `app/components/layout/Workbench.tsx`

**Interfaces:**
- Consumes: current `Workbench` props and `wemail.workbenchPaneSizes` localStorage key.
- Produces: docked non-narrow Workbench layout backed by library resize lifecycle, with tests proving user-completed layout changes persist and non-user layout changes do not.

- [ ] **Step 1: Write failing import and mocks**

Add this mock near the top of `Workbench.test.tsx`, after imports:

```tsx
vi.mock("react-resizable-panels", async () => {
	const React = await import("react");
	const callbacks: Array<(layout: Record<string, number>, meta: { isUserInteraction: boolean }) => void> = [];
	return {
		Group: ({ children, onLayoutChanged, ...props }: any) => {
			if (onLayoutChanged) callbacks.push(onLayoutChanged);
			return (
				<div data-testid={props["data-testid"] ?? props.id ?? "mock-panel-group"}>
					{children}
				</div>
			);
		},
		Panel: ({ children, id, defaultSize, minSize, maxSize, ...props }: any) => (
			<div
				data-testid={props["data-testid"] ?? id}
				data-default-size={String(defaultSize)}
				data-min-size={String(minSize)}
				data-max-size={String(maxSize)}
			>
				{children}
			</div>
		),
		Separator: ({ children, id, ...props }: any) => (
			<div data-testid={props["data-testid"] ?? id} role="separator">
				{children}
			</div>
		),
		__triggerLayoutChanged: (layout: Record<string, number>, meta = { isUserInteraction: true }) => {
			for (const cb of callbacks) cb(layout, meta);
		},
		__clearLayoutCallbacks: () => {
			callbacks.length = 0;
		},
	};
});
```

Update the Vitest import to include `vi`:

```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
```

- [ ] **Step 2: Add persistence test**

Add this test in the `describe("Workbench")` block:

```tsx
it("persists docked pane sizes after a completed library layout change", async () => {
	const panels = await import("react-resizable-panels");
	renderAt("wide");

	(panels as any).__triggerLayoutChanged({
		"workbench-nav-panel": 250,
		"workbench-list-panel": 430,
		"workbench-detail-panel": 800,
		"workbench-agent-panel": 520,
	});

	expect(JSON.parse(window.localStorage.getItem("wemail.workbenchPaneSizes") ?? "{}")).toMatchObject({
		wide: { nav: 250, list: 430, agent: 520 },
	});
});
```

- [ ] **Step 3: Add non-user layout test**

Add this test:

```tsx
it("does not persist non-user library layout changes", async () => {
	const panels = await import("react-resizable-panels");
	renderAt("wide");

	(panels as any).__triggerLayoutChanged(
		{
			"workbench-nav-panel": 250,
			"workbench-list-panel": 430,
			"workbench-detail-panel": 800,
			"workbench-agent-panel": 520,
		},
		{ isUserInteraction: false },
	);

	expect(window.localStorage.getItem("wemail.workbenchPaneSizes")).toBeNull();
});
```

- [ ] **Step 4: Run tests and verify failure**

Run:

```powershell
$env:PATH="<repo-root>\node_modules\.bin;$env:PATH"
vitest run app\components\layout\Workbench.test.tsx
```

- Expected: new tests fail because `Workbench` has not imported `react-resizable-panels` or wired `onLayoutChanged`.

- [ ] **Step 5: Import library types and components**

Add:

```tsx
import {
	Group,
	type Layout,
	Panel,
	Separator,
} from "react-resizable-panels";
```

- [ ] **Step 6: Remove hand-written drag state**

Delete the `dragStateRef` declaration, the `activeResizer` state declaration, the `startResize` callback, and the effect that registers `window.addEventListener("pointermove", onPointerMove)`, `window.addEventListener("pointerup", stopDrag)`, and `window.addEventListener("pointercancel", stopDrag)`.

Replace active separator styling calls with inactive styling calls:

```tsx
<div className={separatorLineClass(false)} />
<div className={quietSeparatorLineClass(false)} />
```

- [ ] **Step 7: Add panel id constants**

Add near size constants:

```tsx
const PANEL_IDS = {
	nav: "workbench-nav-panel",
	list: "workbench-list-panel",
	detail: "workbench-detail-panel",
	agent: "workbench-agent-panel",
} as const;
```

- [ ] **Step 8: Add layout persistence helper**

Add inside `Workbench`, after `persistPaneSize`:

```tsx
const persistDockedLayout = useCallback(
	(layout: Layout, meta?: { isUserInteraction?: boolean }) => {
		if (!resizableMode || meta?.isUserInteraction === false) return;
		const nav = layout[PANEL_IDS.nav];
		const list = layout[PANEL_IDS.list];
		const agentSize = layout[PANEL_IDS.agent];
		const next: Partial<PaneSizeState> = {};
		if (typeof nav === "number") {
			next.nav = clamp(nav, MIN_NAV_WIDTH[resizableMode], MAX_NAV_WIDTH[resizableMode]);
		}
		if (typeof list === "number") {
			next.list = clamp(list, MIN_LIST_WIDTH[resizableMode], MAX_LIST_WIDTH[resizableMode]);
		}
		if (typeof agentSize === "number") {
			next.agent = clamp(agentSize, MIN_AGENT_WIDTH[resizableMode], MAX_AGENT_WIDTH[resizableMode]);
		}
		if (Object.keys(next).length > 0) {
			persistPaneSize(resizableMode, next);
		}
	},
	[persistPaneSize, resizableMode],
);
```

- [ ] **Step 9: Render library docked layout**

For `!isNarrow && showDetailColumn`, replace the grid children with:

```tsx
<Group
	id={`workbench-${resizableMode}-group`}
	data-testid="workbench-panel-group"
	orientation="horizontal"
	className="relative flex-1 min-h-0 w-full bg-white"
	onLayoutChanged={persistDockedLayout}
	resizeTargetMinimumSize={{ coarse: 37, fine: 12 }}
>
	<Panel
		id={PANEL_IDS.nav}
		data-testid="workbench-nav"
		defaultSize={sizes.nav}
		minSize={MIN_NAV_WIDTH[currentMode]}
		maxSize={MAX_NAV_WIDTH[currentMode]}
		groupResizeBehavior="preserve-pixel-size"
		className="min-w-0 min-h-0 h-full bg-[#fbf9f9]"
	>
		{nav}
	</Panel>
	<Separator data-testid="workbench-nav-resizer" className={wideSeparatorClass}>
		<div className={separatorLineClass(false)} />
	</Separator>
	<Panel
		id={PANEL_IDS.list}
		data-testid="workbench-list"
		defaultSize={sizes.list}
		minSize={MIN_LIST_WIDTH[currentMode]}
		maxSize={MAX_LIST_WIDTH[currentMode]}
		groupResizeBehavior="preserve-pixel-size"
		className="min-w-0 min-h-0 h-full bg-white"
	>
		{list}
	</Panel>
	<Separator data-testid="workbench-list-resizer" className={dividerSeparatorClass}>
		<div className={separatorLineClass(false)} />
	</Separator>
	<Panel
		id={PANEL_IDS.detail}
		data-testid="workbench-detail"
		minSize={240}
		groupResizeBehavior="preserve-relative-size"
		className="min-w-0 min-h-0 h-full bg-white"
	>
		{detail}
	</Panel>
	{showAgentColumn ? (
		<>
			<Separator data-testid="workbench-agent-resizer" className={wideSeparatorClass}>
				<div className={quietSeparatorLineClass(false)} />
			</Separator>
			<Panel
				id={PANEL_IDS.agent}
				data-testid="workbench-agent"
				defaultSize={sizes.agent}
				minSize={MIN_AGENT_WIDTH[currentMode]}
				maxSize={MAX_AGENT_WIDTH[currentMode]}
				groupResizeBehavior="preserve-pixel-size"
				className="min-w-0 min-h-0 h-full pt-[66px] pb-3 pr-3 motion-safe:animate-[slide-in-right_180ms_ease-out]"
			>
				{agent}
			</Panel>
		</>
	) : null}
</Group>
```

Preserve the existing CSS-grid render path for narrow layouts and for `showDetailColumn=false`.

- [ ] **Step 10: Run tests and verify pass**

Run:

```powershell
$env:PATH="<repo-root>\node_modules\.bin;$env:PATH"
vitest run app\components\layout\Workbench.test.tsx
```

Expected: all Workbench tests pass.

- [ ] **Step 11: Run TypeScript**

Run:

```powershell
$env:PATH="<repo-root>\node_modules\.bin;$env:PATH"
tsc -p tsconfig.json --noEmit --pretty false
```

Expected: no TypeScript errors.

- [ ] **Step 12: Commit tests and implementation**

Run:

```powershell
git add app/components/layout/Workbench.tsx app/components/layout/Workbench.test.tsx
git commit -m "fix: use resizable panels for workbench splitters"
```

### Task 3: Manual Runtime Verification

**Files:**
- No source files expected.

**Interfaces:**
- Consumes: completed implementation from Tasks 1-3.
- Produces: manual verification notes for the PR/summary.

- [ ] **Step 1: Start renderer**

Run from the worktree:

```powershell
$env:PATH="<repo-root>\node_modules\.bin;$env:PATH"
react-router dev --port 5174 --strictPort
```

Expected: renderer listens on `http://localhost:5174/`.

- [ ] **Step 2: Start Electron against worktree build output**

Run from the worktree in a second shell after `npm run build:desktop` succeeds:

```powershell
$env:VITE_DEV_SERVER_URL="http://localhost:5174"
<repo-root>\node_modules\.bin\electron.exe --no-sandbox dist-electron/electron/main/app.js
```

Expected: WeMail window opens and loads the worktree renderer.

- [ ] **Step 3: Verify drag behavior**

Manual checks:

- Drag the AI separator left and right repeatedly over the email body area.
- Release the pointer while over the email body and while over the AI panel.
- Move the mouse after release.
- Expected: resizing continues smoothly until configured min/max constraints and always stops after release.

- [ ] **Step 4: Run final checks**

Run:

```powershell
$env:PATH="<repo-root>\node_modules\.bin;$env:PATH"
vitest run app\components\layout\Workbench.test.tsx
tsc -p tsconfig.json --noEmit --pretty false
```

Expected: both commands exit `0`.

- [ ] **Step 5: Commit verification note only if files changed**

If no files changed, do not commit. If a docs note is added, run:

```powershell
git add docs/superpowers/plans/2026-07-07-workbench-resizable-panels.md
git commit -m "docs: record workbench resize verification"
```
