## MODIFIED Requirements

### Requirement: Windows taskbar, tray, toast, and package use optical WeMail assets

The desktop application SHALL use one approved WeMail identity with explicit
Micro, Compact, Toast, and Full optical masters appropriate to each Windows
surface rather than mechanically scaling one large source drawing.

#### Scenario: A generated icon frame is consumed

- **WHEN** a Windows surface requests a supported icon size
- **THEN** the build or runtime SHALL select the corresponding optical master
- **AND** it SHALL NOT resize the 256px frame as the source for every smaller size

#### Scenario: The approved W center is rendered

- **WHEN** any generated WeMail icon is displayed
- **THEN** the lower-fold apex SHALL use the approved raised geometry
- **AND** the center orange connection SHALL be a solid merged shape
- **AND** no white V-shaped seam or accidental light pixel SHALL appear inside it

#### Scenario: Windows uses multiple DPI scales

- **WHEN** a toast or application surface is rendered at a supported Windows DPI
- **THEN** the nearest explicit physical asset SHALL be selected
- **AND** the mark SHALL retain clear envelope and W recognition

### Requirement: New-mail Windows notifications use a subject-first hierarchy

Eligible Windows new-mail notifications SHALL identify WeMail with the approved
Toast asset, present the subject as the primary title, present the sender as
supporting text, and provide safe activation actions where supported.

#### Scenario: Message previews are enabled

- **WHEN** an eligible live message has a subject and sender
- **THEN** the toast title SHALL be the bounded subject
- **AND** supporting text SHALL identify the sender
- **AND** the toast SHALL NOT repeat generic provider text or use a sender avatar

#### Scenario: Message previews are disabled

- **WHEN** privacy preferences disable notification previews
- **THEN** the toast SHALL omit subject, sender address, body, and attachment names
- **AND** it SHALL use generic new-mail copy and the WeMail identity asset

#### Scenario: The user activates a toast action

- **WHEN** the user chooses `标为已读`, `打开邮件`, or the toast body
- **THEN** activation SHALL use an opaque local target and bounded action
- **AND** no mail content or credential SHALL be present in activation arguments

### Requirement: Single new-mail notification delivery is not held for burst aggregation

The notification pipeline SHALL submit an eligible single-message toast
immediately after durable discovery and deduplication while retaining bounded
coalescing for additional messages arriving in a short burst.

#### Scenario: One live message is discovered

- **WHEN** exactly one eligible message is durably discovered
- **THEN** the notification pipeline SHALL not wait for the previous multi-second aggregation window
- **AND** toast submission SHALL be targeted within two seconds of discovery

#### Scenario: Additional messages arrive concurrently

- **WHEN** multiple eligible messages arrive within the bounded burst window
- **THEN** the pipeline MAY replace individual pending presentation with one count summary
- **AND** every unique message SHALL still contribute to the attention count

