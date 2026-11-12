# e2e-playwright Specification

## Purpose
TBD - created by archiving change wemail-pkg-m-e2e-playwright. Update Purpose after archive.
## Requirements
### Requirement: Playwright Electron E2E suite

The repository SHALL provide a Playwright-based Electron E2E suite runnable via `npm run test:e2e` that launches the composed Electron app with mocked IMAP/SMTP and LLM upstreams and isolated `userData` per test.

#### Scenario: Login flow E2E
- **WHEN** the E2E runner launches the Electron app with a blank `userData` and the user completes the login form
- **THEN** the app SHALL reach the configured state and the API health endpoint SHALL return OK

#### Scenario: Sync and summary E2E
- **WHEN** a logged-in session syncs a single mail via the mocked IMAP server and the mocked LLM returns a canned summary
- **THEN** the mail list SHALL render the message, opening the detail view SHALL show the summary card, and the DOM SHALL stabilise without timed-out polling

#### Scenario: Tag reject writes feedback
- **WHEN** the user rejects a suggested tag in the UI
- **THEN** a row SHALL appear in `mail_tag_feedback_rules`

#### Scenario: Reply draft edit and send
- **WHEN** the user edits a mocked draft and clicks send
- **THEN** an entry SHALL appear in the draft feedback log

#### Scenario: Logout preserves DB
- **WHEN** the user logs out through the UI
- **THEN** the SQLite database file SHALL still exist with previously synced rows

### Requirement: Vitest renderer suite

The repository SHALL provide a `vitest` renderer suite runnable via `npm run test:renderer` with jsdom env and `@testing-library/react`, covering at least 10 components.

#### Scenario: Renderer tests run under jsdom
- **WHEN** `npm run test:renderer` is executed
- **THEN** at least 10 component tests SHALL run under jsdom and all SHALL pass

### Requirement: No live network in tests

The E2E and renderer suites SHALL NOT make real IMAP, SMTP, or LLM network calls. All upstreams SHALL be mocked locally.

#### Scenario: Test run in offline environment
- **WHEN** the suites are executed on a host with no outbound network
- **THEN** all tests SHALL still pass

