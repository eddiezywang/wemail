# AI Semantic Search QA - Tasks

## Implementation

- [ ] Write failing repository tests for account-isolated semantic index rows.
- [ ] Write failing tests for incremental indexing after new/updated mail.
- [ ] Write failing route tests for `GET` or `POST /api/mail/semantic-search`.
- [ ] Write failing QA tests that every factual claim has citations.
- [ ] Write failing fallback tests where embedding provider is unavailable and lexical search still works.
- [ ] Implement semantic index schema and repository.
- [ ] Implement chunking and indexing worker that does not block normal mail sync.
- [ ] Implement search route returning matched messages and citation-ready chunks.
- [ ] Implement `POST /api/agent/mail-qa` or equivalent agent tool with answer plus citations.
- [ ] Add at least 20 search fixtures and eval cases.
- [ ] Run focused index, search route, QA, fallback, and eval tests.
- [ ] Run `npm run typecheck:server`.
- [ ] Run `npm run test:server`.

## Execution Agent Report

```text
Change ID: ai-semantic-search-qa
Goal:
Files touched:
Spec scenarios implemented:
Tests added:
Verification commands:
Known gaps:
Risk notes:
Ready for review: yes/no
```

## Merge Gate

Block merge if cross-mail answers lack citations, index/search mixes accounts, or embedding failure breaks mail list or ordinary search behavior.
