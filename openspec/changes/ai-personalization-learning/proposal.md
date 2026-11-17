# AI Personalization Learning

## Problem

AI output should improve from user preferences and feedback, but private feedback must remain controllable, resettable, queryable, and absent from logs.

## Proposal

Extend profile settings with important contacts, default summary language, default reply tone, and signature preference. Aggregate feedback into per-feature learning summaries. Prompt builders consume profile plus learning summary. Usage statistics are grouped by stable UI buckets and processor version. Provide settings APIs to read and reset learned preferences.

## Scope

In scope: profile extensions, feedback queries, learning summaries, prompt-builder integration, usage stats, reset endpoint, tests.

Out of scope: opaque model fine-tuning and exposing raw private feedback in prompts/logs.

## Dependencies

Recommended upstream: `ai-quality-foundation`.
