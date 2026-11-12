# AI Automation Rule Suggestions - Design

## Suggestion

Suggestions create drafts only. The draft contains conditions, actions, rationale, and `enabled=false`.

## Dry Run

Dry-run evaluates the draft against current mail and returns matched email ids, match reasons, and actions that would run. It does not mutate mail.

## Run

Run writes audit logs with matched and applied counts. Dangerous actions require an explicit confirmation parameter.
