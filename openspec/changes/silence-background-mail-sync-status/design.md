## Context

The workbench currently renders `StartupSyncStatus` whenever startup or
background synchronization is not idle or settled, and separately renders a
settled summary. That status includes historical metadata, pending bodies,
resource pauses, and recoverable failures. These states are useful for
diagnostics but are not meaningful tasks the user initiated or can normally
resolve.

The synchronization architecture now keeps realtime receipt independent from
historical and body recovery. The UI should reflect that separation: a healthy
mailbox stays visually quiet while maintenance continues.

## Decision

Use a silent-background policy:

- `running`, `paused`, `historical-metadata`, `bodies`, `intelligence`,
  `recoverable-failure`, and `settled` startup states do not create a workbench
  banner, toast, message-center item, or completion summary.
- Manual refresh feedback remains attached to the refresh button and ends when
  the bounded foreground refresh completes. It does not wait for historical
  repair and does not produce a global success summary.
- Credential-invalid state continues using the credential recovery dialog.
- Sustained realtime unavailability may produce a concise mailbox-health
  warning. It must be derived from foreground watcher health, not from
  historical or body state.
- Synchronization details remain queryable through `/api/mail/sync-status`, MCP
  synchronization tools, diagnostic logging, and debug mode.

## Alternatives Considered

### Keep a delayed background warning

Show history or body failures only after a long threshold. This still presents
maintenance backlog as a user-facing failure even when new mail is arriving.
Rejected.

### Remove synchronization status everywhere

This produces the cleanest UI but removes operational evidence needed for
support and agent diagnostics. Rejected.

### Hide workbench status and retain diagnostics

This preserves a calm product experience while keeping the system observable.
Selected.

## Renderer Behavior

The workbench removes both current synchronization surfaces:

1. the active startup/background synchronization banner;
2. the dismissible “同步完成” summary.

No replacement placeholder is rendered. Mail lists continue to update through
their existing query invalidation and event paths. The absence of a progress
banner must not suppress refreshes, discoveries, notifications, automation, or
credential recovery.

The manual refresh control retains its existing accepted/joined lifecycle and
accessible busy state. Its visual state is bounded to the foreground refresh
request. Ordinary React Query fetching, historical synchronization, body
hydration, and intelligence work do not animate it.

## Failure Visibility

Background-only conditions remain silent:

- historical checkpoint retry;
- body hydration backlog or item failure;
- resource-governor pause;
- intelligence backlog;
- successful background completion.

User-visible conditions remain:

- invalid or expired mailbox credentials;
- account configuration missing;
- sustained foreground watcher failure that prevents new-mail receipt;
- an explicit manual refresh request failing before its bounded foreground
  reconciliation completes.

The workbench must not infer realtime failure from `StartupSyncStatus.status ===
"failed"`, because that status may represent historical repair only.

## Observability

The server continues returning complete metadata/body/watcher/startup status.
MCP tools continue returning bounded progress for agents. Normal logging remains
quiet, while debug mode can expose phase transitions and retry details. This
change is presentation policy only.

## Testing

Renderer tests cover:

- startup running produces no global progress banner;
- resource pause produces no global banner;
- historical recoverable failure produces no global banner;
- settled startup produces no completion summary;
- manual refresh retains local busy/error behavior;
- credential recovery remains visible;
- mail-list updates remain unaffected by the absence of synchronization UI.

Server and MCP synchronization-status tests remain unchanged, proving that
diagnostic state has not been removed.

## Rollout

1. Add the silent-background requirements and update conflicting historical
   progress-summary expectations.
2. Remove the two workbench synchronization surfaces and obsolete dismissal
   state.
3. Update renderer tests and run typecheck plus production renderer build.
4. Rebuild and launch the desktop app for visual acceptance.

