## Context

The renderer already has an `EmailPanel` for the mail detail view and an `app/services/api.ts` shim. There are no intelligence-aware components, no queue status surface, and no confirm dialog. This package adds incremental components, not a rewrite.

## Goals / Non-Goals

**Goals:**

- Incremental insertion into `EmailPanel` — existing read/draft flows remain untouched.
- Clear visual state machine per component: `empty → pending → success → failed`.
- Dense, professional enterprise UI; Chinese + English text.
- `AgentActionConfirmDialog` is reusable by Packages I and J; its API is defined here.
- All data access goes through `app/queries/*` against the server API; no direct IPC to `server/wemail/*`.

**Non-Goals:**

- Redesigning folder tree, mailbox list, compose window.
- Offline caching semantics beyond what the query layer already does.
- Implementing the server APIs consumed here (owned by B, C, E, F, G, I, J).

## Decisions

- **One file per component.** Keeps review and test surfaces small and maps 1:1 to the file list in Handoff §5.D.
- **State is fetched, not pushed.** Components subscribe via `app/queries/intelligence.ts` and `app/queries/queue.ts`. Server push (SSE/WebSocket) is out of scope; polling is acceptable for phase one.
- **`AgentActionConfirmDialog` props.** `{ title, command, rationale, risk, onApprove, onReject }`. Packages I and J will wrap it. Alternative rejected: one dialog per package — inconsistent UX.
- **Shared types reused.** `app/types/wemail.ts` re-exports or narrows from `shared/wemail/intelligence.ts`, `shared/wemail/queue.ts`, `shared/wemail/skills.ts`, `shared/wemail/agent.ts`. Renderer never imports from `server/*`.
- **i18n.** Text is externalized where the existing codebase already supports it; otherwise pragmatic bilingual labels inline — must not block Chinese or English users from reading the UI.
- **No auto-send.** `SmartDraftPanel` has accept/edit/delete actions, but the actual send action is delegated to the existing compose review flow; the draft generator never triggers `sendDraft`.

## Risks / Trade-offs

- **[Risk] EmailPanel regression.** → Mitigation: slot components inside new sub-regions; add a visual/unit test that the existing read flow still renders when intelligence data is absent.
- **[Risk] Confirm dialog fragmentation.** → Mitigation: single component, opinionated API; Packages I/J cannot fork it.
- **[Risk] Polling storms for queue status.** → Mitigation: single global subscription for `QueueStatusBadge`, per-message subscription only for the open detail view.
- **[Risk] Accidentally rendering body content into telemetry/logs.** → Mitigation: renderer telemetry (if wired) passes only ids and status.

## Migration Plan

- Purely additive on the renderer side.
- Rollback: revert `EmailPanel.tsx` slots and delete `app/components/wemail/*`.

## Open Questions

- Final styling tokens / theme alignment — resolved during implementation against existing design tokens.
