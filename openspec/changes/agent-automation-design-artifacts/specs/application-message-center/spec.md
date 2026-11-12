## MODIFIED Requirements

### Requirement: Message content uses a safe rich-content model
The system SHALL render ordinary application-message detail from allowlisted structured blocks and MAY render complete HTML only through a validated account-scoped Message Artifact reference whose manifest, resources, content hash, sanitization, trusted runtime capabilities, and viewer policy have passed the artifact security contract. Unscoped arbitrary HTML, model-authored executable code, event handlers, remote active content, unsafe URLs, and unrestricted embeds remain prohibited.

#### Scenario: Processor returns Markdown
- **WHEN** a registered processor returns Markdown-compatible ordinary message content
- **THEN** the system SHALL parse and sanitize it into allowlisted blocks before persistence or rendering

#### Scenario: Design Provider returns a valid artifact
- **WHEN** the trusted Design Provider produces a validated immutable Message Artifact
- **THEN** the application message MAY reference that artifact
- **AND** complete HTML SHALL be fetched and rendered only inside the isolated Artifact Viewer

#### Scenario: Content contains hostile HTML
- **WHEN** ordinary content or an artifact contains a script, inline event handler, form, iframe, remote image beacon, unsafe SVG, executable URL, navigation attempt, or undeclared resource
- **THEN** the unsafe content SHALL NOT execute or load
- **AND** the artifact SHALL be rejected or safely rendered without the hostile construct
- **AND** safe persisted message summary content MAY remain visible
