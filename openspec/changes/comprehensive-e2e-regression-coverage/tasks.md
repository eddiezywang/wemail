# Tasks

## 1. Re-baseline legacy specs (canonical runtime)

- [x] Delete `02-sync-detail-summary.spec.ts` (legacy `/api/mail/*` endpoints removed)
- [x] Rewrite `04-reply-draft-edit-send.spec.ts` onto the canonical send seam
      (`mailDatabase.enqueueSend` → mail-core claim → mock SMTP outbox)
- [x] Rewrite `05-logout-preserves-db.spec.ts` without fixture re-injection
- [x] Update `tests/e2e/README.md` spec table + maintenance guide

## 2. Feature-surface specs

- [x] `09-smart-tags.spec.ts` — smart tags + summary lanes via AI worker pool
- [x] `10-channels.spec.ts` — WeCLI/飞书/企业微信 hub status, configs, profiles
- [x] `11-usage-and-assistant.spec.ts` — usage ledger buckets + usage recording,
      assistant endpoints, AI compose draft
- [x] `16-automation-template-lifecycle.spec.ts` — validate → preview →
      hash-tamper 409 → install → clean delete 200 → re-install → run →
      test → run-history delete block 409 + references

## 3. Boundary suites

- [x] `12-llm-settings-boundary.spec.ts` — validation 400s, unreachable
      endpoint manual save, probe round-trip (harness mock gained
      `GET /v1/models`)
- [x] `13-boundary-regression.spec.ts` — compose validation codes,
      clarification path, malformed-LLM 502, summary-retry hardening
      (mode/kinds/emailIds flood), usage + agent 400s
- [x] `14-intake-boundary.spec.ts` — corrupt fixtures skipped, duplicate
      dedup, unknown-account refresh isolation
- [x] `15-read-api-boundary.spec.ts` — semantic-search validation,
      summary-health clamps, todos/smart-tags/channels/messages unknown-id
      surfaces, unknown route 404

## 4. Live-instance tooling (manual only)

- [x] `scripts/live-send-regression.mjs` — guarded real-SMTP send over CDP
      with Sent-folder APPEND verification
- [x] Live model configuration verified end-to-end (Sub2Agent RPC source
      activation → hy4free; compose 3–5s round-trip; Chinese intent OK)

## 5. Sync to closed-source repository

- [x] Sync suite to `wemail-int/open/tests/e2e/` (remove legacy `02`)
- [x] Copy `scripts/live-send-regression.mjs`
- [x] Mirror this OpenSpec change to `wemail-int/open/openspec/changes/`
- [x] Commit in `wemail-int` (main)

## 6. Future coverage (tracked, not yet implemented)

- [x] Workbench interaction pack: read/unread, star, delete, unknown-id
      isolation (spec 18, canonical IPC)
- [x] Folder switch + filters/pagination live walk (live UI batch 1)
- [ ] Bulk multi-select actions
- [x] Compose interaction pack: draft save/edit/delete + scheduled send
      queue/cancel + directory contacts smoke (spec 19)
- [ ] Rich-text editor interactions, signature injection (UI-level)
- [ ] Agent pending-action confirm→execute chain (authorized send)
- [ ] Notification click-through navigation + artifact viewer
- [x] Scheduled send queue + cancel (spec 19, canonical IPC)
- [ ] Automation template upgrade + rollback paths
- [x] Settings primary sections walk (live UI batch 3, 8 sections)
- [ ] Settings per-section deep assertions (legacy sections merged into
      account/advanced in current build)
- [ ] Native bridge pack (openExternal safety, update flow, diagnostics
      package export, certificate trust)
- [ ] Multi-account fixtures

## 8. Round 4 additions

- [x] Spec 20: automation template upgrade preview/confirm guards +
      rollback confirmation/version-conflict contracts (public error
      projection asserts the conflict class — raw codes are redacted)
- [x] package.json: declare `pinyin-pro` + `sm-crypto` runtime dependencies
      (imported by dist server code but previously undeclared; npm installs
      pruned them and broke boot)
- [x] Live UI batch 5: notification center markers + todo route
      (`tests/live/ui/05-notifications-todos.mjs`)
- [ ] Agent pending-action confirm→execute chain — requires agent
      conversation test infrastructure (mock LLM emitting valid tool-call
      sequences); deferred with justification
