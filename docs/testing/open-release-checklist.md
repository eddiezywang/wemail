# Open-edition release checklist

Use this checklist for the current open-edition commit and each distribution
you intend to publish. Record the commit, operating system, build identity,
commands, results, and unresolved failures. Passing automated checks does not
by itself establish that the packaged application works interactively.

Use a disposable mailbox and test messages, with permission to send to the
chosen recipient. Keep credentials, real mail, personal data and private
configuration out of screenshots, logs and issue reports. The explicit
`WEMAIL_E2E_MODE=1` mode uses an obfuscated test secret store, not encrypted
credential storage; use disposable credentials in that mode.

## Source and automated checks

- [ ] Review current files and untracked additions for private business logic,
  credentials, user data, screenshots and deployment-specific values.
  `npm run check:public-boundary` detects configured patterns but does not
  inspect binary content or replace human review. It scans the working tree
  for tracked and non-ignored untracked paths and fails if a tracked path is
  missing. Review and stage intended deletions before running it; also review
  the staged changes, since the check reads working-tree contents rather than
  staged blobs.
- [ ] Verify private automation extraction before publication. Invoice dataset,
  collection execution, legacy capability entries and private rule validation
  now use edition module seams. Verify the internal build, old-rule behavior,
  capability discovery and feature-switch behavior after synchronizing the
  open baseline; review the remaining public compatibility types separately.
  The automation form now receives processor and external-action declarations
  from feature-filtered edition modules. Verify the private renderer receives
  the expected controls and the open renderer receives no contributions.
  The rule service, agent and route fallbacks now use feature-filtered
  contributions; verify these paths with each feature independently disabled.
  Temporal-field discovery and validation are now scoped per composition;
  verify both enabled and disabled states through the Agent and rule editor.
  Edition prompt sections are now grouped by required features; verify each
  feature combination in the private build before publication.
  Database worker lanes now receive the same edition features; verify scene
  actions, invoice recovery and directory indexing remain disabled across
  process boundaries, and verify the enabled private paths still work.
  Legacy V1 upgrades are currently disabled: the existing commit path creates
  a second enabled rule rather than atomically replacing the original. Implement
  and verify atomic replacement and recovery before re-enabling them.
  Verify V2 edits reject missing or stale source versions before confirmation,
  and reject a source changed between confirmation and database replacement.
  Verify repeated and concurrent commits of the same V1 and V2 preview,
  including a lost response and restart, create at most one rule. Commit
  receipts currently live only as long as the preview is retained.
  Verify automatic triggers and manual execution across disable, archive and
  concurrent edits. A stale rule snapshot is rejected before a run starts;
  already-started executions are not cancelled by that check.
  The V2 direct-run endpoint now requires an account ID and no longer accepts
  caller-supplied collection or trigger context; verify any external clients
  have migrated to the manual-run contract.
  Verify displayed scheduled times and delay indicators. The current schema
  stores an occurrence key rather than a separate planned time, so only the
  standard scheduled key format can be interpreted; other keys omit the time.
  Verify simultaneous retries and process interruption. Retry claims are
  persisted before execution; an interrupted claim remains uncertain and must
  not be automatically retried without reconciliation. Running steps show an
  uncertainty warning, but no process lease currently proves interruption or
  converts abandoned runs to a terminal state after restart.
  Verify two independent database connections concurrently claim the same
  automation event: one run and one input manifest should be recorded.
  Verify thrown provider errors after retry claims leave an outcome-unknown
  record, and that later delivery reconciliation cannot mark it successful.
  Verify a manual run of a scheduled rule also pauses future scheduling when
  its outcome is unknown, including concurrent schedule execution.
  Verify the pause message and explicit reconciliation confirmation, including
  that resuming schedules only a future occurrence and never replays the
  uncertain occurrence. Check concurrent edits and disabled rules as well.
  Verify an open run-detail view refreshes retry availability after a rule
  changes. Local enable and archive actions invalidate the detail cache;
  changes from another client may require a fresh fetch even though the retry
  endpoint rejects stale actions.
  Verify legacy invoice-rule upgrade discovery and the resulting workflow with
  the invoice feature enabled and disabled. The draft now retains the processor
  capability, but equivalent inputs and behavior still require end-to-end review.
  Verify legacy upgrade delivery and content end to end. Bot delivery,
  unsupported action options, multiple actions and processor instructions are
  rejected until they can be faithfully converted. Message-center titles are
  retained, but upgrade eligibility does not prove equivalent output content.
- [ ] Verify the private invoice execution workflow extraction. The invoice
  action type, upload eligibility, item deduplication and receipt recovery
  now live in the internal repository implementation. Review the resulting
  public source and compatibility contracts. Verify existing internal queued
  and in-flight executions, recovery, and open-edition disabled behavior before
  treating this boundary as complete. Database reader and writer lanes now
  reject execution commands unless both invoice and WeCLI features are enabled
  and the allowance module is registered; audit writes remain available
  independently and must also be verified. Database lanes now request the
  internal repository through a factory with injected public dependencies.
  The old repository regression scenarios have been copied to the private
  suite and the public route test uses a port stub. Confirm the internal
  snapshot and build wiring support the new interface. After reviewing and
  committing the public changes, sync that committed revision to `open/`;
  do not hand-edit the snapshot or its generated sync manifest.
  The legacy submission backfill is migration 17, not a startup sweep; verify
  both databases upgrading through that migration and databases already past
  it, including their existing guard rows and in-flight tasks.
  Legacy direct-upload result formatting and status projection now come from
  the internal module; verify the dispatcher is registered before any upload
  starts and status changes are projected correctly. Verify a missing status
  projection blocks both dedicated actions and generic CLI dispatch before
  any external command. Verify a missing DB-lane repository factory prevents
  the durable execution service and action tools from being advertised; repeat
  with the status store, projection, dispatcher and command adapter missing.
  Legacy upload and deletion now delegate to a private dispatcher; verify
  equivalent validation, side-effect ordering and behavior
  with either feature independently disabled.
- [ ] Run `npm run verify:pr` and `npm run test:packaging` from the repository
  root. Record failures rather than treating a skipped check as a pass.
- [ ] Run `npm --prefix website run test:all` when checking the documentation
  site. Its build and raw Markdown output are separate from the desktop app.
- [ ] Review the release artifact's dependencies and notices against
  [THIRD_PARTY_NOTICES.md](../../licenses/THIRD_PARTY_NOTICES.md), including native
  libraries actually shipped. The inventory alone does not establish that
  distribution obligations are met.

## Desktop smoke checks

- [ ] Verify `answered` and `draft` flags across synchronization, local
  mutations, detail, lists and provider updates. The current changes use
  primary-instance flag bits; their end-to-end behavior remains unverified.
  In particular, check a stale provider response arriving after a pending
  flag mutation is marked applied; pending-operation overlay alone does not
  establish ordering against already in-flight sync responses.
- [ ] Build and package the target platform according to the project scripts;
  start the resulting artifact in a clean test profile. Record the artifact and
  verify the edition identity. Windows is the primary tested platform; assess
  other platforms independently.
- [ ] Connect the test mailbox, sync, read a message, and open an attachment.
  Confirm credentials are not returned in account responses. Check restart
  and sign-out behavior without deleting real user data.
- [ ] Configure a test model endpoint, confirm the UI does not reveal its key,
  and check an AI feature with test content. Check mail still works without an
  AI configuration. Model requests can contain mail content and are sent to
  the configured endpoint.
- [ ] Check a failed model-list probe still saves the settings and displays a
  connection warning; check a failed runtime reload reports that settings were
  saved and recommends restarting. Verify credential-bearing redirects are
  rejected and an address with embedded user information is refused.
- [ ] Create and review a draft. Confirm Agent-initiated sending requires user
  confirmation and cancelling causes no send. MCP clients have separate
  direct write authority. Use a disposable recipient for completed sends.
- [ ] Verify failed immediate sends appear in the scheduled-send view with
  their content and an outcome warning. Confirm failure and expired leases do
  not trigger another SMTP submission, including after restart and after a
  failure to commit a successful send. Delivery may remain ambiguous and must
  be reconciled before another attempt; a stable Message-ID does not guarantee
  SMTP deduplication. Check that users can discover the view and recover text.
- [ ] Verify a lost enqueue response cannot cause duplicate immediate sends.
  The compose window reuses its idempotency key for an unchanged retry, and
  pending immediate sends now appear in the queue. The key is not retained
  after closing or restarting the window; verify reconciliation before retry.
- [ ] With automatic mailbox synchronization disabled, confirm a scheduled
  send becomes eligible near its requested time and an abandoned send lease
  becomes visible as uncertain after a restart. The account worker performs
  periodic queue sweeps while it is ready.
- [ ] Verify reply threading before release, including saved drafts, scheduled
  replies, reply-all and forwards. The queue now freezes reply headers, but
  local sent-message grouping and interoperability with real providers remain
  unverified. Replies without a usable source Message-ID are rejected.
- [ ] Verify a partial SMTP acceptance remains visible after reopening the sent
  message and after restarting the app. Confirm rejected recipients are clearly
  surfaced; persistence alone does not provide an active failure notification.
- [ ] Open a message containing remote images and links. Confirm images and
  links follow the documented policies, and inspect shared diagnostics for
  sensitive data before attaching them to an issue.
- [ ] If shipping optional Bot or MCP features, check configured and disabled
  paths with dedicated test identities. Do not infer end-to-end behavior from
  process startup or an HTTP status alone.
- [ ] Check local Claude Code delegation is unavailable by default and appears
  only after explicitly enabling `WEMAIL_ENABLE_LOCAL_CLAUDE_CODE=1`. Verify
  the user-facing description states that the CLI bypasses permission prompts.

## Disclosure and publication

- [ ] Verify the private vulnerability reporting channel described in
  [SECURITY.md](../../.github/SECURITY.md) is available before publication, and record
  the known local API trust boundary described there.
- [ ] Review release notes and published documentation against the actual
  artifact. Do not advertise private-edition features or an unverified download.
- [ ] Keep failed checks, unverified platforms and known limitations visible to
  reviewers; repeat affected checks after subsequent changes.
