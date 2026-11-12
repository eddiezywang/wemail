# WeMail AI Entry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace repeated WeMail branding in AI surfaces with a fixed, borderless `SparkleIcon` entry and consistently label the feature “WeMail AI”.

**Architecture:** Keep the existing UI-store toggle and AgentSidebar lifecycle. Simplify `FloatingAiLauncher` into a stateless fixed button, then replace Logo-based presentational marks in titlebar and agent surfaces without changing conversation or panel behavior.

**Tech Stack:** React, TypeScript, Tailwind CSS, Phosphor Icons, Zustand, Vitest, Testing Library

## Global Constraints

- The user-facing feature name is exactly `WeMail AI`.
- The closed entry is fixed at the workbench top-right and is not draggable.
- The closed entry has no visible border, background, shadow, or Logo until hover/focus feedback.
- Use the existing `SparkleIcon`; add no dependency and no new image asset.
- Preserve the existing panel open/close store behavior.

---

### Task 1: Fixed WeMail AI Entry

**Files:**
- Create: `app/components/FloatingAiLauncher.test.tsx`
- Modify: `app/components/FloatingAiLauncher.tsx`

**Interfaces:**
- Consumes: `useUIStore(): { isAgentPanelOpen: boolean; toggleAgentPanel(): void }`
- Produces: `FloatingAiLauncher` with `data-testid="floating-ai-launcher"` and accessible name `打开 WeMail AI`

- [ ] **Step 1: Write the failing launcher tests**

```tsx
it("renders a fixed Sparkle entry without the brand image or drag handlers", () => {
  const { getByRole, queryByRole } = render(<FloatingAiLauncher />);
  const button = getByRole("button", { name: "打开 WeMail AI" });
  expect(button).toHaveClass("fixed", "right-4");
  expect(button).not.toHaveClass("border");
  expect(queryByRole("img")).not.toBeInTheDocument();
});

it("opens WeMail AI on click and hides while the panel is open", () => {
  const { getByRole, rerender, queryByRole } = render(<FloatingAiLauncher />);
  fireEvent.click(getByRole("button", { name: "打开 WeMail AI" }));
  expect(useUIStore.getState().isAgentPanelOpen).toBe(true);
  rerender(<FloatingAiLauncher />);
  expect(queryByRole("button", { name: "打开 WeMail AI" })).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run the tests and confirm they fail because the current launcher uses the Logo, draggable position state, and the old accessible name**

Run: `npm exec vitest -- run app/components/FloatingAiLauncher.test.tsx`

Expected: FAIL because `打开 WeMail AI` does not exist and the current launcher renders an image.

- [ ] **Step 3: Implement the fixed Sparkle launcher**

Replace drag refs, position effects, portal positioning, image markup, border and shadow styling with a fixed `right-4 top-[46px]` 36×36 button containing:

```tsx
<SparkleIcon size={20} weight="fill" />
```

Use `aria-label="打开 WeMail AI"`, a matching title, transparent default styling, neutral hover background, and focus-visible ring.

- [ ] **Step 4: Run the launcher tests**

Run: `npm exec vitest -- run app/components/FloatingAiLauncher.test.tsx`

Expected: PASS.

### Task 2: Remove Logo Repetition from Agent Surfaces

**Files:**
- Modify: `app/components/AgentPanel.test.tsx`
- Modify: `app/components/AgentPanel.tsx`
- Modify: `app/components/agent/AgentConversationThread.test.tsx`
- Modify: `app/components/agent/AgentConversationThread.tsx`

**Interfaces:**
- Consumes: Phosphor `SparkleIcon`
- Produces: Logo-free empty state, assistant message mark, and streaming mark

- [ ] **Step 1: Add failing assertions for Logo-free agent presentation**

Add a focused export or render path that asserts assistant presentation contains a decorative Sparkle SVG and no `/ai-panel-logo.png` image. Keep assertions tied to accessible/rendered output rather than internal component names.

- [ ] **Step 2: Run focused agent tests and confirm the new assertions fail**

Run: `npm exec vitest -- run app/components/AgentPanel.test.tsx app/components/agent/AgentConversationThread.test.tsx`

Expected: FAIL because both components currently render `/ai-panel-logo.png`.

- [ ] **Step 3: Replace brand images with one-piece Sparkle marks**

In `AgentPanel.tsx`, make `AgentAvatar` render `SparkleIcon` without a bordered tile and simplify the empty-state wrapper so it no longer creates a Logo card.

In `AgentConversationThread.tsx`, make `AssistantMark` render `SparkleIcon` in a plain 28px alignment slot without border, background, or shadow.

- [ ] **Step 4: Run focused agent tests**

Run: `npm exec vitest -- run app/components/AgentPanel.test.tsx app/components/agent/AgentConversationThread.test.tsx`

Expected: PASS.

### Task 3: Quiet Titlebar Identity and Full Verification

**Files:**
- Create: `app/components/shell/AppTitlebar.test.tsx`
- Modify: `app/components/shell/AppTitlebar.tsx`

**Interfaces:**
- Consumes: existing Electron window API mock
- Produces: titlebar with text `WeMail` and no Logo image

- [ ] **Step 1: Write the failing titlebar test**

Render the desktop titlebar with a minimal `window.wemailDesktop.window` mock and assert that `WeMail` is visible while no image is rendered.

- [ ] **Step 2: Run the titlebar test and confirm it fails on the current Logo image**

Run: `npm exec vitest -- run app/components/shell/AppTitlebar.test.tsx`

Expected: FAIL because the current titlebar renders `/ai-panel-logo.png`.

- [ ] **Step 3: Remove the titlebar Logo and serif override**

Keep the word `WeMail` in the existing draggable region using the standard UI font and medium weight.

- [ ] **Step 4: Run focused and project verification**

Run:

```powershell
npm exec vitest -- run app/components/FloatingAiLauncher.test.tsx app/components/AgentPanel.test.tsx app/components/agent/AgentConversationThread.test.tsx app/components/shell/AppTitlebar.test.tsx
npm run typecheck
npm run build:renderer
```

Expected: all focused tests pass, TypeScript succeeds, and the renderer production build completes.

