# AI Classification Inbox Tabs - Design

## Taxonomy

Built-in category ids are language-independent:

- `important`
- `action_required`
- `newsletter`
- `marketing`
- `receipt`
- `notification`
- `personal`
- `other`

Dynamic tags remain available, but required system categories are always returned first and cannot be replaced by dynamic categories.

## Feedback Suppression

Rejected categories/tags create suppression signals keyed by account, sender/domain, normalized subject pattern, and category id. Future similar mail should omit the suppressed suggestion unless strong contrary evidence exists.

## Handoff

Change ID: `ai-classification-inbox-tabs`
Goal: stable category navigation and account-isolated category filtering.
