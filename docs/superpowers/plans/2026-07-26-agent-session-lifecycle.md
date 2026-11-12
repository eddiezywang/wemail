# WeMail AI Session Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every application start and every return from mail detail open a fresh empty home AI conversation, while preserving email tracing and explicit history restoration.

**Architecture:** Add a small pure lifecycle module that represents `home-fresh`, `email-trace`, and `history-resume` states. Make `useUIStore` the only owner of that state and trigger transitions from existing mail-selection and history actions; `AgentPanel` consumes the resolved conversation ID without falling back to `mailboxId` or inferring mode.

**Tech Stack:** React 19, TypeScript, Zustand, TanStack Query, Vitest, Electron.

## Global Constraints

- Do not delete or migrate existing `agent_conversations` data.
- Lifecycle mode is runtime-only and must not survive an application restart.
- A home conversation is persisted only after the user sends a message, so it remains manually recoverable from history.
- Opening mail must use that mail ID for trace history.
- Returning from mail detail must always generate a new home conversation ID.
- Explicit history selection must restore exactly the selected conversation.
- Any conversation transition must abort the old stream and must not display the old conversation's draft or messages.

---

## File Map

- Create `app/hooks/agentSessionLifecycle.ts`: pure lifecycle types, ID generation, and transition constructors.
- Create `app/hooks/agentSessionLifecycle.test.ts`: deterministic lifecycle unit tests.
- Modify `app/hooks/useUIStore.ts`: own the lifecycle state and apply transitions during mail, compose, history, and clear actions.
- Modify `app/hooks/useUIStore.test.ts`: verify store-level navigation behavior.
- Modify `app/components/AgentPanel.tsx`: consume the store conversation ID directly.
- Modify `app/components/AgentSidebar.tsx`: replace generic ID mutation with explicit fresh/history actions.

### Task 1: Pure Agent Session Lifecycle

**Files:**
- Create: `app/hooks/agentSessionLifecycle.ts`
- Create: `app/hooks/agentSessionLifecycle.test.ts`

**Interfaces:**
- Produces:
  - `type AgentSessionMode = "home-fresh" | "email-trace" | "history-resume"`
  - `type AgentSessionNavigation = { agentSessionMode: AgentSessionMode; agentSessionId: string }`
  - `type AgentSessionIdFactory = () => string`
  - `createFreshHomeAgentSession(makeId?: AgentSessionIdFactory): AgentSessionNavigation`
  - `openEmailAgentSession(emailId: string): AgentSessionNavigation`
  - `resumeAgentSession(conversationId: string): AgentSessionNavigation`
- Consumes: browser `crypto.randomUUID()` when available; timestamp/random fallback otherwise.

- [ ] **Step 1: Write the failing lifecycle tests**

```ts
import { describe, expect, it } from "vitest";
import {
  createFreshHomeAgentSession,
  openEmailAgentSession,
  resumeAgentSession,
} from "~/hooks/agentSessionLifecycle";

describe("agentSessionLifecycle", () => {
  it("creates a distinct runtime-only home conversation on every entry", () => {
    const ids = ["conv-home-1", "conv-home-2"];
    const makeId = () => ids.shift()!;

    expect(createFreshHomeAgentSession(makeId)).toEqual({
      agentSessionMode: "home-fresh",
      agentSessionId: "conv-home-1",
    });
    expect(createFreshHomeAgentSession(makeId)).toEqual({
      agentSessionMode: "home-fresh",
      agentSessionId: "conv-home-2",
    });
  });

  it("uses the selected mail id for trace history", () => {
    expect(openEmailAgentSession("msg-1")).toEqual({
      agentSessionMode: "email-trace",
      agentSessionId: "msg-1",
    });
  });

  it("restores an explicitly selected conversation", () => {
    expect(resumeAgentSession("conv-history-1")).toEqual({
      agentSessionMode: "history-resume",
      agentSessionId: "conv-history-1",
    });
  });
});
```

- [ ] **Step 2: Run the test and confirm RED**

Run:

```powershell
npx vitest run app/hooks/agentSessionLifecycle.test.ts
```

Expected: FAIL because `~/hooks/agentSessionLifecycle` does not exist.

- [ ] **Step 3: Implement the minimal lifecycle module**

```ts
export type AgentSessionMode =
  | "home-fresh"
  | "email-trace"
  | "history-resume";

export type AgentSessionNavigation = {
  agentSessionMode: AgentSessionMode;
  agentSessionId: string;
};

export type AgentSessionIdFactory = () => string;

function makeAgentSessionId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `conv-${crypto.randomUUID()}`;
  }
  return `conv-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function createFreshHomeAgentSession(
  makeId: AgentSessionIdFactory = makeAgentSessionId,
): AgentSessionNavigation {
  return { agentSessionMode: "home-fresh", agentSessionId: makeId() };
}

export function openEmailAgentSession(emailId: string): AgentSessionNavigation {
  return { agentSessionMode: "email-trace", agentSessionId: emailId };
}

export function resumeAgentSession(
  conversationId: string,
): AgentSessionNavigation {
  return {
    agentSessionMode: "history-resume",
    agentSessionId: conversationId,
  };
}
```

- [ ] **Step 4: Run the lifecycle test and confirm GREEN**

Run:

```powershell
npx vitest run app/hooks/agentSessionLifecycle.test.ts
```

Expected: 3 tests pass.

- [ ] **Step 5: Commit the pure lifecycle**

```powershell
git add app/hooks/agentSessionLifecycle.ts app/hooks/agentSessionLifecycle.test.ts
git commit -m "feat: define agent session lifecycle"
```

### Task 2: Make UI Store the Lifecycle Owner

**Files:**
- Modify: `app/hooks/useUIStore.ts`
- Modify: `app/hooks/useUIStore.test.ts`

**Interfaces:**
- Consumes Task 1's `AgentSessionMode`, `createFreshHomeAgentSession`, `openEmailAgentSession`, and `resumeAgentSession`.
- Produces store fields and actions:
  - `agentSessionMode: AgentSessionMode`
  - `agentSessionId: string`
  - `startFreshAgentConversation(): void`
  - `openEmailAgentConversation(emailId: string): void`
  - `resumeAgentConversation(conversationId: string): void`
  - Existing `clearAgentConversation(): void`, now entering `home-fresh` and incrementing `agentClearTick`.

- [ ] **Step 1: Replace the old nullable-session test setup and add failing transition tests**

Reset the store with a known fresh navigation:

```ts
useUIStore.setState({
  selectedEmailId: null,
  agentSessionMode: "home-fresh",
  agentSessionId: "conv-test-home",
  agentClearTick: 0,
  // existing reset fields remain unchanged
});
```

Add these tests:

```ts
it("opens selected mail in its trace conversation", () => {
  useUIStore.getState().selectEmail("msg-1");

  expect(useUIStore.getState()).toMatchObject({
    selectedEmailId: "msg-1",
    agentSessionMode: "email-trace",
    agentSessionId: "msg-1",
  });
});

it("returns from mail detail to a different fresh home conversation", () => {
  useUIStore.getState().selectEmail("msg-1");
  useUIStore.getState().clearSelectedEmail();
  const firstHomeId = useUIStore.getState().agentSessionId;

  expect(useUIStore.getState().agentSessionMode).toBe("home-fresh");
  expect(firstHomeId).not.toBe("msg-1");
  expect(firstHomeId).not.toBe("conv-test-home");

  useUIStore.getState().selectEmail("msg-2");
  useUIStore.getState().closePanel();
  expect(useUIStore.getState().agentSessionMode).toBe("home-fresh");
  expect(useUIStore.getState().agentSessionId).not.toBe(firstHomeId);
});

it("restores only an explicitly selected history conversation", () => {
  useUIStore.getState().resumeAgentConversation("conv-history-1");

  expect(useUIStore.getState()).toMatchObject({
    agentSessionMode: "history-resume",
    agentSessionId: "conv-history-1",
  });
});

it("mail selection takes over after manually restoring history", () => {
  useUIStore.getState().resumeAgentConversation("conv-history-1");
  useUIStore.getState().selectEmail("msg-2");

  expect(useUIStore.getState()).toMatchObject({
    agentSessionMode: "email-trace",
    agentSessionId: "msg-2",
  });
});
```

- [ ] **Step 2: Run the store tests and confirm RED**

Run:

```powershell
npx vitest run app/hooks/useUIStore.test.ts
```

Expected: FAIL because the store does not expose lifecycle mode/actions and mail selection does not transition the conversation.

- [ ] **Step 3: Add lifecycle fields and semantic actions**

Import Task 1's lifecycle functions and initialize the store once per renderer process:

```ts
const initialAgentSession = createFreshHomeAgentSession();

export const useUIStore = create<UIState>((set, get) => ({
  // existing state
  agentSessionMode: initialAgentSession.agentSessionMode,
  agentSessionId: initialAgentSession.agentSessionId,

  startFreshAgentConversation: () =>
    set(createFreshHomeAgentSession()),
  openEmailAgentConversation: (emailId) =>
    set(openEmailAgentSession(emailId)),
  resumeAgentConversation: (conversationId) =>
    set(resumeAgentSession(conversationId)),
}));
```

Update `selectEmail(id)` atomically:

```ts
selectEmail: (id) =>
  set({
    selectedEmailId: id,
    isComposing: false,
    ...(id ? openEmailAgentSession(id) : createFreshHomeAgentSession()),
  }),
```

Update `clearSelectedEmail()` and `closePanel()` so each call spreads a newly created `home-fresh` navigation into the same atomic state update. Update `clearAgentConversation()` similarly while preserving `agentClearTick + 1`.

For compose transitions, preserve these invariants:

- Reply, reply-all, and forward retain the selected mail and its `email-trace` session.
- Starting a new-message compose from mail detail clears the mail selection and enters a newly generated `home-fresh` session.
- Closing compose and restoring `_previousEmailId` restores that mail's `email-trace` session; closing without a previous mail remains on the current fresh home session.

- [ ] **Step 4: Run store tests and confirm GREEN**

Run:

```powershell
npx vitest run app/hooks/useUIStore.test.ts
```

Expected: all existing and new `useUIStore` tests pass.

- [ ] **Step 5: Commit the store lifecycle**

```powershell
git add app/hooks/useUIStore.ts app/hooks/useUIStore.test.ts
git commit -m "feat: manage agent sessions through UI navigation"
```

### Task 3: Wire Agent Panel and History Controls

**Files:**
- Modify: `app/components/AgentPanel.tsx`
- Modify: `app/components/AgentSidebar.tsx`
- Modify: `app/components/AgentPanel.test.tsx`

**Interfaces:**
- Consumes Task 2's non-null `agentSessionId`, `startFreshAgentConversation`, and `resumeAgentConversation`.
- Produces: an AgentPanel that queries exactly the store-selected conversation and history controls that use semantic transitions.

- [ ] **Step 1: Add a failing resolver regression test**

Export a small pure selector from `AgentPanel.tsx`:

```ts
export function resolveAgentConversationId(agentSessionId: string): string {
  return agentSessionId;
}
```

Write the test first, before adding the function:

```ts
import * as agentPanel from "./AgentPanel";

it("uses the store-selected conversation without a mailbox fallback", () => {
  expect(
    agentPanel.resolveAgentConversationId?.("conv-home-new"),
  ).toBe("conv-home-new");
});
```

- [ ] **Step 2: Run the panel test and confirm RED**

Run:

```powershell
npx vitest run app/components/AgentPanel.test.tsx
```

Expected: FAIL because `resolveAgentConversationId` is undefined.

- [ ] **Step 3: Remove inferred session fallback and update history actions**

In `AgentPanel.tsx`, replace:

```ts
const effectiveSessionId =
  agentSessionId ?? selectedEmailId ?? mailboxId;
```

with:

```ts
const effectiveSessionId = resolveAgentConversationId(agentSessionId);
```

Keep the existing effect keyed by `effectiveSessionId`; it already aborts `abortRef.current`, resets rendered messages from the new query, and rebuilds conversation state. Keep `AgentComposer` keyed by `effectiveSessionId` so draft storage remains isolated.

In `AgentSidebar.tsx`:

- Replace history `setAgentSessionId(c.id)` with `resumeAgentConversation(c.id)`.
- Replace “新建会话” ID construction with `startFreshAgentConversation()`.
- After clearing all server history, call `startFreshAgentConversation()`.
- When navigating to a pending action's conversation, call `resumeAgentConversation(action.conversationId)`.
- Keep the trash action on `clearAgentConversation()` because it must also increment `agentClearTick`.
- Remove the now-unused local `makeSessionId()` helper.

- [ ] **Step 4: Run focused tests and confirm GREEN**

Run:

```powershell
npx vitest run app/components/AgentPanel.test.tsx app/hooks/agentSessionLifecycle.test.ts app/hooks/useUIStore.test.ts
```

Expected: all focused tests pass.

- [ ] **Step 5: Commit the panel integration**

```powershell
git add app/components/AgentPanel.tsx app/components/AgentSidebar.tsx app/components/AgentPanel.test.tsx
git commit -m "fix: start home AI conversations fresh"
```

### Task 4: Full Verification and Desktop Smoke Test

**Files:**
- No source changes expected.
- Generated artifacts: `build/**`, `dist-electron/**`, and `dist/**` remain untracked build output.

**Interfaces:**
- Consumes the completed lifecycle implementation.
- Produces fresh evidence that tests, type checks, production build, and installed desktop behavior satisfy the design.

- [ ] **Step 1: Run all renderer tests**

Run:

```powershell
npm run test:renderer
```

Expected: exit code 0 with zero failed tests.

- [ ] **Step 2: Run project type checking**

Run:

```powershell
npm run typecheck
```

Expected: exit code 0.

- [ ] **Step 3: Build the desktop application**

Run:

```powershell
npm run build:desktop
```

Expected: exit code 0 and telemetry config written to `build/telemetry-config.json`.

- [ ] **Step 4: Repackage and install the desktop application**

Run:

```powershell
npm run package:desktop:installer
```

Expected: `dist/WeMail Setup 0.1.1.exe` is regenerated and contains `WeMailDesktop.exe`.

Install the regenerated package, then start:

```text
C:\Users\Administrator\AppData\Local\Programs\WeMailDesktop\WeMailDesktop.exe
```

- [ ] **Step 5: Perform the lifecycle smoke test**

Verify in order:

1. Start WeMail and confirm the AI panel contains no previous messages.
2. Send a harmless home prompt so the current home session has visible content.
3. Open a mail and confirm the panel switches to that mail's trace conversation.
4. Close mail detail and confirm the panel is empty rather than restoring the home prompt.
5. Open history and select the earlier home conversation; confirm the prompt reappears.
6. Exit and restart WeMail; confirm the panel is empty again.

Capture a screenshot after steps 1, 4, 5, and 6 and retain the Midscene report path.

- [ ] **Step 6: Verify Git state and push**

Run:

```powershell
git status --short
git log -3 --oneline
git push origin main
```

Expected: no uncommitted source changes and all implementation commits are present on `origin/main`.
