# AI Agent Task Assistant - Design

## Grounding

Agent responses about mail content must come from tools and cite the result. A citation contains `emailId`, `tool`, and `path` so callers can inspect the source data.

## Suggestions

Suggestions are derived from current state:

- No summary: suggest summarizing.
- Has action items but no todos: suggest extracting todos.
- Reply required but no draft: suggest drafting.
- Foreign-language mail without translation: suggest translation.
- Account context without selected email: suggest account-level search or triage.

## Risk Boundary

The agent may propose high-risk actions as `pendingAction`, but it must not send, delete, move, archive, mark spam, unsubscribe, or run automation directly.
