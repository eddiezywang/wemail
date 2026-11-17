## ADDED Requirements

### Requirement: Edition runtime configuration is validated and single-sourced

The system SHALL define one edition contract (`EditionRuntimeConfig`) covering
profile, extra provider presets, onboarding boot behavior, signature brand
URL, and optional enterprise directory. The same structural validation SHALL
run at build time (overlay → generated file) and at composition time, and
SHALL reject duplicate preset ids, out-of-range ports, non-http(s) or
credential-bearing URLs, and directory domains not starting with `@`.

#### Scenario: Malformed overlay at build time

- **WHEN** a build runs with `WEMAIL_EDITION_OVERLAY` pointing at a file that
  fails validation
- **THEN** the build SHALL fail with a descriptive error naming the fault

#### Scenario: Malformed or missing edition file at runtime

- **WHEN** the desktop main process starts and the edition file is missing or
  unparseable
- **THEN** startup SHALL continue with the open-source default edition
- **AND** no internal preset, brand link, or directory client SHALL activate

### Requirement: The renderer receives only a whitelisted edition view

The renderer SHALL obtain edition information exclusively from
`GET /api/system/edition`, which SHALL return only extra provider presets,
preferred preset id, boot-to-credentials, and signature brand URL. The
endpoint SHALL never expose the profile internals or enterprise directory
configuration.

#### Scenario: Open edition served

- **WHEN** the endpoint is queried with no edition overlay loaded
- **THEN** it SHALL return empty presets, `bootToCredentials: false`, and an
  empty signature brand URL

### Requirement: Onboarding honors edition boot behavior

The open edition SHALL always begin at the provider picker with no vendor
pre-selected. An edition that pins a preferred preset with boot-to-credentials
SHALL advance at most once, only before the user has interacted, directly to
that preset's credentials step.

#### Scenario: Internal first boot

- **WHEN** onboarding starts under an edition with a preferred internal preset
- **THEN** the credentials step for that preset SHALL be entered automatically
- **AND** choosing a different provider later SHALL remain possible

### Requirement: Outbound signatures take an optional edition brand link

Signature construction (server-side action executor and renderer compose
form) SHALL accept an optional brand URL. When absent or empty, the footer
SHALL render a plain-text brand with no anchor; when present, it SHALL render
an escaped, `rel="noopener"` link. No brand URL SHALL be hard-coded in the
open tree.

#### Scenario: Open-edition send

- **WHEN** a draft is sent under the open edition
- **THEN** the appended footer SHALL contain the brand text without any
  anchor element

### Requirement: Enterprise directory is injected, never defaulted

The open tree SHALL NOT hard-code any enterprise directory endpoint. When an
edition supplies directory configuration, the composition root SHALL inject a
directory client factory bound to the configured base URL and arm auto-init
for accounts whose email domain matches; directory operations on an edition
without configuration SHALL fail closed with a typed error.

#### Scenario: Directory requested without edition configuration

- **WHEN** any directory lookup runs under the open edition
- **THEN** it SHALL return the `directory-not-configured` error and SHALL NOT
  attempt a network call
