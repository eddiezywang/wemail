# AI Priority Reply Decision

## Problem

Users need to know which mail deserves attention and whether it requires a reply before any drafting happens. A score alone is not useful; the decision must be explainable and deterministic for stored inputs.

## Proposal

Add or extend `PriorityResult` with priority score, level, reason, reply-required decision, optional deadline, and signals. Align existing `replyDecision` with priority, use sender/directness/deadline/question/history/category signals, and explicitly avoid draft generation.

## Scope

In scope: priority/reply decision processor, route/tool state-aware results, fixtures/eval, no-draft guard.

Out of scope: generating reply drafts and UI priority sorting redesign beyond API support.

## Dependencies

Recommended upstream: `ai-quality-foundation`; coordinate with `intelligence-bus-productization` reply decision split if active.
