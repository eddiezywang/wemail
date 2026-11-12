# AI Summary Thread Quality

## Problem

Single-message bullet summaries are not enough for a personal inbox. Users need to understand what a mail or thread says, whether it needs action, the next step, and which source messages support the answer.

## Proposal

Upgrade summaries to support email-level and thread-level modes with structured output: `bullets`, `actionItems`, `urgency`, optional `risks`, optional `openQuestions`, and `evidenceRefs`. Respect `AiProfileSettings.summaryLanguage`, handle long content with explicit truncation/compression, and make retry idempotent.

## Scope

In scope: existing summary API compatibility, thread summary backend capability, processor validation, fixtures/eval, route retry/trigger states.

Out of scope: complex thread-summary UI and cross-account thread stitching.

## Dependencies

Recommended upstream: `ai-quality-foundation`.

## Success Criteria

- At least 20 summary fixtures cover normal mail, long threads, marketing, notifications, Chinese, English, and empty body.
- Golden eval has 100% JSON validity, action-item false positives for non-actionable mail at or below 10%, and Chinese profile language hit rate at or above 95%.
- Route tests cover trigger, retry, success, failed, and skipped.
