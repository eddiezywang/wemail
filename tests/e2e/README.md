# WeMail E2E Tests

Playwright-driven Electron end-to-end specs (canonical mail runtime era).

## Run

```bash
npm run test:e2e           # builds renderer + electron main, then runs headless
node node_modules/playwright/cli.js test   # run against an existing dist-electron build
npm run test:e2e:headed    # attached window
```

Note: `scripts/run-e2e.mjs` rebuilds `better-sqlite3` for the Node runtime at
the end, which breaks subsequent desktop dev launches on this machine. When
`dist-electron/` is already fresh, prefer invoking Playwright directly.

## Specs

| File | What it covers |
|------|----------------|
| `00-renderer-health.spec.ts` | Desktop launches the production renderer without a white screen |
| `01-login-flow.spec.ts` | Unlogged → save account → API reports it |
| `04-reply-draft-edit-send.spec.ts` | Reply send: renderer-seam `enqueueSend` → mail-core claim → mock SMTP outbox |
| `05-logout-preserves-db.spec.ts` | Logout + restart preserves canonical mail (fixture re-injection removed) |
| `06-automation-center.spec.ts` | Unified Automation Center reachable, built-in templates shown |
| `07-canonical-mail-click-performance.spec.ts` | Cached detail clicks p95 < 300ms via canonical DB Service |
| `08-mail-receipt-recovery.spec.ts` | Isolated receipt versions + restart recovery |
| `09-smart-tags.spec.ts` | Smart tags + summary lanes land via the AI worker pool |
| `10-channels.spec.ts` | WeCLI / 飞书 / 企业微信 channel hub status, platform configs, profiles |
| `11-usage-and-assistant.spec.ts` | Usage ledger buckets + LLM usage recording, assistant endpoints, AI compose draft |
| `12-llm-settings-boundary.spec.ts` | LLM settings: validation 400s, unreachable-endpoint manual save, probe round-trip |
| `13-boundary-regression.spec.ts` | Compose validation/clarification/malformed-LLM, summary-retry hardening, usage + agent 400s |
| `14-intake-boundary.spec.ts` | Intake: corrupt fixtures skipped, duplicate message dedup, unknown-account refresh isolation |
| `15-read-api-boundary.spec.ts` | Read API: search/todos/smart-tags/channels/messages validation, unknown ids, clamped pagination |
| `16-automation-template-lifecycle.spec.ts` | Template lifecycle: validate → preview → hash-guard → install → run → dry-test → delete contracts |
| `17-remaining-surfaces.spec.ts` | Skills/configuration/directory/insight/attachments/invoice/remote-image/qa smoke + validation |

## Fake infrastructure

- **IMAP/SMTP**: `FileInjectedMailProvider` reads `<dataDir>/mock-inbox/*.json`
  and writes outbox to `<dataDir>/mock-outbox/`. Activated when
  `WEMAIL_E2E_MODE=1` is set (electron/main/local-api.ts honors this).
- **LLM**: each test spawns a local HTTP mock returning canned JSON. The URL
  is passed to the app via `WEMAIL_LLM_BASE_URL`. The bundled responder
  dispatches on system-prompt keywords (`summarization`, `tag`,
  `reply-decision`, `reply-draft`); the compose lane matches
  `draft-writing` and must satisfy `COMPOSE_DRAFT_JSON_SCHEMA`.
- **Channels** (spec 10): mounted only with `WEMAIL_CHANNELS_ENABLED=1`
  (set inside the spec); `/api/*` requires a logged-in account.

No real IMAP/SMTP/LLM traffic is ever produced.

Known benign quirk: after a full run, Playwright may print one
`Worker teardown timeout` error that is not attached to any test — tests and
exit code are unaffected.

## Adding regression cases

Boundary cases belong in `12`/`13` following the existing pattern:
`launchElectron` (hermetic temp data dir) → drive the local HTTP API or the
preload IPC seam → assert structured status codes/states. The mock LLM serves
`GET /v1/models` (probe) and dispatches `POST /v1/chat/completions` on
system-prompt keywords — extend `startMockLlm`/responder in
`helpers/electronApp.ts` for new lanes.
