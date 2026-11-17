# Unified Mail Credential Recovery Design

## Goal

Treat recognized IMAP authentication failures consistently, regardless of
mail provider. In particular, NetEase 163's `LOGIN user in black list`
response must follow the same password-update flow already used for an
expired or invalid corporate mailbox password.

## User Experience

When startup, manual, or background synchronization receives a recognized
credential failure:

1. WeMail shows a safe, specific explanation of the server response.
2. WeMail opens the existing **邮箱密码需要更新** dialog.
3. The user enters the replacement mailbox password or IMAP authorization
   code.
4. WeMail verifies the new credential against IMAP before saving it.
5. After verification succeeds, WeMail saves the credential and immediately
   runs recovery synchronization.
6. Until the credential is updated, WeMail does not keep retrying the same
   rejected login in the background.

This is one shared interaction. There is no separate 163-only dialog,
settings page, or recovery workflow.

## Recognized Errors

The credential classifier recognizes at least:

- Corporate-mail password-invalid or password-expired login responses already
  supported by the application.
- NetEase 163 IMAP login responses containing `LOGIN user in black list`.

Both normalize to `MAIL_CREDENTIAL_INVALID`. The normalized result also
contains a safe reason suitable for display:

- Corporate mail: the mailbox password is invalid or expired.
- 163: the mailbox server rejected the login with
  `LOGIN user in black list`; the password or IMAP authorization code must be
  updated.

Raw IMAP commands, usernames, passwords, and other secret-bearing details
must never be returned to the renderer.

## Data Flow

The IMAP error classifier is the single source of truth. Startup sync,
manual sync, the background watcher, and the body worker consume the same
classification.

For startup sync, the shared startup status exposes the normalized credential
error code and safe display reason. The renderer reacts to that status by
dispatching the same mail-auth-required event already handled by
`MailCredentialDialog`.

Manual sync and background mail events continue using the existing
`MAIL_CREDENTIAL_INVALID` response/event path, extended by the same safe
reason when available.

The credential dialog reuses the active account configuration and submits the
replacement value for both IMAP and SMTP, matching the current corporate-mail
behavior. The existing login endpoint verifies IMAP before persisting secrets.
On success, the dialog starts a 30-day recovery sync and refreshes account,
folder, and message queries.

## Error Presentation

The generic message

> 后台同步暂时失败，可继续使用已缓存邮件；系统会在下次同步时恢复

must not be used for recognized credential failures.

Instead, the UI displays the normalized cause and directs the user to update
the mailbox password or IMAP authorization code. Unknown network or provider
failures retain the generic recoverable-failure presentation and do not open
the credential dialog.

If replacement credential verification fails, the dialog stays open and
shows the returned safe reason so the user can correct the value.

## Retry Behavior

Recognized credential failures move mail synchronization into a
credential-required state. Automatic login retries pause in that state.
Submitting and verifying a replacement credential clears the state through
the existing account rewire and recovery-sync path.

Unknown transient failures keep the existing retry behavior.

## Testing

Focused tests cover:

- Corporate-mail password errors still classify as `MAIL_CREDENTIAL_INVALID`.
- 163 `LOGIN user in black list` classifies identically.
- Unrelated IMAP `NO` responses are not misclassified.
- Startup status carries only the normalized code and safe reason.
- Recognized startup credential failures open the existing update dialog and
  show the concrete cause.
- Unknown startup failures continue to show the generic failure message.
- Successful credential replacement verifies, saves, and starts recovery
  sync.
- Failed replacement verification leaves the dialog open with a safe,
  actionable error.
- Background retries stop while credentials are required.

