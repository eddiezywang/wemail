# AI Writing Suite - Tasks

## Implementation

### upstream-aligned compose interaction

- [x] Mark signatures and quoted replies as protected compose regions.
- [x] Exclude protected regions from AI rewrite context and merge them back unchanged.
- [x] Return structured `draft` or `needsClarification` results from compose generation.
- [x] Submit with Enter, preserve Shift+Enter for multiline instructions, and label the action “发送给 AI”.
- [x] Keep clarification inline without replacing the current editor body.
- [x] Add recent-prompt recall without automatic replay.
- [x] Add body version navigation and truncate the forward branch on new generation.
- [x] Add Expand, Shorten, Rewrite, and Fix grammar actions.
- [x] Add an abortable generating state.
- [x] Add focused renderer and server tests for the interaction state machine.
- [x] Collapse the fixed rich-text toolbar behind the compose formatting control.
- [x] Replace permanent quick-action buttons with one compact optimization menu.
- [x] Align history, versions, writing style, language, and the AI input with Agentic Inbox 2.1.2.
- [x] Retry once when a formal draft is only an instruction echo or unusably short fragment.
- [x] Add upstream-parity scenarios for formal receipt, meeting commitment, recipient-later drafting, rewrite, target language, strict one-line output, formal decline, explicit deadlines, and missing-date clarification.
- [x] Run six same-prompt scenarios through the visible Agentic Inbox and WeMail reply composers and record the redacted semantic conclusions.

- [x] Write failing tests that AI writing cannot send mail through any processor/tool path.
- [x] Write failing tests for reply draft shape excluding subject, headers, and fake signatures.
- [x] Verify compose can draft before recipients are filled and still clarifies a missing purpose.
- [x] Write failing tests for unknown `styleId` returning a validation error.
- [x] Implement unified writing contracts for reply and compose.
- [x] Implement reply draft context using summary, reply decision, mail context, writing style, and profile.
- [x] Implement compose generation with intent, recipients, styleId, and target language.
- [x] Persist draft versions: initial, regenerated, accepted/deleted, edited-and-sent.
- [x] Record feedback events queryable by email id.
- [x] Add at least 25 writing fixtures and eval assertions for JSON validity and clarification.
- [x] Surface saved local AI drafts in Drafts list/detail/count and clean them up on delete/send.
- [x] Run focused writing processor, route, feedback, and eval tests.
- [x] Run `npm run typecheck:server`.
- [x] Run `npm run test:server`.
- [x] If frontend writing components are touched, run the relevant client typecheck command.

## Execution Agent Report

```text
Change ID: ai-writing-suite
Goal: upstream-aligned conversational AI drafts in new compose and reply surfaces.
Files touched: compose controller/editor, compose service/bootstrap, mail draft projection, tests, OpenSpec artifacts.
Spec scenarios implemented: draft-only, complete reply shape, clarification, style integrity, dual histories, protected regions, durable drafts.
Tests added: renderer state machine/editor DOM, service/integration, mail routes, Electron acceptance.
Verification commands: typecheck, typecheck:server, build:desktop, test:renderer, test:server, test:e2e, desktop acceptance harness.
Known gaps: visual language remains WeMail-branded; global model selection remains in settings; Agentic Inbox cloud output cannot be byte-identical across providers.
Risk notes: none blocking; no path auto-sends.
Ready for review: yes
```

## Merge Gate

Block merge if any path auto-sends mail, drafts contain fabricated commitments/attachments/signatures, or an invalid style silently maps to the wrong style.
