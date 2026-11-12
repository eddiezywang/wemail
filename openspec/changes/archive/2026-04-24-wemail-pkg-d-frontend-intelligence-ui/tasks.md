## 1. Renderer types and query layer

- [x] 1.1 Write failing test for `app/types/wemail.ts` re-exports (summary DTO, tag DTO, draft DTO, queue status).
- [x] 1.2 Create `app/types/wemail.ts` mirroring `shared/wemail/*`.
- [x] 1.3 Write failing test for `app/queries/intelligence.ts` and `app/queries/queue.ts` hooks.
- [x] 1.4 Create `app/queries/intelligence.ts` and `app/queries/queue.ts`; modify `app/services/api.ts` to expose the endpoints.

## 2. Summary, tags, draft components

- [x] 2.1 Write failing component test for `EmailSummaryCard` covering empty / pending / success / failed states.
- [x] 2.2 Create `app/components/wemail/EmailSummaryCard.tsx`.
- [x] 2.3 Write failing component test for `EmailSmartTags` (accept / reject actions fire correct mutations).
- [x] 2.4 Create `app/components/wemail/EmailSmartTags.tsx`.
- [x] 2.5 Write failing component test for `SmartDraftPanel` (edit / accept / delete; no auto-send button).
- [x] 2.6 Create `app/components/wemail/SmartDraftPanel.tsx`.

## 3. Status components

- [x] 3.1 Write failing test for `IntelligenceStatus` aggregation per message.
- [x] 3.2 Create `app/components/wemail/IntelligenceStatus.tsx`.
- [x] 3.3 Write failing test for `QueueStatusBadge` counts.
- [x] 3.4 Create `app/components/wemail/QueueStatusBadge.tsx`.

## 4. Agent confirm dialog

- [x] 4.1 Write failing test for `AgentActionConfirmDialog` props and approve/reject flow.
- [x] 4.2 Create `app/components/wemail/AgentActionConfirmDialog.tsx`.

## 5. EmailPanel integration

- [x] 5.1 Write failing test: `EmailPanel` still renders existing read/draft flow when intelligence data is absent.
- [x] 5.2 Modify `app/components/EmailPanel.tsx` to slot the new components incrementally.
- [x] 5.3 Run tests until green.

## 6. i18n sanity

- [x] 6.1 Manual sweep: all user-facing strings have Chinese + English equivalents (or use the existing i18n keys).

## 7. Verification

- [x] 7.1 Run `npm run test:server` — must pass.
- [x] 7.2 Run `npm run typecheck:server` — must pass.
- [x] 7.3 Run `npm run typecheck:desktop` — must pass.
- [x] 7.4 Run `npm run build:desktop` — must pass.
- [x] 7.5 Confirm new code has unit / component tests.
- [x] 7.6 Confirm no violations of Handoff §6 hard rules (no direct server imports in renderer, no auto-send, confirm dialog used for every non-`ls/list` command).
- [x] 7.7 Commit with the exact Handoff §5.D message: `git commit -m "feat(app): add wemail intelligence panels"`.
