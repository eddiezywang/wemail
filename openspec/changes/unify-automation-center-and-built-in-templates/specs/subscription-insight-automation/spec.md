## ADDED Requirements

### Requirement: “邮箱速览” is a versioned built-in template independent of mail digest

The system SHALL provide the localized built-in template ID `subscription-daily-insight` with its own configuration, pipeline blueprint, result schema, renderer, and version.

#### Scenario: User creates 邮箱速览
- **WHEN** the user instantiates the built-in template
- **THEN** it SHALL compile into the canonical pipeline draft
- **AND** no step SHALL call `MailDigestService.generate()` or reinterpret `MailDigestResult`

#### Scenario: Legacy digest rule exists
- **WHEN** an existing `mailDigest` collection rule is listed
- **THEN** it SHALL continue using legacy behavior
- **AND** it SHALL not be relabeled as 邮箱速览 without an explicit upgrade

### Requirement: Subscription selection combines deterministic and semantic evidence

The template SHALL first evaluate registered mail metadata and deterministic subscription, bulk, platform, security, folder, spam, phishing, reply, and consumption signals, and SHALL use model classification only for bounded ambiguous candidates.

#### Scenario: List headers identify a newsletter
- **WHEN** a message has trustworthy `List-Id`, `List-Unsubscribe`, or bulk precedence signals and no exclusion signal
- **THEN** selection SHALL classify it deterministically without requiring a model decision

#### Scenario: Candidate is ambiguous
- **WHEN** deterministic evidence cannot establish whether a message is useful subscription or private/business mail
- **THEN** a bounded semantic classifier MAY decide using untrusted-content-safe instructions
- **AND** it SHALL return structured reasons and confidence

#### Scenario: Message is merely read
- **WHEN** a candidate has been opened but not replied to, acted on, or consumed unchanged by a prior occurrence
- **THEN** read state alone SHALL not exclude it

### Requirement: Newsletter signals required by the template are persisted

Mail ingestion SHALL retain the bounded normalized headers and derived fingerprints required for deterministic selection without storing arbitrary unsafe header content in logs.

#### Scenario: New mail contains list metadata
- **WHEN** IMAP ingestion receives a message with registered list or bulk headers
- **THEN** the normalized values SHALL be available to the selection capability

#### Scenario: Historical message lacks headers
- **WHEN** a historical candidate has no retained header evidence
- **THEN** selection SHALL treat that evidence as unknown
- **AND** it SHALL not fabricate list membership

### Requirement: Candidates are grouped before global analysis

The template SHALL group selected messages using stable message, thread, campaign, sender, normalized subject, time, and link fingerprints before synthesis.

#### Scenario: Same campaign reaches two accounts
- **WHEN** equivalent campaign mail is delivered to multiple selected accounts
- **THEN** analysis SHALL receive one signal group with all source references
- **AND** the result SHALL not repeat the same takeaway per account

#### Scenario: Platform sends sequential status updates
- **WHEN** several messages represent successive states of one platform event
- **THEN** grouping SHALL preserve ordering
- **AND** analysis SHALL prefer the latest meaningful state while retaining provenance

### Requirement: The template emits a dedicated validated result

The analysis step SHALL emit `SubscriptionInsightResult` with a versioned schema containing the frozen window, account and coverage statistics, top highlights, curated categories, recommended typed actions, keep recommendations, provenance, truncation, and optional empty reason.

#### Scenario: Useful content and risk both exist
- **WHEN** the input supports at least one content insight and one actionable, risk, or noise insight
- **THEN** top highlights SHALL represent both dimensions without inventing missing evidence

#### Scenario: Output violates schema or provenance
- **WHEN** model output exceeds bounds, cites a source outside the manifest, or fails schema validation
- **THEN** the invalid result SHALL not be published
- **AND** the run SHALL retry safely or fail according to the confirmed policy

#### Scenario: No category has useful evidence
- **WHEN** no useful selected group remains
- **THEN** the result SHALL use an explicit empty reason
- **AND** it SHALL not create filler categories

### Requirement: The dedicated renderer is localized, accessible, and provenance-aware

`SubscriptionInsightView` SHALL render semantic result fields using the current UI locale, preserve original brand/product names, support keyboard and screen-reader access, and expose bounded source links.

#### Scenario: Result contains many sources
- **WHEN** complete provenance contains more than four source emails
- **THEN** the primary card SHALL highlight no more than four links
- **AND** full provenance SHALL remain available in run detail

#### Scenario: Result is truncated
- **WHEN** collection or analysis reaches a confirmed limit
- **THEN** the view SHALL display scanned, selected, and coverage information
- **AND** it SHALL not claim to represent all mail

#### Scenario: Historical renderer version is unavailable
- **WHEN** the exact bound renderer cannot load a retained result
- **THEN** WeMail SHALL use a safe generic structured fallback or explicit unsupported state
- **AND** it SHALL not execute embedded content

### Requirement: Recommended actions are typed candidates, not arbitrary model commands

The result SHALL represent any recommendation to unsubscribe, mute sender, verify a security notice, merge duplicate delivery, or mark a subscription worth keeping only through registered discriminated action schemas resolved against provenance.

#### Scenario: Unsubscribe target is verified
- **WHEN** a result cites a source with a trusted unsubscribe method
- **THEN** the renderer MAY offer unsubscribe
- **AND** invoking it SHALL enter the existing preview/confirmation safety flow

#### Scenario: Unsubscribe target is unverified
- **WHEN** no trusted method can be resolved from the cited source
- **THEN** the renderer SHALL omit the mutation action or offer only to open the source

#### Scenario: User mutes a sender
- **WHEN** the user accepts a mute recommendation
- **THEN** the system SHALL preview the resulting mail or automation rule change
- **AND** it SHALL require the applicable confirmation before mutation

### Requirement: Empty, partial, and urgent notification behavior is explicit

An empty successful run SHALL remain in history without Message Center publication or desktop notification by default; partial results SHALL disclose missing coverage or delivery; urgent security signals SHALL enter immediate attention handling.

#### Scenario: No useful subscriptions arrive
- **WHEN** the run completes with `noUsefulItems`
- **THEN** run history SHALL show a successful empty outcome
- **AND** no default message or notification SHALL be created

#### Scenario: Bot delivery fails
- **WHEN** a valid insight is published to Message Center but Bot delivery fails
- **THEN** the run SHALL be partial
- **AND** the insight SHALL remain available locally

#### Scenario: High-risk account notice is detected
- **WHEN** selection identifies a qualifying urgent security signal
- **THEN** the system SHALL create or route immediate attention work according to policy
- **AND** it SHALL not rely solely on the next daily insight

### Requirement: Preview and production share compatible recipes

Template preview SHALL use real bounded samples or approved fixtures through the same selection, analysis-schema, and renderer semantics that production will use, while suppressing delivery side effects.

#### Scenario: User revises preview
- **WHEN** the user changes content preferences or provides natural-language feedback on the rendered insight
- **THEN** affected reviews SHALL become stale
- **AND** the next preview SHALL render the revised reusable recipe rather than persist sample values

### Requirement: The template has content-quality and injection acceptance

The implementation SHALL include representative multi-account fixtures and quality assertions for useful newsletters, private/business exclusions, campaigns, security signals, empty input, truncation, duplicate delivery, and prompt injection.

#### Scenario: Email body contains instructions to override policy
- **WHEN** a selected email asks the model to ignore system rules, expose other mail, or execute an action
- **THEN** analysis SHALL treat it as untrusted content
- **AND** output SHALL remain schema-bound and limited to the frozen manifest
