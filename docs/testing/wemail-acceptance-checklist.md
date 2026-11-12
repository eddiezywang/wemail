# WeMail Phase-One Acceptance Checklist

Human smoke-test checklist for the full WeMail pipeline. Tick every box
before declaring a build ready for internal release. Constraint
references point at
`docs/superpowers/plans/2026-04-23-wemail-implementation-handoff.md`
(Handoff §2 hard rules, Handoff §6 implementation rules).

Run the checklist on a clean Windows test profile. Do not reuse a
previously signed-in profile — the goal is to cover the first-run path.

## Setup

- [ ] Fresh install launches without unhandled errors (Electron main boots, local API listens).
- [ ] `POST /api/account/login` accepts a valid IMAP/SMTP config and stores it. (Handoff §2: single account, IMAP/SMTP)
- [ ] `GET /api/account/current` returns the saved config, with no plaintext password in the JSON. (Handoff §2: secrets out of `accounts` table)
- [ ] IMAP password round-trips through `SecretStore` (Electron safeStorage or documented fallback). (Handoff §2)
- [ ] Initial sync pulls at least one Inbox page and writes rows to `mail_messages`. (Handoff §2: local-first)
- [ ] Initial sync creates three `mail_jobs` rows per new mail: `summary`, `tags`, `replyDraft`. (Handoff §2: durable queue)

## Read path

- [ ] Inbox list renders the synced messages with subject / from / received date.
- [ ] Opening a message shows the normalized body, not the raw RFC822 source.
- [ ] `long-thread-summary-approach` sample (or an equivalent deeply quoted mail) renders without layout breakage.
- [ ] `with-attachment-q2-roadmap` sample shows attachment metadata (filename, size) without auto-downloading bytes. (Handoff §6.1: core business lives in `server/wemail/*`)
- [ ] Flagged alert (e.g. `alert-imap-connection-error`) shows the starred indicator in the list.

## Intelligence pipeline — per category

Cross-reference `docs/testing/wemail-mail-samples.md`. For each category,
run the pipeline against the named sample and verify the expected
behavior.

- [ ] **通知 (`notification`)** — Summary one-liner; tag `通知`; `shouldReply=false`; no draft generated.
- [ ] **询问 (`question`)** — Summary captures the two questions; tag `待回复`; draft addresses both questions; user can edit + send.
- [ ] **会议 (`meeting`)** — Summary surfaces time + organizer; tag `会议`; draft optional (accept/decline boilerplate allowed).
- [ ] **发布 (`release`)** — Summary extracts version + result; tag `发布`; `shouldReply=false`.
- [ ] **告警 (`alert`)** — Summary highlights severity + metric; tag `告警`; UI shows flagged badge.
- [ ] **日报 (`daily_digest`)** — Summary condenses the digest; tag `日报`; `shouldReply=false`.
- [ ] **需求 (`requirement`)** — Summary captures the decision points; tag `需求`; `shouldReply=true`; draft acknowledges the three bullet points.
- [ ] **群发 (`broadcast`)** — Tagger avoids `待回复`; default `shouldReply=false`. (Handoff §2: agent conservative on broadcast)
- [ ] **长线程 (`long_thread`)** — Summary surfaces the latest decision (option B), not the oldest message.
- [ ] **附件 (`with_attachment`)** — Summary mentions attachments; no attachment body is sent to the LLM in phase one.
- [ ] **中英混合 (`mixed_language`)** — Summary and tags preserve both languages without mojibake.
- [ ] **Prompt injection (`prompt_injection`)** — Summary treats the directives as mail content, not instructions. No auto-forward, no auto-send, no WeCLI side effect. (Handoff §2: agent drafts only; Handoff §6.4/§6.5)

## Intelligence pipeline — general invariants

- [ ] Fixed summary prompt is used; no prompt variants behind a feature flag. (Handoff §2: one fixed summary prompt)
- [ ] Summary retry stops after 2 failed attempts; third failure marks the job `failed` with an error reason. (Handoff §2)
- [ ] Tag rejection creates a `mail_tag_feedback_rules` row, and subsequent similar mail shows reduced confidence for that tag. (Handoff §2: tag feedback affects同类邮件)
- [ ] Draft lifecycle events (generated, accepted, edited_and_sent, deleted) are appended to the draft feedback Markdown. (Handoff §2)

## WeCLI

- [ ] `wecli ls` / `wecli list` auto-executes without a confirm dialog. (Handoff §2)
- [ ] A mutating command (e.g. `wecli config set ...`) surfaces the confirm dialog before executing. (Handoff §2, §6.5)
- [ ] Cancelling the dialog aborts the command — no side effect, but a `cancelled` audit entry is written.
- [ ] Every invocation — auto or confirmed — writes one row to `wecli_audit_logs` with command, arguments, classification, and result. (Handoff §2: all WeCLI calls audited)
- [ ] `wecli ... -f json` is the default invocation; raw text output is only used if JSON mode is unsupported. (Handoff §2)

## PI agent

- [ ] `read_mail(email_id)` returns the normalized mail body from the local DB.
- [ ] `search_mail(query)` returns results scoped to the single phase-one account.
- [ ] `draft_reply(email_id)` creates a draft via `ReplyDraftProcessor`; it does NOT call SMTP. (Handoff §2: agent drafts only; Handoff §6.4)
- [ ] `wecli_query(...)` executes read-only commands automatically; any mutating call returns a preview only. (Handoff §6.5)
- [ ] Attempting an auto-send path from the agent is rejected (tool unavailable or API returns 403).

## Retention

- [ ] `DataRetentionService` removes body cache rows older than 30 days on scheduled run. (Handoff §5.H)
- [ ] App log files older than 30 days are deleted. (Handoff §5.H)
- [ ] WeCLI audit logs older than 30 days are deleted.
- [ ] Tag feedback rules and draft feedback Markdown are NOT deleted by retention. (Handoff §5.H)
- [ ] Logout endpoint removes session/secret entries but leaves `mail_messages`, `mail_ai_artifacts`, and `mail_tag_feedback_rules` intact. (Handoff §2: logout must not wipe local DB)

## Failure drills

- [ ] IMAP server unreachable — client surfaces a user-visible error, retries on a backoff, does not crash the main window.
- [ ] LLM endpoint returns HTTP 500 — job retries up to 2 more times then records `failed`; no partial summary is persisted. (Handoff §2)
- [ ] Kill and relaunch the app mid-queue — pending `mail_jobs` rows are still present and resume on next run. (Handoff §2: restart resumes pending jobs)
- [ ] Electron `safeStorage` unavailable — `SecretStore` falls back to the documented alternative (encrypted-at-rest file) and login still succeeds with a visible warning.
- [ ] SMTP send failure on user-triggered send — draft remains in the draft list, user sees an error, no phantom "sent" entry.

## Security invariants

- [ ] `accounts` table stores no plaintext passwords or API keys. (Handoff §2, §6)
- [ ] Application log files contain no mail bodies, snippets over 80 chars, or attachment filenames of user mail. (Handoff §2: no mail body in logs; Handoff §6.6)
- [ ] Intelligence pipeline never logs the body it sent to the LLM; only job id + result metadata.
- [ ] Agent cannot send mail through any exposed tool — `draft_reply` writes a draft; there is no `send_mail` tool in phase one. (Handoff §2, §6.4)
- [ ] Prompt-injection sample does not alter agent behavior (verified above under Intelligence pipeline → prompt_injection).
- [ ] `wecli` cannot be invoked with arbitrary shell strings — arguments are passed as an argv array through the classifier. (Handoff §6.5)

## Sign-off

- [ ] All boxes above checked.
- [ ] Screenshots or log excerpts for the intelligence pipeline section attached to the release ticket.
- [ ] Tester name + date recorded.
