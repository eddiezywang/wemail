# Two-State AI Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rework WeMail into the approved "0A visual system + two-state AI layout": list pages use a lightweight floating AI console, message detail pages use a docked right-side AI panel that never covers email text.

**Architecture:** Keep the existing Workbench slot model, but make the agent placement state-aware. The visual system becomes a small set of reusable surface classes/tokens: upstream-like pale sidebar/list/detail backgrounds, a light AI panel, shallow blue summary blocks, and restrained rounded controls.

**Tech Stack:** React Router, React 19, TypeScript, Tailwind utilities, Vitest + Testing Library, existing Zustand `useUIStore`.

## Global Constraints

- The product name stays WeMail and the user-facing AI panel stays visible as WeMail AI.
- List state may use floating AI; detail state must dock AI in its own right column and must not cover message body text.
- 0A visual system is the source of truth: sidebar `#fbf9f9`, main surfaces `#ffffff`, selected row and summary block `#e9f6ff`, AI panel border near `#f1efef`, large but restrained rounded corners.
- Do not add new UI libraries.
- Preserve existing keyboard and command-palette behavior.
- Keep current narrow viewport rule: AI collapses into a drawer instead of covering detail content.
- Prefer changing existing components over replacing workflows.

---

## File Structure

- Modify `app/components/layout/Workbench.tsx`: determine whether the detail column is open, switch agent placement between floating list-state and docked detail-state, and update pane widths/gutters to match 0A.
- Modify `app/components/layout/Workbench.test.tsx`: assert list-state floating agent and detail-state docked agent grid behavior.
- Modify `app/components/AgentSidebar.tsx`: remove heavy brand-bar treatment and expose a light shell that can render in floating or docked placement.
- Modify `app/components/AgentPanel.tsx`: align empty state, suggestions, attached-email chip, and composer to the 0A/upstream reference.
- Modify `app/components/EmailPanel.tsx`: remove card-heavy detail shell and let the email detail feel like a white reading surface.
- Modify `app/components/wemail/EmailIntelligenceCard.tsx`: restyle summary block to upstream-like shallow blue block with large radius and minimal border.
- Modify `app/components/wemail/MailItem.tsx`: tune selected-row treatment to the same `#e9f6ff` selected-row language.
- Modify `app/index.css` if needed for shared tokens/classes such as `.wemail-ai-surface`, `.wemail-summary-block`, `.wemail-soft-panel`.
- Test with `npm exec vitest -- run app/components/layout/Workbench.test.tsx app/components/AgentPanel.test.tsx app/components/EmailPanel.test.tsx app/components/wemail/EmailIntelligenceCard.test.tsx` and `npm run typecheck`.

---

### Task 1: Workbench Two-State Agent Placement

**Files:**
- Modify: `app/components/layout/Workbench.tsx`
- Modify: `app/components/layout/Workbench.test.tsx`

**Interfaces:**
- Consumes: `showDetailColumn`, `agent`, `agentExpanded`
- Produces: `data-agent-placement="floating" | "docked" | "drawer" | "closed"` on `data-testid="workbench"`
- Produces: `data-testid="workbench-agent-floating"` for list-state agent
- Produces: existing `data-testid="workbench-agent"` for detail-state docked agent

- [ ] **Step 1: Add failing tests for two-state placement**

Add tests to `app/components/layout/Workbench.test.tsx`:

```tsx
it("floats the agent over the list state when detail is closed", () => {
	renderWorkbench({
		detail: <div>detail slot</div>,
		agent: <div>agent slot</div>,
		showDetailColumn: false,
	});

	const grid = screen.getByTestId("workbench");
	expect(grid).toHaveAttribute("data-agent-placement", "floating");
	expect(grid).toHaveStyle({
		gridTemplateColumns: "232px 8px minmax(0,1fr)",
	});
	expect(screen.getByTestId("workbench-agent-floating")).toHaveTextContent(
		"agent slot",
	);
	expect(screen.queryByTestId("workbench-agent")).not.toBeInTheDocument();
});

it("docks the agent as a right column when detail is open", () => {
	renderWorkbench({
		detail: <div>detail slot</div>,
		agent: <div>agent slot</div>,
		showDetailColumn: true,
	});

	const grid = screen.getByTestId("workbench");
	expect(grid).toHaveAttribute("data-agent-placement", "docked");
	expect(grid).toHaveStyle({
		gridTemplateColumns:
			"232px 8px 390px 1px minmax(0,1fr) 16px 316px",
	});
	expect(screen.getByTestId("workbench-agent")).toHaveTextContent("agent slot");
	expect(screen.queryByTestId("workbench-agent-floating")).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run tests and verify they fail**

Run:

```bash
npm exec vitest -- run app/components/layout/Workbench.test.tsx
```

Expected: FAIL because `data-agent-placement` and floating agent container do not exist.

- [ ] **Step 3: Implement placement mode and upstream-like column widths**

In `app/components/layout/Workbench.tsx`, introduce:

```ts
const LIST_STATE_AGENT_WIDTH: Record<ResizableMode, number> = {
	wide: 316,
	medium: 316,
};

const DETAIL_STATE_AGENT_WIDTH: Record<ResizableMode, number> = {
	wide: 316,
	medium: 300,
};

const NAV_DETAIL_WIDTH: Record<ResizableMode, number> = {
	wide: 232,
	medium: 220,
};

const DETAIL_GUTTER_WIDTH = 8;
const DETAIL_DIVIDER_WIDTH = 1;
const DETAIL_AGENT_GAP = 16;
```

Compute placement:

```ts
const agentPlacement =
	!agent ? "closed" : isNarrow ? "drawer" : showDetailColumn ? "docked" : "floating";
```

Replace grid calculation for non-narrow states:

```ts
if (!showDetailColumn) {
	return `${sizes.nav}px ${DETAIL_GUTTER_WIDTH}px minmax(0,1fr)`;
}

return showAgentColumn
	? `${sizes.nav}px ${DETAIL_GUTTER_WIDTH}px ${sizes.list}px ${DETAIL_DIVIDER_WIDTH}px minmax(0,1fr) ${DETAIL_AGENT_GAP}px ${sizes.agent}px`
	: `${sizes.nav}px ${DETAIL_GUTTER_WIDTH}px ${sizes.list}px ${DETAIL_DIVIDER_WIDTH}px minmax(0,1fr)`;
```

Add the floating container after the list slot when `agentPlacement === "floating"`:

```tsx
{agentPlacement === "floating" ? (
	<div
		data-testid="workbench-agent-floating"
		className="pointer-events-auto absolute right-5 top-[70px] z-20 h-[calc(100%-88px)] w-[316px]"
	>
		{agent}
	</div>
) : null}
```

Make the root container `relative`, update `data-agent-placement`, and render the docked `workbench-agent` only for `agentPlacement === "docked"`.

- [ ] **Step 4: Run tests and verify they pass**

Run:

```bash
npm exec vitest -- run app/components/layout/Workbench.test.tsx
```

Expected: PASS for the new placement tests and existing layout tests after updating old expected grid strings to the new 0A values.

---

### Task 2: AI Shell Visual System

**Files:**
- Modify: `app/components/AgentSidebar.tsx`
- Modify: `app/components/AgentPanel.tsx`
- Modify: `app/components/AgentPanel.test.tsx`

**Interfaces:**
- Consumes: Workbench placement containers.
- Produces: one visual shell that works in floating and docked modes.
- Produces: `data-testid="wemail-ai-shell"` on the AI shell root.

- [ ] **Step 1: Add shell styling test**

Add to `app/components/AgentPanel.test.tsx` or `app/components/AgentSidebar.test.tsx`:

```tsx
it("renders the AI shell with the approved 0A surface treatment", () => {
	render(<AgentSidebar />);

	const shell = screen.getByTestId("wemail-ai-shell");
	expect(shell).toHaveClass("bg-[#fbf9f9]");
	expect(shell).toHaveClass("border-[#f1efef]");
	expect(shell).toHaveClass("rounded-[24px]");
	expect(screen.getByText("WeMail AI")).toBeInTheDocument();
});
```

- [ ] **Step 2: Run test and verify it fails**

Run:

```bash
npm exec vitest -- run app/components/AgentPanel.test.tsx
```

Expected: FAIL because `wemail-ai-shell` does not exist.

- [ ] **Step 3: Restyle `AgentSidebar` as a light shell**

In `app/components/AgentSidebar.tsx`, wrap the visible panel with:

```tsx
<aside
	data-testid="wemail-ai-shell"
	className="flex h-full min-h-0 flex-col overflow-hidden rounded-[24px] border border-[#f1efef] bg-[#fbf9f9]"
>
	<AgentBrandBar onClose={toggleAgentPanel} />
	<div className="min-h-0 flex-1 overflow-hidden">
		<LazyAgentPanel />
	</div>
</aside>
```

Update `AgentBrandBar`:

```tsx
<div className="flex h-[58px] shrink-0 items-center justify-between px-[22px]">
	<div className="text-[22px] font-bold leading-none text-coral">WeMail AI</div>
	<div className="inline-flex items-center gap-1 rounded-full bg-[#f1efef] px-1 py-1">
		...
	</div>
</div>
```

Keep existing clear/history/expand/close actions, but render them as 25px circular icon buttons inside the pale pill.

- [ ] **Step 4: Restyle `AgentPanel` empty state, suggestions, and composer**

In `AgentPanel.tsx`:

Use empty state:

```tsx
<div className="flex h-full flex-col items-center justify-center text-center">
	<h3 className="text-2xl font-semibold text-ink">Hi {displayName}</h3>
	<p className="mt-1 text-xs text-ink-3">需要帮忙处理邮件吗？</p>
</div>
```

Use suggestion chip:

```tsx
className="self-start max-w-full inline-flex items-center gap-1.5 rounded-full bg-[#f1efef] px-3 py-2 text-sm text-ink hover:bg-[#eceaea] transition-colors"
```

Use composer:

```tsx
<div className="rounded-[22px] border border-[#d8d6d4] bg-white px-3.5 pt-3 pb-2">
```

Set send button to WeMail coral, mic button black/ink in the upstream style.

- [ ] **Step 5: Run tests**

Run:

```bash
npm exec vitest -- run app/components/AgentPanel.test.tsx
```

Expected: PASS after updating snapshots/text assertions if needed.

---

### Task 3: Detail Reading Surface and Summary Block

**Files:**
- Modify: `app/components/EmailPanel.tsx`
- Modify: `app/components/wemail/EmailIntelligenceCard.tsx`
- Modify: `app/components/EmailPanel.test.tsx`
- Modify: `app/components/wemail/EmailIntelligenceCard.test.tsx`

**Interfaces:**
- Consumes: existing `EmailIntelligenceCard` props.
- Produces: summary visual block matching the upstream: shallow blue, large radius, no heavy border.
- Produces: detail panel root as white reading surface instead of heavy card.

- [ ] **Step 1: Add summary styling test**

In `app/components/wemail/EmailIntelligenceCard.test.tsx`, assert:

```tsx
expect(screen.getByLabelText("AI intelligence summary / 智能摘要")).toHaveClass(
	"bg-[#e9f6ff]",
);
expect(screen.getByLabelText("AI intelligence summary / 智能摘要")).toHaveClass(
	"rounded-[22px]",
);
expect(screen.getByLabelText("AI intelligence summary / 智能摘要")).not.toHaveClass(
	"border-coral",
);
```

- [ ] **Step 2: Run test and verify it fails**

Run:

```bash
npm exec vitest -- run app/components/wemail/EmailIntelligenceCard.test.tsx
```

Expected: FAIL because the existing card uses the current coral/error card treatment.

- [ ] **Step 3: Restyle `EmailPanel` root**

In `app/components/EmailPanel.tsx`, change the root from:

```tsx
className="relative flex flex-col h-full bg-paper-2 rounded-xl border border-edge shadow-[var(--shadow-2)] overflow-hidden"
```

to:

```tsx
className="relative flex h-full flex-col overflow-hidden bg-white"
```

The detail column boundary now belongs to `Workbench`, not the email panel itself.

- [ ] **Step 4: Restyle `EmailIntelligenceCard` summary**

In `app/components/wemail/EmailIntelligenceCard.tsx`, make the outer summary block:

```tsx
<section
	aria-label="AI intelligence summary / 智能摘要"
	className="rounded-[22px] bg-[#e9f6ff] px-4 py-3 text-sm text-ink"
>
```

Header:

```tsx
<div className="mb-1.5 flex items-center justify-between text-[#1597ff]">
	<div className="font-bold">摘要</div>
	...
</div>
```

Action chip:

```tsx
className="inline-flex rounded-full bg-[#d8efff] px-3 py-1 text-xs font-semibold text-[#1597ff]"
```

Failure state should stay readable but become a contained pale coral block, not a heavy alert:

```tsx
className="rounded-[18px] bg-coral/10 px-4 py-3 text-sm text-coral"
```

- [ ] **Step 5: Run detail and summary tests**

Run:

```bash
npm exec vitest -- run app/components/EmailPanel.test.tsx app/components/wemail/EmailIntelligenceCard.test.tsx
```

Expected: PASS after updating tests that assert old card borders.

---

### Task 4: List Surface and Selection Treatment

**Files:**
- Modify: `app/routes/_workbench.tsx`
- Modify: `app/components/wemail/MailItem.tsx`
- Modify: `app/routes/_workbench.test.tsx`

**Interfaces:**
- Consumes: existing `MessageListView`.
- Produces: list surface that can host floating AI in list state without visual collision.

- [ ] **Step 1: Add selected-row style test**

In the relevant `MailItem` test or `_workbench.test.tsx`, assert selected row uses the approved shallow blue:

```tsx
expect(screen.getByTestId("mail-item-msg-1")).toHaveClass("bg-[#e9f6ff]");
```

- [ ] **Step 2: Run test and verify it fails**

Run:

```bash
npm exec vitest -- run app/routes/_workbench.test.tsx
```

Expected: FAIL if selected row still uses the older beige/coral treatment.

- [ ] **Step 3: Restyle list root**

In `MessageListView`, change root from card-heavy:

```tsx
className="flex flex-col h-full bg-paper-2 rounded-xl border border-edge shadow-[var(--shadow-2)] overflow-hidden"
```

to:

```tsx
className="flex h-full flex-col overflow-hidden bg-white"
```

Use toolbar `bg-white` and list separators `border-[#d8d8d8]`.

- [ ] **Step 4: Restyle `MailItem` selected state**

In `app/components/wemail/MailItem.tsx`, selected row should use:

```tsx
selected
	? "bg-[#e9f6ff]"
	: "bg-white hover:bg-[#fbf9f9]"
```

Avoid a coral left rail in the upstream-like mode. Keep star and attachment icons.

- [ ] **Step 5: Run list tests**

Run:

```bash
npm exec vitest -- run app/routes/_workbench.test.tsx
```

Expected: PASS.

---

### Task 5: Integration Verification

**Files:**
- No source files unless earlier tests reveal gaps.

**Interfaces:**
- Verifies the approved behavior end to end.

- [ ] **Step 1: Run focused component tests**

Run:

```bash
npm exec vitest -- run app/components/layout/Workbench.test.tsx app/components/AgentPanel.test.tsx app/components/EmailPanel.test.tsx app/components/wemail/EmailIntelligenceCard.test.tsx app/routes/_workbench.test.tsx
```

Expected: PASS.

- [ ] **Step 2: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 3: Run the desktop app**

Run:

```bash
npm run dev:desktop
```

Expected: Electron opens WeMail. In list state, AI appears as a floating 0A-styled console. In detail state, AI docks at the right and does not cover email text.

- [ ] **Step 4: Visual QA checklist**

Check manually:

- [ ] List-state AI floats over non-essential list area and uses the same panel style as detail-state AI.
- [ ] Detail-state AI is docked and never overlaps the body text, summary block, attachments, or reply/forward buttons.
- [ ] Summary card is shallow blue, large-radius, and not bordered like an alert.
- [ ] Sidebar, list, detail, and AI use restrained 0A color blocks.
- [ ] Narrow viewport opens AI as a drawer, not as an overlay over the message body.

---

## Self-Review

- Spec coverage: covers two-state AI layout, 0A visual system, non-overlap rule, summary card, list selection, and narrow drawer behavior.
- Placeholder scan: no unfinished placeholder markers remain.
- Type consistency: all new test ids and data attributes are defined in the producing tasks before being used in verification.
