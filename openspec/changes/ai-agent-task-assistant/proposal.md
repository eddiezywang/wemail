# AI Agent Task Assistant

## Problem

The agent should behave like a context-aware mailbox assistant, not a static tool launcher. It must ground answers in tool results, adapt suggestions to current intelligence state, and keep high-risk actions pending for user confirmation.

## Proposal

Make agent suggestions state-aware for current email/account/thread context. Add citations referencing email ids, tool names, and result paths. Return `pendingAction` for send/delete/move/automation or other high-risk operations instead of executing them. Improve missing-context and tool-error responses.

## Scope

In scope: agent route/tool behavior, state-aware suggestions, citations, pending high-risk actions, audit caller source, scripted planner tests.

Out of scope: new autonomous background agent loops and direct dangerous action execution.

## Dependencies

Recommended upstream: `ai-quality-foundation`. Coordinate with writing, todo, translation, and search changes when those tools exist.
