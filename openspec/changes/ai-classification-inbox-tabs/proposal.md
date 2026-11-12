# AI Classification Inbox Tabs

## Problem

Inbox navigation cannot depend on unstable dynamic tag labels. Users need stable built-in categories such as important, action required, newsletters, marketing, receipts, notifications, personal, and other, while still benefiting from dynamic AI tags.

## Proposal

Define a canonical system taxonomy and expose category tabs through `GET /api/intelligence/categories`. Support `GET /api/mail/messages?category=...` for system categories and dynamic tags. Persist classification reason/confidence and feed user accept/reject into feedback suppression.

## Scope

In scope: canonical taxonomy, category counts, mail filtering, feedback suppression by sender/subject pattern, fixtures/eval, route tests.

Out of scope: full personalization learning beyond suppression; complex UI redesign.

## Dependencies

Recommended upstream: `ai-quality-foundation`.

## Success Criteria

- At least 30 classification fixtures.
- Newsletter, marketing, notification, and receipt accuracy at or above 85%.
- Category counts match actual filtered results and are account-isolated.
