# Design

## Harness

`tests/e2e/helpers/electronApp.ts` launches the packaged Electron entry with
`WEMAIL_E2E_MODE=1`, a temp `WEMAIL_DATA_DIR`, the file-injected mail
provider, and a local OpenAI-compatible LLM mock (system-prompt keyword
dispatch: `summarization` / `tag` / `reply-decision` / `reply-draft`;
`draft-writing` for the compose lane; `GET /v1/models` for probes). All
specs either drive the local HTTP API (login, intelligence, automation,
channels, settings) or the preload IPC seams the renderer itself uses
(`mailCore.refreshMail`/`health`, `mailDatabase.enqueueSend`).

## Runner invocation

`scripts/run-e2e.mjs` rebuilds the better-sqlite3 binding for Node at the
end, which breaks subsequent desktop launches on Windows dev machines. When
`dist-electron` is fresh, invoke Playwright directly
(`node node_modules/playwright/cli.js test`). The quick main rebuild
(`npm run build:desktop:main:quick`) refreshes the binary without touching
the renderer build or native bindings — required after any
`electron/**`/`server/**` change or the AI worker pool silently stops
consuming intelligence jobs (observed 2026-11-14).

## Contracts-first assertions

Boundary specs assert the *observed product contract* rather than an
idealized one (e.g. unknown channel profile bindings return a lenient 200,
run history blocks permanent delete with 409 + references). When a test
reveals an undocumented contract, it is either fixed in product code (LLM
settings probe round-trip) or captured as the assertion of record.

## Live-instance tooling

`scripts/live-send-regression.mjs` connects over CDP to the running desktop
instance (`--remote-debugging-port=9223`), uses the renderer's own preload
seam (`mailDatabase.enqueueSend`), and verifies delivery through the
canonical folder list (server-side Sent APPEND copy). It is
guarded (`--confirm-real-send`), manual-only, and never wired into CI.

## Model configuration note

The compose lane enforces a 25s client budget and a 1200-token cap; heavy
reasoning models (glm-5.3-flash, hy4free without effort controls) burn the
budget on invisible reasoning. Configure `reasoningEffort: "none"` for
such models, or pick a non-reasoning default (glm-5.2).
