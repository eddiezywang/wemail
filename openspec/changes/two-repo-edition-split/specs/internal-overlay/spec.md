## ADDED Requirements

### Requirement: The internal repo is an overlay, never a fork

The internal repo SHALL vendor the open baseline under `open/` through a
one-way sync that: uses the open repo's tracked-file list as the sole copy
boundary, pins the source commit, refuses dirty sources (unless explicitly
overridden), writes a complete manifest, and deletes stale files only with
path-safety checks. Files under `open/` SHALL never be hand-edited.

#### Scenario: Dirty open source

- **WHEN** the sync runs while the open repo has uncommitted changes
- **THEN** the sync SHALL abort without copying

#### Scenario: Stale file after upstream deletion

- **WHEN** a file tracked in the previous manifest no longer exists upstream
- **THEN** the sync SHALL delete it from `open/` and record the removal
- **AND** manifest paths escaping the `open/` root SHALL abort the deletion
  phase

### Requirement: Internal packaging is one entry point with artifact proof

The internal build SHALL be produced exclusively by
`internal/scripts/run-profile-build.mjs`, which validates the overlay
profile, syncs, installs, builds with `WEMAIL_EDITION_OVERLAY` injected, and
verifies the generated edition artifact against the overlay (presets, boot
preset, signature, directory). A release SHALL require the
`Verified profile=internal` log line.

#### Scenario: Overlay preset missing from artifact

- **WHEN** the built edition file lacks a preset declared in the overlay
- **THEN** the packaging script SHALL fail before any release artifact is
  accepted

### Requirement: Secrets never enter either repository

All internal endpoints, tokens, and credentials SHALL come from build-time
environment variables documented in `internal/config/env.example`. Overlay
files SHALL contain only non-secret structural configuration.

#### Scenario: Endpoint needed for a build

- **WHEN** an internal build needs a telemetry endpoint
- **THEN** it SHALL be supplied via the documented env var at build time
- **AND** the overlay and repo SHALL contain only the env var's name
