## ADDED Requirements

### Requirement: Realtime background arrivals create an attention count

The desktop application SHALL maintain a process-session count of unique mail
messages received through realtime synchronization while the main window is not
both visible and focused.

#### Scenario: New mail arrives while the window is hidden

- **WHEN** a `live-idle` or `live-poll` event inserts one or more unique messages
- **AND** the main window is hidden, minimized, or not focused
- **THEN** the attention count SHALL increase by the number of unique inserted
  message IDs
- **AND** this behavior SHALL NOT depend on whether Windows toast notifications
  are enabled

#### Scenario: New mail arrives while the user is viewing WeMail

- **WHEN** a realtime event inserts mail while the main window is visible and
  focused
- **THEN** the attention count SHALL remain zero

#### Scenario: Historical or manual synchronization inserts mail

- **WHEN** mail is inserted by bootstrap, historical backfill, body hydration,
  recovery, or manual synchronization
- **THEN** the attention count SHALL NOT change

#### Scenario: A realtime event is delivered more than once

- **WHEN** an inserted message ID already belongs to the current unseen session
- **THEN** it SHALL NOT increase the attention count again

### Requirement: Returning to the application acknowledges the count

The desktop application SHALL clear the attention count only when the main
window is visible and receives foreground focus.

#### Scenario: The user restores WeMail

- **WHEN** the hidden or minimized main window becomes visible and focused
- **THEN** the attention count SHALL reset to zero
- **AND** the session deduplication state SHALL be cleared

#### Scenario: The window is shown without receiving focus

- **WHEN** the main window becomes visible but does not receive focus
- **THEN** the attention count SHALL remain unchanged

### Requirement: Windows taskbar and tray project the same count

The desktop shell SHALL project the attention count to the Windows taskbar icon
and the WeMail tray icon using the same bounded display value.

#### Scenario: The count is nonzero

- **WHEN** the attention count is between 1 and 99
- **THEN** taskbar and tray projections SHALL display the exact number
- **AND** the tray tooltip SHALL state the number of new messages

#### Scenario: The count exceeds the visual limit

- **WHEN** the attention count exceeds 99
- **THEN** both projections SHALL display `99+`

#### Scenario: The count is acknowledged

- **WHEN** the attention count resets to zero
- **THEN** the Windows taskbar overlay SHALL be cleared
- **AND** the tray SHALL restore its base icon and tooltip

### Requirement: New-mail notifications are initially enabled

The application SHALL enable new-mail Windows notifications for fresh
preferences and for legacy preference records that have never stored the
dedicated `newMailNotifications` field, while preserving an explicit dedicated
choice.

#### Scenario: A fresh installation loads preferences

- **WHEN** no business preference record exists
- **THEN** `newMailNotifications` SHALL be `true`
- **AND** notification sound SHALL retain its independent default

#### Scenario: A legacy preference record is loaded

- **WHEN** a stored record has `desktopNotifications` but lacks
  `newMailNotifications`
- **THEN** `newMailNotifications` SHALL use the new enabled default

#### Scenario: The user explicitly disabled the dedicated preference

- **WHEN** a stored record contains `newMailNotifications: false`
- **THEN** the application SHALL preserve `false`

### Requirement: Notification decisions are diagnosable without sensitive data

The desktop notification pipeline SHALL emit one bounded structured outcome for
each notification candidate without logging mail content or credentials.

#### Scenario: Notification policy suppresses a live message

- **WHEN** a notification candidate is rejected because its category is
  disabled or its origin is not live
- **THEN** diagnostics SHALL record the corresponding bounded reason
- **AND** diagnostics SHALL NOT contain sender, subject, body, attachment names,
  or credentials

#### Scenario: Windows delivery is attempted

- **WHEN** an eligible notification reaches the desktop delivery adapter
- **THEN** diagnostics SHALL distinguish delivered, unsupported, and failed
  outcomes
