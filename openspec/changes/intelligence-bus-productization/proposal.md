# Intelligence Bus Productization

## Problem

The intelligence pipeline (Packages C/E/F/G) is technically functional: new mail triggers three parallel LLM jobs (summary, tags, replyDraft), results land in `mail_ai_artifacts`, and the queue handles retries with leases. However, the current system has critical gaps between "runs" and "product-ready":

1. **Reply draft is a single monolithic job** — `ReplyDraftProcessor` bundles the "should reply?" decision with draft generation into one LLM call. This wastes model cost on obviously non-reply mail, and provides no structured way to explain to the user why a draft was or wasn't generated.

2. **No local pre-screening** — Every incoming mail hits the LLM for all three jobs regardless of obvious signals (noreply@ senders, bulk headers, system notifications). This is expensive and slow.

3. **`skipped` state is declared but never implemented** — `IntelligenceStatus` includes `"skipped"` but `JobStatus` does not, and no code path ever produces a skipped outcome. Pre-screened mail and model-not-configured scenarios have no clean terminal state.

4. **No feedback-driven tag confidence** — Tag rejection creates rules but tag confirmation and manual tagging don't influence AI behavior. The `promote` action is stored but never applied.

5. **Frontend has no visibility into pipeline state** — No loading indicators for in-progress intelligence, no retry affordances for failed summaries, no global prompt when LLM is unconfigured.

6. **Architecture doesn't support easy extensibility** — Adding a new intelligence capability requires touching shared types, job repository, bus registration, queue runner config, and composition root. The coupling is too high for a system that should support incremental capability additions.

## Proposal

Productize the intelligence bus into a layered, extensible architecture that cleanly separates concerns:

**Layer 1 — Mail Sync** (unchanged): `Mail Core sync worker` emits `new-mail` events.

**Layer 2 — Intelligence Orchestrator** (new): Replaces `MailIntelligenceBus` with a smarter orchestrator that:
- Applies local pre-screening rules before enqueuing any LLM jobs
- Manages the fan-out strategy per mail (which capabilities to activate)
- Handles the conditional dependency: `replyDecision` → (if shouldReply) → `replyDraft`

**Layer 3 — Capability Processors** (evolved): Each intelligence capability is an isolated unit:
- `SummaryProcessor` (mostly unchanged)
- `TagProcessor` (add confidence tier logic: auto-apply vs suggest)
- `ReplyDecisionProcessor` (new — split from ReplyDraftProcessor)
- `ReplyDraftProcessor` (simplified — only generates draft, no decision logic)
- `LocalPrescreener` (new — rule-based, no LLM, fast)

**Layer 4 — Result & Feedback** (evolved): Clean result storage with status awareness, feedback recording, and query APIs that support the frontend's state needs.

### Key Decisions (from product discussion)

1. **replyDraft splits into replyDecision + replyDraft** — Two-step: decision first, draft only if needed
2. **Light dependency model** — summary/tags/replyDecision enqueue in parallel; replyDecision can optionally use summary if available
3. **Hybrid tag strategy** — High confidence (≥0.85) auto-applies; low confidence shows as "suggested"
4. **Summary at mail bottom** — Collapsible card; failed state shows retry button
5. **Silent failures for tags and drafts** — No error indicators; summary gets retry button
6. **Model unconfigured = global prompt** — All jobs skip, UI shows setup guidance
7. **Tag feedback: remove → reject rule** (implemented), confirm/manual → record only (no learning in phase one)
8. **Local pre-screening** — noreply@ senders, known notification domains, bulk headers → skip replyDecision/replyDraft

## Scope

- In scope: Orchestrator redesign, replyDecision split, local prescreener, skipped state implementation, tag confidence tiers, frontend intelligence state consumption, model-not-configured handling
- Out of scope: E2E tests (Package M), PI agent integration with intelligence results, user-defined tags, tag learning from feedback, streaming LLM responses

## Success Criteria

- New mail from noreply@/notification domains never triggers LLM for replyDecision/replyDraft
- Reply decision is a separate, inspectable result with reason and confidence
- `skipped` state works end-to-end: DB → queue → result → frontend
- Summary card shows loading/success/failed+retry states
- Tags show as "suggested" when confidence < 0.85
- Adding a new intelligence capability requires changes in exactly one processor file + one orchestrator registration (no shared type sprawl)
- Model-not-configured shows a global setup prompt, not per-email errors
