# Proposal: Comprehensive E2E Regression Coverage

## Why

The canonical mail database migration (`38f55046` — removal of the legacy
`/api/mail/*` HTTP surface) silently invalidated three legacy E2E specs
(02-sync-detail-summary, 04-reply-draft-edit-send, 05-logout-preserves-db):
they kept calling endpoints that no longer exist and had been failing without
being re-baselined. A global feature audit across all 14 renderer routes,
40+ component directories, 30 hooks, and the 27-capability preload bridge
then showed that frontend-interaction and boundary coverage was near zero
while core server pipelines had no maintained regression net at all.

Additionally, the live deployment now runs against a locally configured LLM
gateway (Sub2Agent → hy4free/GLM), which required live-instance verification
flows (real SMTP outbound, model switching) that the hermetic suite cannot
express.

## What Changes

- Replace the legacy spec set with a canonical-runtime suite of 19 Playwright
  Electron specs (all hermetic: mocked IMAP/SMTP/LLM, isolated temp data dirs):
  - Core pipelines: renderer health, login, reply send via canonical
    `enqueueSend`, logout persistence without fixture re-injection,
    receipt recovery, smart-tags/summary pipeline, click performance.
  - Feature surfaces: automation workbench, channels hub
    (WeCLI/飞书/企业微信), usage ledger + assistant.
  - Boundary suites: LLM settings validation, compose validation /
    clarification / malformed-LLM, summary-retry argument hardening,
    intake corruption/dedup/unknown-account, read-API validation and
    unknown-id surfaces.
  - Automation template full lifecycle: validate → preview → hash-tamper
    guard → install → clean delete (200) → re-install → manual run →
    dry-test → run-history delete block (409 + references).
- Add `scripts/live-send-regression.mjs`: a guarded manual tool that drives
  the running desktop instance over CDP to send a real email and verify the
  server-side Sent APPEND copy. Never executed by the automated suite.
- Capture the contracts discovered during regression authoring as
  assertions (unknown-account refresh → `account-unavailable`; unknown
  channel profile bindings → lenient 200; run history blocks permanent
  delete with 409 + references; preview-hash tamper → 409; empty
  recipients → `send-recipient-required`).

## Impact

- Specs: `specs/e2e-playwright/spec.md` (modified + added requirements)
- Code: `tests/e2e/**` (19 specs, helpers, fixtures), 
  `scripts/live-send-regression.mjs` (new, manual-only)
- Mirror: suite and OpenSpec change are synced into the closed-source
  repository (`wemail-int/open/tests/e2e`, `wemail-int/open/openspec/changes/`)
  so regression assets live where the packaged product is built.
