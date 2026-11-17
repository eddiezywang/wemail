# Acceptance

## Automated suite

- Command: `node node_modules/playwright/cli.js test` (against existing
  `dist-electron`; `npm run test:e2e` for the full build path)
- Result: **19 specs / 19 passed** (~9–10 minutes, workers=1)
- Specs: 00 renderer-health, 01 login, 04 reply-send, 05 logout persistence,
  06 automation center, 07 click performance, 08 receipt recovery,
  09 smart-tags, 10 channels, 11 usage+assistant, 12 llm-settings boundary,
  13 boundary regression, 14 intake boundary, 15 read-API boundary,
  16 automation template lifecycle, 17 remaining surfaces
  (02 retired; no 03 — tag-reject legacy scenario superseded by 09's
  pipeline assertions)
- Known benign quirk: one `Worker teardown timeout` worker error per full
  run, not attached to any test; present before this change; exit code
  unaffected.

## Contracts captured as assertions

| Contract | Assertion |
|---|---|
| Unknown account `refreshMail` | `status: "account-unavailable"`, active runtime untouched |
| Unknown channel profile bindings | lenient `200` empty payload |
| Automation with run history | permanent delete `409` + `references[]`, stays listed |
| Fresh automation install | permanent delete `200` |
| Preview-hash tamper on confirm | `409` |
| Empty recipients on `enqueueSend` | `send-recipient-required` rejection |
| Malformed draft LLM output | `502 AI_COMPOSE_FAILED` |
| Malformed tags LLM output | tags attribute `failed` (not pending) |

## Live verification (manual, outside the hermetic suite)

- LLM gateway: Sub2Agent RPC source activation (WorkBuddy subscription →
  `hy4free`), `reasoningEffort=none` to keep compose inside its 25s budget.
- Compose end-to-end through the running instance: EN draft 5.4s,
  CN draft 3.7s (correct recipient/subject on REPLY of a real alert mail).
- Real SMTP outbound via `scripts/live-send-regression.mjs` to the
  authorized 163 test mailbox: enqueued, empty-recipient boundary rejected,
  server-side Sent APPEND copy observed (new Sent folder, totalCount=1).
- Agent chat with a real tool call (`list_mail`) returning grounded,
  cited unread-alert subjects.
- AI backlog processing on the live mailbox observed via usage ledger
  (summary/tags/todo calls + tokens) and per-message AI artifacts.

## Deferred coverage (tracked in tasks.md §6)

Workbench/compose UI interaction packs, agent confirm→execute chain,
notification click-through, scheduled send, template upgrade/rollback,
settings sections, native bridge pack, multi-account fixtures.
