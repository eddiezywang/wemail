# Automation Action Standards

Automation actions are the write side of mail rules. Keep new actions small,
explicit, and safe by default.

## Adding An Action

When adding a new `AutomationAction` type:

1. Add the shared contract in `shared/wemail/automation.ts`.
2. Add an executor branch in `server/wemail/automation/AutomationActionExecutor.ts`.
3. Add API validation if the action has required parameters.
4. Add frontend selection and display labels in:
   - `app/components/automation/AutomationRuleForm.tsx`
   - `app/components/settings/sections/SmartFiltersSection.tsx`
5. Add focused tests for persistence, execution, dry-run/run behavior, and UI
   submission when the action appears in the form.

## Action Design Rules

- Actions must be deterministic from their payload and the target mail.
- Actions must not read secrets, mailbox credentials, or message bodies unless
  the action explicitly needs the body and the behavior is covered by tests.
- Actions that move, delete, archive, spam-mark, or send mail are dangerous and
  must require explicit confirmation in run routes.
- Actions should be idempotent where practical. Running the same rule twice
  should not create duplicate labels, duplicate external side effects, or
  inconsistent flags.
- New parameterized actions must reject empty or malformed required fields.
- External actions must use `{ type: "external", adapter, input }` until a
  first-class local executor exists.

## Current Actions

- `applyLabel`: add a user-visible label. Requires non-empty `label`.
- `star`: set flagged/starred.
- `archive`: move to archive. Dangerous.
- `trash`: move to trash. Dangerous.
- `spam`: mark as spam. Dangerous.
- `notSpam`: clear spam classification.
- `markImportant`: mark as important.
- `markNotImportant`: clear important marking.
- `markRead`: mark message as read.
- `markUnread`: mark message as unread.
- `suppressTodoCreation`: prevent AI todo extraction from resurfacing the same
  todo suggestion.
- `external`: adapter-backed integration action. Use only for unsupported
  integrations and keep payloads body-free unless explicitly documented.
