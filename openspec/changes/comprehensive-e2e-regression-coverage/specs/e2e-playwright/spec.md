# Delta: e2e-playwright

## MODIFIED Requirements

### Requirement: Playwright Electron E2E suite

The repository SHALL provide a Playwright-based Electron E2E suite runnable
via `npm run test:e2e` (or `playwright test` against an existing
`dist-electron` build) that launches the composed Electron app with mocked
IMAP/SMTP/LLM upstreams and an isolated temp data directory per test. The
suite SHALL exercise the canonical mail runtime (preload
`mailDatabase`/`mailCore` IPC seams) rather than the removed legacy
`/api/mail/*` HTTP surface, and SHALL keep every LLM lane behind the local
mock responder (dispatch on system-prompt keywords; `GET /v1/models` served
for probes).

#### Scenario: Login flow E2E

- **WHEN** the runner logs a fixture account in through the account API
- **THEN** the workbench renders and `/api/account/current` reports the saved account

#### Scenario: Reply send via canonical outbox E2E

- **WHEN** the test sends a reply through the renderer seam
      (`mailDatabase.enqueueSend`) against the file-injected provider
- **THEN** the mail-core account runtime claims the send and the provider
      writes a `file-injected-*.json` payload containing the recipient,
      subject, and body into `<dataDir>/mock-outbox/`

#### Scenario: Logout preserves canonical mail

- **WHEN** the account logs out and the app re-opens on the same data
      directory with the mock-inbox fixtures removed
- **THEN** the previously received message SHALL still be listed (persistence
      without fixture re-injection)

#### Scenario: Receipt recovery and isolated versions

- **WHEN** concurrent `refreshMail` requests and fixture injections race
- **THEN** each receipt version completes, rows deduplicate, and a restart
      preserves the mailbox

#### Scenario: Smart pipeline lanes

- **WHEN** the summary/tags retry lanes execute against the mock LLM
- **THEN** `/api/digests/summary-health` reports the tags attribute
      `succeeded`, `/api/smart-tags` stays contract-shaped, and
      `/api/digests/summary-health` items expose per-attribute states

#### Scenario: Automation template lifecycle

- **WHEN** a built-in template is validated (empty and complete
      configurations), previewed, confirmed with a tampered hash, confirmed
      with the real hash, run manually, dry-tested, and deleted
- **THEN** validation issues list required fields, the hash-tamper confirm
      returns 409, a fresh install deletes with 200, and an automation with
      run history is deletion-blocked with 409 and a references array while
      remaining listed

#### Scenario: Channel hub state

- **WHEN** the suite queries `/api/channels/status`,
      `/api/channels/platform-configurations`, and `/api/channels/profiles`
      with `WEMAIL_CHANNELS_ENABLED=1` and a logged-in account
- **THEN** the registry contains the `wecli`, `feishu`, and `wecom` entries
      with labels and states, and the configuration/profiles endpoints
      answer structurally

#### Scenario: Usage ledger and assistant

- **WHEN** the suite reads the usage buckets, drives one summary lane and one
      AI compose draft
- **THEN** all seven canonical usage categories are present, the summary
      category call count increases, usage-stats answers with per-model
      breakdowns, and the agent conversations/tools/suggestions endpoints
      respond

## ADDED Requirements

### Requirement: LLM settings boundary hardening

LLM settings writes SHALL validate payloads with structured 400s (missing
`defaultModel`, missing `apiKey` with no stored credentials, malformed JSON),
SHALL save gracefully against an unreachable endpoint with
`probe.ok=false` and `manualSave=true`, and SHALL round-trip the persisted
configuration.

#### Scenario: Unreachable endpoint manual save

- **WHEN** a config pointing at a closed port is saved
- **THEN** the response is `ok=true` with a failed probe and the settings
      round-trip returns the persisted baseUrl

### Requirement: Compose boundary hardening

The compose route SHALL reject invalid requests with structured codes
(`INTENT_REQUIRED`, `INVALID_OPERATION_TYPE`, `SOURCE_MESSAGE_REQUIRED`,
`SOURCE_MESSAGE_NOT_FOUND`), SHALL surface model clarification requests as
`needsClarification` with questions, and SHALL map malformed LLM output to a
retryable `AI_COMPOSE_FAILED` 502 instead of crashing.

#### Scenario: Malformed draft LLM output

- **WHEN** the draft lane returns non-JSON text
- **THEN** the compose route returns 502 `AI_COMPOSE_FAILED` and the audit
      log records the failure reason

### Requirement: Intelligence retry argument hardening

`POST /api/digests/summary-retry` SHALL default unknown modes to `all`,
slice `kinds` to the four canonical values, cap `emailIds` at 500, and drive
a malformed-LLM tags lane to a `failed` attribute state (never stuck
pending).

#### Scenario: Malformed tags lane converges

- **WHEN** the mock tags lane returns invalid JSON and the retry runs
- **THEN** the affected message's `tags` attribute reaches `failed` within
      the suite window

### Requirement: Mail intake boundary hardening

The file-injected provider SHALL skip corrupt fixtures, SHALL deduplicate
identical messages injected under multiple filenames, and SHALL isolate
`refreshMail` calls for unknown accounts (`account-unavailable`) without
disturbing the active account runtime.

#### Scenario: Corrupt fixture skipped

- **WHEN** `not-json{{{` and `{}` fixtures land in the mock inbox and a
      refresh runs
- **THEN** the message count is unchanged and the account runtime stays
      ready

### Requirement: Read API boundary hardening

Read endpoints SHALL return structured 400/404s for invalid parameters and
unknown ids (semantic search account/query/limit/offset, application
messages accountId, insight reports unknown id, smart-tag promotions and
restore-original, todos unknown-id mutations, unknown channels setup ids),
SHALL clamp summary-health pagination, SHALL answer unknown channel profile
bindings leniently with 200, and SHALL answer unknown top-level API routes
with a structured 404.

#### Scenario: Unknown ids never 500

- **WHEN** unknown todo/tag/message/report/channel ids are read or mutated
- **THEN** responses are structured 4xx (or lenient 200 empty) and never 500

### Requirement: Live send regression tool

The repository SHALL provide `scripts/live-send-regression.mjs`, a
manual-only tool guarded by a `--confirm-real-send` flag that drives the
running desktop instance over CDP (`--remote-debugging-port=9223`) to send
a real email through the canonical outbox and verify the server-side Sent
folder APPEND copy appears in the canonical folder list. The automated
hermetic suite SHALL never invoke it.

#### Scenario: Guarded execution

- **WHEN** the tool runs without `--confirm-real-send` or without a
      recipient
- **THEN** it prints usage and exits non-zero without sending

#### Scenario: Real send verification

- **WHEN** the tool sends to an authorized recipient mailbox
- **THEN** `enqueueSend` commits an outbox id and message-id header, empty
      recipient attempts are rejected with `send-recipient-required`, and the
      Sent folder APPEND copy is observed in the canonical folder list
