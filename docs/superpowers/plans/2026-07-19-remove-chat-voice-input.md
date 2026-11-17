# Remove Chat Voice Input Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove every rendered and dormant voice-input affordance from the two chat composer components without changing text submission behavior.

**Architecture:** This is a local presentation and public-prop cleanup. `AgentComposer` loses its always-rendered disabled voice button, while `AskBox` loses its unused optional microphone extension point and conditional UI branch.

**Tech Stack:** React 19, TypeScript, Vitest, Testing Library, Phosphor Icons.

## Global Constraints

- Preserve text submission, queued follow-up, stop-generation, IME, and draft persistence behavior.
- Do not add speech recognition, replacement controls, backend changes, or shared-contract changes.
- No voice-input affordance or dormant voice-input extension point may remain in either composer.

---

### Task 1: Remove Voice Input From Both Chat Composers

**Files:**
- Modify: `app/components/agent/AgentComposer.test.tsx`
- Modify: `app/components/agent/AgentComposer.tsx`
- Modify: `app/components/wemail/AskBox.tsx`

**Interfaces:**
- Consumes: Existing `AgentComposerProps` and `AskBoxProps`.
- Produces: `AskBoxProps` without `onMicClick`; both composers render text and send controls without a microphone control.

- [ ] **Step 1: Write the failing regression test**

Add this test inside the existing `describe("AgentComposer", ...)` block:

```tsx
it("does not render a voice input control", () => {
  renderComposer();
  expect(screen.queryByRole("button", { name: "Voice" })).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
npx vitest run app/components/agent/AgentComposer.test.tsx
```

Expected: the new test fails because the current component renders a disabled button with `aria-label="Voice"`.

- [ ] **Step 3: Remove the minimal production code**

In `AgentComposer.tsx`, remove `MicrophoneIcon` from the Phosphor import and remove:

```tsx
<button type="button" disabled aria-label="Voice" className="inline-flex h-[30px] w-[30px] items-center justify-center rounded-full text-ink-3 opacity-40">
  <MicrophoneIcon size={14} />
</button>
```

Change the footer wrapper from `justify-between` to `justify-end` so the remaining controls stay right-aligned:

```tsx
<div className="flex items-center justify-end px-0.5">
```

In `AskBox.tsx`, import only `ArrowUpIcon`, remove `onMicClick` from `AskBoxProps` and component destructuring, remove the conditional microphone button, and update the visual documentation to describe only the send button.

- [ ] **Step 4: Run focused component tests and verify GREEN**

Run:

```powershell
npx vitest run app/components/agent/AgentComposer.test.tsx app/components/wemail/AskBox.test.tsx
```

Expected: both test files pass with zero failed tests.

- [ ] **Step 5: Verify source cleanup and type safety**

Run:

```powershell
rg -n "MicrophoneIcon|onMicClick|ask-box-mic|Voice input|aria-label=\"Voice\"" app/components/agent/AgentComposer.tsx app/components/wemail/AskBox.tsx
npm run typecheck
```

Expected: `rg` returns no matches and `npm run typecheck` exits successfully.

- [ ] **Step 6: Commit the implementation**

```powershell
git add -- app/components/agent/AgentComposer.test.tsx app/components/agent/AgentComposer.tsx app/components/wemail/AskBox.tsx docs/superpowers/plans/2026-07-19-remove-chat-voice-input.md
git commit -m "fix: remove chat voice input controls"
```
