# Account Signature and Compose Experience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build account-scoped default-on signatures, Agentic Inbox-style guided AI writing, and a reliably resizable/maximizable floating composer.

**Architecture:** Keep non-signature user preferences in the existing global store and add a focused account-keyed signature store. Let `ComposeBody` coordinate the editor empty state with an imperative focus handle exposed by `AiPromptBar`. Move floating-window geometry into pure functions and a single rectangle state so eight-direction resizing and maximize/restore share one source of truth.

**Tech Stack:** React 19, TypeScript, TipTap 3, Tailwind CSS, Vitest, Testing Library, Electron, Midscene.

## Global Constraints

- Signature preferences are isolated by account ID and default to enabled.
- Disabled signatures render neither identity text nor `Sent with WeMail`.
- Identity priority is custom text, display name, email local part, then email address.
- Existing global signature values are ignored and are not migrated.
- The signature and footer remain manually editable/deletable after insertion.
- The AI guidance mirrors Agentic Inbox's interaction but uses WeMail branding.
- Do not add a drag/resize dependency.
- Completion requires automated checks plus desktop UI acceptance evidence.

---

### Task 1: Account-scoped signature preference model

**Files:**
- Create: `app/hooks/useAccountSignaturePreferences.ts`
- Create: `app/hooks/useAccountSignaturePreferences.test.tsx`
- Modify: `app/hooks/useUserPreferences.ts`

**Interfaces:**
- Produces: `AccountSignaturePreference`, `getAccountSignaturePreference(accountId)`, `setAccountSignaturePreference(accountId, patch)`, and `useAccountSignaturePreference(accountId)`.
- Storage key: `wemail.signaturePreferences.v1`.

- [ ] **Step 1: Write failing storage tests**

```ts
expect(getAccountSignaturePreference("account-a")).toEqual({ enabled: true, customText: "" });
setAccountSignaturePreference("account-a", { customText: "Alice" });
expect(getAccountSignaturePreference("account-a").customText).toBe("Alice");
expect(getAccountSignaturePreference("account-b")).toEqual({ enabled: true, customText: "" });
```

Also seed `wemail.userPreferences` with `—\nEddie Wang` and assert it is ignored.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npx vitest run app/hooks/useAccountSignaturePreferences.test.tsx`

Expected: FAIL because the new module does not exist.

- [ ] **Step 3: Implement a defensive external store**

Implement JSON parsing with per-account validation, default-on fallback, immutable updates, `useSyncExternalStore`, and a test reset helper. Remove `signatureEnabled` and `signatureText` from `UserPreferences` and `DEFAULTS` so polluted global fields cannot be consumed.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run: `npx vitest run app/hooks/useAccountSignaturePreferences.test.tsx`

Expected: all account isolation, corruption fallback, and legacy-ignore tests pass.

### Task 2: Signature resolution and compose initialization

**Files:**
- Modify: `app/lib/utils.ts`
- Modify: `app/lib/utils.test.ts`
- Modify: `app/hooks/useComposeForm.ts`
- Modify: `app/hooks/useComposeForm.test.tsx`

**Interfaces:**
- Produces: `resolveSignatureText({ customText, displayName, emailAddress }): string`.
- Consumes: `useAccountSignaturePreference(activeAccountId)` from Task 1.

- [ ] **Step 1: Write failing resolver and compose tests**

```ts
expect(resolveSignatureText({ customText: "  Custom  ", displayName: "Alice", emailAddress: "a@example.com" })).toBe("Custom");
expect(resolveSignatureText({ customText: "", displayName: " Alice ", emailAddress: "a@example.com" })).toBe("Alice");
expect(resolveSignatureText({ customText: "", displayName: "", emailAddress: "123456789@example.com" })).toBe("123456789");
```

Assert enabled compose HTML contains the resolved identity and `Sent with WeMail`, disabled compose HTML contains neither, and an existing draft body is unchanged.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npx vitest run app/lib/utils.test.ts app/hooks/useComposeForm.test.tsx`

Expected: resolver/import assertions fail and the old Eddie preference test contradicts the new behavior.

- [ ] **Step 3: Implement signature construction**

Resolve the account identity, pass `{ enabled, text, brand: "Sent with WeMail" }` to a revised `getSignatureBlock`, and initialize new/reply/reply-all/forward bodies once. Preserve draft bodies verbatim and keep `data-wemail-signature="true"` so AI rewriting can exclude the block.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `npx vitest run app/lib/utils.test.ts app/hooks/useComposeForm.test.tsx`

Expected: all signature and existing compose tests pass.

### Task 3: Per-account signature settings UI

**Files:**
- Modify: `app/components/settings/sections/ComposeSection.tsx`
- Modify: `app/components/settings/SettingsDialog.test.tsx`

**Interfaces:**
- Consumes: current account `id`, `displayName`, `emailAddress`; signature hook and resolver from Tasks 1–2.

- [ ] **Step 1: Write failing settings tests**

Render the compose settings for account `123456789@example.com` and assert the default-on switch, default identity preview, `Sent with WeMail`, custom override, restore-default action, and disabled-state message. Switch mock account IDs and assert values do not leak.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npx vitest run app/components/settings/SettingsDialog.test.tsx`

Expected: FAIL because the current UI reads global signature fields and has no preview/reset behavior.

- [ ] **Step 3: Implement the account-aware settings surface**

Use a calm bordered section with account address, default identity chip, default-on switch, custom textarea, “恢复默认”, final signature preview, and a disabled message that explicitly states no signature/footer will be added. Keep the send shortcut control backed by `useUserPreferences`.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `npx vitest run app/components/settings/SettingsDialog.test.tsx`

Expected: settings behavior and existing dialog navigation tests pass.

### Task 4: Agentic Inbox-style inline AI guidance

**Files:**
- Modify: `app/components/compose/AiPromptBar.tsx`
- Modify: `app/components/compose/AiPromptBar.test.tsx`
- Modify: `app/components/compose/ComposeBody.tsx`
- Create: `app/components/compose/ComposeBody.test.tsx`
- Modify: `app/components/RichTextEditor.tsx`
- Modify: `app/components/editor/RichTextEditor.test.tsx`

**Interfaces:**
- `AiPromptBar` becomes `forwardRef<AiPromptBarHandle>` where `focus(): void` calls `scrollIntoView({ block: "nearest" })` and focuses its textarea.
- `RichTextEditor` receives optional `emptyGuidance?: ReactNode` and renders it over an editable-empty body.
- `ComposeBody` derives empty editable content with `splitComposeAiBody(body)` and calls `aiPromptRef.current?.focus()`.

- [ ] **Step 1: Write failing interaction tests**

Assert the guidance is visible for empty body and signature-only body, hidden after real text, keyboard accessible, and clicking “使用 AI 写作” scrolls/focuses the AI textarea without changing body HTML.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npx vitest run app/components/compose/AiPromptBar.test.tsx app/components/compose/ComposeBody.test.tsx app/components/editor/RichTextEditor.test.tsx`

Expected: FAIL because no imperative focus handle or guidance surface exists.

- [ ] **Step 3: Implement guidance and focus flow**

Add a low-contrast `开始输入或` label plus WeMail-coral `使用 AI 写作` button at the editor start. Add hover/focus-visible background and underline treatment. Give the bottom prompt a Agentic Inbox-like rounded input bar, keep style/language controls immediately above it, and expose the ref-based focus API.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `npx vitest run app/components/compose/AiPromptBar.test.tsx app/components/compose/ComposeBody.test.tsx app/components/editor/RichTextEditor.test.tsx`

Expected: all new guidance tests and existing AI/editor tests pass.

### Task 5: Eight-direction resize and reliable maximize/restore

**Files:**
- Create: `app/components/compose/floatingComposeGeometry.ts`
- Create: `app/components/compose/floatingComposeGeometry.test.ts`
- Modify: `app/components/compose/InlineFloatingCompose.tsx`
- Create: `app/components/compose/InlineFloatingCompose.test.tsx`

**Interfaces:**
- Produces: `ComposeRect`, `ResizeDirection`, `clampComposeRect`, and `resizeComposeRect(startRect, direction, dx, dy, viewport)`.
- `InlineFloatingCompose` owns `{ mode, rect, restoreRect }` and renders eight `data-resize-direction` pointer handles only in floating mode.

- [ ] **Step 1: Write failing geometry and component tests**

Cover all eight resize directions, minimum `320x260`, 16px floating margin, viewport shrink clamping, pointer resize, and three maximize/restore cycles that restore the exact pre-maximized rectangle and toggle the accessible label.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npx vitest run app/components/compose/floatingComposeGeometry.test.ts app/components/compose/InlineFloatingCompose.test.tsx`

Expected: FAIL because geometry helpers and resize handles do not exist; the component only restores position.

- [ ] **Step 3: Implement one-source-of-truth geometry**

Replace derived `panelSize`/`position`/`maximized` with a clamped rectangle and explicit mode. Use pointer capture for drag and resize sessions, store the whole rectangle before maximize, restore it atomically, disable handles while maximized, and clamp on viewport resize.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `npx vitest run app/components/compose/floatingComposeGeometry.test.ts app/components/compose/InlineFloatingCompose.test.tsx`

Expected: geometry and component interaction tests pass.

### Task 6: Integrated verification and Agentic Inbox parity acceptance

**Files:**
- Record acceptance results locally using anonymized data before sharing.
- Create: `.tmp/acceptance/account-signature-compose/*.png` (local evidence; do not commit if ignored)

**Interfaces:**
- Consumes all prior tasks and the existing Midscene desktop/browser setup.

- [ ] **Step 1: Run all static and automated checks**

Run:

```powershell
npm run typecheck
npm run test:renderer
npm run build:desktop
```

Expected: all commands exit 0 with no failed tests.

- [ ] **Step 2: Launch and perform desktop acceptance**

Start the API/renderer/Electron stack using the repository launch scripts. Verify account identity, default-on signature, disabled signature, custom/restore behavior, AI guidance default/hover/focus states, direct prompt focus, eight handles, and three maximize/restore cycles. Capture screenshots without exposing credentials.

- [ ] **Step 3: Score against Agentic Inbox**

Record a requirement matrix with observed evidence. Score functional parity and visual quality from 0–100 using equal-weight criteria; both must be at least 80. Any failed criterion returns to the owning task before completion.

- [ ] **Step 4: Commit the verified feature**

Stage only the implementation, tests, plan/spec, and acceptance report. Commit with `feat: complete account-aware AI compose experience` after a clean diff review.

- [ ] **Step 5: Merge and push main**

Fetch `origin/main`, merge it into `codex/ai-draft-rework`, resolve and re-run verification, then fast-forward or merge the feature into local `main`. Push `main` to `origin` and verify local `main`, `origin/main`, and the pushed SHA are identical.
