# Mail Core Restart Recovery and IMAP Reauthentication Design

## Context

The Electron renderer currently receives the Mail Core API port through its startup arguments and caches the resulting base URL. When the Mail Core Utility Process crashes and restarts, its API Worker binds a new ephemeral port. The supervisor reconnects the renderer's MessagePort, but the HTTP client continues using the old port. Metadata already available through local snapshots can still render while body hydration, intelligence, and draft requests remain on loading skeletons until their normal request timeouts expire.

Observed on 2026-07-30:

- Mail Core exited with Windows status `0xC0000005`.
- The restarted API Worker moved from port `50926` to `51251`.
- The existing renderer continued using `--wemail-api-port=50926`.
- The page retained metadata while body, summary, and draft sections remained loading.

Separately, a definitive IMAP `LOGIN` credential rejection must not be treated like a transient network failure. Repeated retries create noisy logs, unnecessary connections, and loading states that cannot succeed until the credential changes.

## Goals

- Recover an open mail view after a Mail Core restart without reloading the renderer.
- Cancel requests targeting a stale API endpoint and retry them once against the new endpoint.
- Replace indefinite skeletons with an explicit recovering state and bounded failure UI.
- Stop all IMAP work for an account after a definitive credential rejection.
- Require the user to update the password or log out before continuing.
- Capture actionable crash evidence for future Mail Core native failures.

## Non-goals

- Moving HTTP routing back into Electron Main.
- Treating VPN, DNS, certificate, timeout, or server availability failures as bad credentials.
- Automatically changing or guessing mailbox credentials.
- Claiming a root cause for the current native crash without a dump and native stack.

## Architecture

### Dynamic API endpoint lifecycle

`MailCoreSupervisor` becomes the source of truth for the current API endpoint. It publishes an endpoint state whenever Mail Core becomes ready, disconnects, or restarts:

- `recovering`: no usable API port is available.
- `ready`: contains the current API port and a monotonically increasing generation.
- `failed`: recovery exceeded its bounded deadline.

Electron Main updates the value returned by `desktop:get-api-port` and broadcasts endpoint changes to every live renderer. The preload bridge exposes a subscription API without exposing unrestricted IPC.

The renderer API client stores an endpoint generation rather than permanently trusting its startup argument. A port-change event replaces the cached base URL and aborts in-flight requests that were created under an older generation. Those requests retry once when the new endpoint is ready. Business-level HTTP errors are never automatically retried by this mechanism.

The startup argument remains an initial fast path. It is not authoritative after startup.

### Recovery user experience

While the endpoint is unavailable, the selected email remains visible using its cached metadata. Body, intelligence, and draft regions show a shared “邮件服务正在恢复” state instead of independent indefinite skeletons.

If Mail Core becomes ready within the recovery deadline, affected requests resume automatically. If recovery fails, the UI shows a retry action and a concise diagnostic identifier. The renderer is not force-reloaded, so selection, scroll position, and unsent editor state are preserved.

### IMAP credential-invalid state

Only a normalized provider failure with code `MAIL_CREDENTIAL_INVALID` and stage `imap.login` enters the credential-invalid state. Transport failures remain ordinary connection errors.

When credential-invalid is entered for an account:

1. Account Worker cancels or drains active provider work.
2. New sync, IDLE, body hydration, attachment fetch, and automatic reconnect work is rejected without opening another IMAP connection.
3. Main sends one deduplicated authentication-required event to the renderer.
4. A blocking reauthentication dialog is displayed.

The dialog:

- cannot be dismissed with a close button, Escape, backdrop click, navigation, or browser history;
- displays the affected mailbox address;
- accepts a replacement password;
- provides `验证并保存` and `退出当前邮箱账号` actions;
- disables duplicate submissions while verification is active;
- retains focus and displays a clear error when verification fails.

`验证并保存` verifies IMAP authentication before writing the new secret. Only after successful verification does the application atomically replace the stored credential, clear credential-invalid state, reload the account runtime, and resume queued work.

`退出当前邮箱账号` stops its workers, clears stored mailbox credentials and session state, and returns to the login screen.

If the application restarts while the stored credential is still rejected, the blocking dialog reappears after the first definitive login rejection. Duplicate provider events for the same account do not create duplicate dialogs.

## Error handling

- Endpoint-change retries are limited to one retry per request and only apply when the endpoint generation changed.
- A request timeout without an endpoint change remains a normal timeout.
- Mail Core recovery has a bounded deadline and produces a stable diagnostic code.
- Credential verification distinguishes rejected credentials from connectivity and TLS failures.
- Passwords never enter application logs, telemetry, query caches, or renderer persistence.
- Logging records account id, normalized stage, endpoint generation, recovery duration, and result, but never secrets.

## Native crash diagnostics

The current Mail Core failures are confirmed as Windows `0xC0000005` access violations, but Windows Event Log and WER contain no faulting-module record or dump. The implementation must add diagnostics before assigning a root cause:

- enable crash reporting or process-scoped dump capture for the Electron Utility Process in developer builds;
- record the Mail Core PID, active Worker roles, API endpoint generation, native module versions, working set, and recent queue depths;
- retain a small bounded number of dumps under `workspace/reports/performance` or the application diagnostics directory;
- provide a developer command that opens the dump/report location;
- correlate each dump with supervisor exit and restart records.

The leading candidate is the native SQLite/Worker boundary because Mail Core hosts several database-using workers and showed working-set peaks around 500–666 MB, but this remains a hypothesis until a dump provides a native stack.

## Testing

Automated coverage must include:

- supervisor endpoint transition from port A to recovering to port B;
- Main updating `desktop:get-api-port` after restart;
- preload endpoint-change subscription cleanup;
- renderer cancellation of an old-generation request and one successful retry on the new endpoint;
- no retry for an ordinary HTTP error or timeout without endpoint change;
- recovery UI replacing indefinite skeletons while preserving selected mail state;
- repeated credential-invalid events producing one blocking dialog;
- Escape, backdrop, and navigation being unable to dismiss the dialog;
- invalid replacement password retaining the dialog;
- network failure during verification not being reported as an invalid password;
- valid replacement password saving the secret and resuming body hydration;
- logout clearing credentials and returning to login;
- restart with still-invalid credentials showing the dialog again;
- developer crash diagnostics producing a correlated report for a controlled Utility Process failure.

## Acceptance criteria

- After a controlled Mail Core restart with a new API port, an already-open uncached email finishes loading without a renderer reload.
- No request continues targeting the stale port after the endpoint-change event is processed.
- Recovery state becomes visible promptly and never remains an unbounded skeleton.
- A definitive IMAP password rejection causes no repeated login attempts until reauthentication or logout.
- The authentication dialog has no dismissal path other than successful verification or logout.
- A subsequent native crash leaves enough evidence to identify the faulting module and stack rather than only an exit code.
