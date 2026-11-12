# Acceptance Report: ai-writing-suite

## Change ID

`ai-writing-suite`

## Acceptance Scope

Reproduce Agentic Inbox's AI writing behavior inside WeMail's canonical compose
editor for both new mail and replies. AI output must be a complete, editable
email draft, never an instruction echo or an automatically sent message.

## Upstream-Aligned Behavior Matrix

| Capability | WeMail result | Evidence |
| --- | --- | --- |
| AI writes directly into compose body | Pass | Electron new-compose and reply flows |
| No secondary preview/accept step | Pass | Generated body is immediately editable |
| Explicit “发送给 AI” action | Pass | Renderer interaction test + Electron |
| Enter submits; Shift+Enter creates newline | Pass | Renderer interaction test + Electron |
| Complete email semantics | Pass | Structured prompt/result tests; desktop body includes greeting, purpose, and closing |
| Drafting before recipient is filled | Pass | Service test + desktop recipient remains empty |
| Inline clarification without body overwrite | Pass | Service, renderer, and Electron checks |
| Prompt recall without automatic replay | Pass | Renderer and Electron checks |
| Previous/next body versions | Pass | Renderer and Electron checks |
| Regeneration from older version truncates forward branch | Pass | Stateful renderer test |
| Expand / Shorten / Rewrite / Grammar | Pass | Renderer and Electron checks |
| Writing style immediately regenerates existing body | Pass | Composition integration + Electron |
| Language selection affects the next request | Pass | Controller request wiring and service prompt coverage |
| Stop in-progress generation | Pass | Abort-controller renderer test |
| Preserve quoted original message | Pass | Real editor DOM test + Electron reply flow |
| Preserve signature | Pass | Real editor DOM test + reopened saved-draft Electron flow |
| Saved AI draft appears in Drafts and can be reopened | Pass | Route integration test + Electron |
| AI cannot send mail | Pass | Processor/tool boundary tests + Electron outbox assertion |

## UI Review

The compose editor remains the visual center of the workflow. AI controls are
grouped beneath the body in the same hierarchy as the upstream reference:

- prompt history, version navigation, and one compact optimization menu nearest the generated content;
- writing style and output language rendered as quiet pill controls;
- one conversational instruction field with a single send/stop action;
- the fixed formatting toolbar is collapsed by default behind the `Aa` control;
- clarification appears inline and does not create a competing preview card;
- successful generation does not show an overlapping success toast.

New compose, reply, and reopened-draft screenshots were visually inspected at
desktop size. Controls do not cover the editor or send/save actions, quoted
content remains legible, and protected signatures retain their separator and
layout.

## Agentic Inbox 2.1.2 Comparison

The installed Agentic Inbox `app.asar` was inspected read-only to verify the current
compose implementation rather than relying only on the older reference
screenshot. The current product uses:

- a bottom compose controller ordered as history, writing style, output
  language, and one AI prompt field;
- a collapsed formatting toolbar opened from a round format control;
- body-version navigation separate from prompt history;
- style changes that immediately rewrite existing content;
- language changes that affect the next generation;
- longer / shorter / rewrite / grammar actions behind contextual or compact
  controls instead of permanently occupying the compose footer.

WeMail now reproduces those conclusions while retaining protected compose
regions and durable local drafts.

## Live Same-Prompt Competitor Run

On 2026-07-17, Agentic Inbox 2.1.2 and the merged WeMail `main` desktop build were
driven through their visible reply composers with the same six Chinese
instructions. Each instruction was submitted through the product's AI-writing
field; neither product's mail-send button was used.

| Scenario | Same prompt conclusion | Agentic Inbox observation | WeMail observation | Result |
| --- | --- | --- | --- | --- |
| Formal receipt | Confirm receipt in a usable, slightly formal reply | Greeting, receipt confirmation, thanks | Formal greeting, receipt confirmation, context fact, thanks, protected signature | Pass |
| Strict one line | One sentence saying received and thanks | One sentence, no generated greeting or closing | One sentence, no generated greeting or closing; existing protected signature remains separate | Pass |
| Professional English | English receipt reply with greeting and closing | Professional English greeting and receipt paragraph; no closing in this run | Professional English greeting, receipt paragraph, closing, and protected signature | Pass; WeMail followed the closing requirement more completely |
| Polite decline | Decline formally without inventing a concrete reason | Formal inability-to-accommodate conclusion without a concrete reason | Formal inability-to-arrange conclusion without a concrete reason | Pass |
| Explicit commitment | Preserve Friday 17:00 commitment and add no other commitment | Preserved the supplied deadline and did not add another commitment | Preserved the supplied deadline and did not add another commitment | Pass |
| Missing deadline | Ask the sender for a concrete deadline without guessing one | Requested a deadline and did not invent a date | Requested a deadline and did not invent a date | Pass |

Direct semantic parity: **6/6 scenarios (100%)**. The compared criterion is the
requested conclusion and constraints, not byte-identical wording or facts that
necessarily differ between the two users' source emails.

The local, uncommitted screenshots are retained under
`test-results/competitor-parity/`. They contain real mailbox content and are
intentionally excluded by `.gitignore`; the committed report records only
redacted semantic observations.

### Similarity Score

| Dimension | Score | Result |
| --- | ---: | --- |
| Draft workflow and control behavior | 90% | Pass |
| Draft semantic usability and safety | 92% | Pass |
| Compose hierarchy and information density | 86% | Pass |
| Visual polish and consistency | 84% | Pass |
| Overall targeted feature similarity | 88% | Pass |

The score covers the AI compose/reply feature, not unrelated mailbox surfaces.
Agentic Inbox's exact cloud-model wording is provider-dependent, so acceptance is
based on equivalent semantic conclusions and interaction behavior rather than
byte-identical prose.

## Expanded Semantic Scenarios

1. Reply “已收到” in a slightly formal tone produces a complete reply, not only
   `已收到。`.
2. Confirm meeting attendance while preserving the supplied time and requested
   preparation commitment.
3. Generate a new draft before a recipient is entered.
4. Ask for clarification instead of guessing when the instruction is only
   “第一行”.
5. Rewrite an existing draft without changing dates, completion state, or
   other facts.
6. Apply a requested output language to the next generation.
7. Preserve an explicitly requested one-line reply without forced expansion.
8. Decline formally without inventing a concrete reason.
9. Preserve an explicitly supplied deadline commitment without adding another
   commitment.
10. Ask for a missing deadline without guessing a date.
11. Never invent attachments, dates, decisions, or commitments.

## AI / Safety Review

- The server asks for a body-only, complete email and accepts structured
  `draft` or `needsClarification` output.
- A NEW draft does not reuse the user's instruction as the subject.
- Reply subject and original quoted content are retained.
- Style instructions are resolved from the saved writing-style store at
  runtime and included in the model prompt.
- Unknown styles fail validation rather than silently falling back.
- A formal request that produces only an instruction echo or unusably short
  fragment is retried once with a complete-email correction.
- Reply draft validation rejects subjects, headers, and fabricated signatures.
- Writing processors and agent tools expose no direct send path.

## Durable Draft Review

Local compose saves are projected from `mail_drafts` into the normal Drafts
folder list, detail view, and count. Reopening restores the original message
link and rich HTML markers. Delete/send cleanup can remove the local draft.

## Verification

- `npm run typecheck` — passed
- `npm run typecheck:server` — passed
- `npm run build:desktop` — passed
- `npm run test:renderer` — 84 files, 586 tests passed
- `npm run test:server` — 1666 passed, 1 skipped, 0 failed
- `npm run test:e2e` — 6 Electron tests passed
- Live Agentic Inbox / WeMail same-prompt run — 6/6 semantic conclusions matched
- Desktop AI-draft acceptance — 19/19 checks passed:
  - formatting toolbar starts collapsed
  - formatting control opens and closes the toolbar
  - empty-recipient drafting
  - Shift+Enter
  - clarification body preservation
  - complete new draft
  - no instruction-as-subject
  - prompt recall
  - quick actions after first generation
  - version chain
  - style regeneration / fact preservation
  - unusably short formal reply triggers one quality retry
  - retried formal reply is a complete email body
  - stable quoted marker
  - quoted region preservation
  - reply subject preservation
  - signature preservation
  - configured signature appears in compose
  - no mail sent

## Merge Gates

- Auto-send path: pass
- Fabricated headers/signatures: pass
- Invalid style handling: pass
- Protected compose regions: pass
- Saved draft recoverability: pass
- Typecheck/build/full test suites: pass

## Remaining Differences From Upstream

This change targets the AI compose/reply interaction, not every Agentic Inbox
product surface. WeMail keeps its own typography, coral send accent, local
provider configuration, and local draft persistence. Agentic Inbox streams through
its own cloud service, while WeMail remains provider-neutral and local-first.
Those differences do not alter the accepted draft workflow or AI capability.

## Ready for Review

Yes.
