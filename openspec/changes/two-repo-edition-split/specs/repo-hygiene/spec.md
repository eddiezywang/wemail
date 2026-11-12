## ADDED Requirements

### Requirement: The open tree is independently complete and usable

The open repo SHALL build and boot with zero private inputs: picker-first
onboarding, generic IMAP/SMTP providers, the AI intelligence pipeline, agent
runtime, automation engine, and workbench SHALL all function. No open-tree
code path SHALL require an internal module, endpoint, or preset to operate.

#### Scenario: Fresh clone cold start

- **WHEN** a fresh clone of the open repo is installed and launched without
  any overlay or internal env vars
- **THEN** it SHALL boot to the provider picker and complete onboarding for
  any built-in provider

### Requirement: Internal capabilities arrive only via registration entries

After extraction, internal modules (invoice/allowance, WeCLI, enterprise
directory, office scene detection) SHALL live in the internal repo and attach
through seams the open tree already exposes (composition overrides, provider
registries, tool factories, renderer registries, edition config). The open
tree SHALL retain the generic mechanism with no internal default.

#### Scenario: Open build with internal registration absent

- **WHEN** the open tree builds without the internal repo present
- **THEN** the build SHALL succeed and internal-only UI/tools SHALL be absent
  rather than broken

### Requirement: Publication requires zero internal identifiers

The open repo SHALL NOT be made public while the boundary gate reports any
hit. Before the public flip: the README hero image SHALL NOT contain internal
system names, community files SHALL be complete, and upstream attribution
(Cloudflare Agentic Inbox, Apache-2.0) SHALL be preserved.

#### Scenario: Public flip attempt with residual hits

- **WHEN** the visibility flip is attempted while the boundary baseline is
  non-empty
- **THEN** the final acceptance checklist SHALL block the flip

### Requirement: Both editions are verifiably bootable

Closing each stage, both editions SHALL be launchable locally with isolated
data directories: the open edition boots to the provider picker, the internal
edition boots directly to the preferred internal credentials step with
directory auto-init armed. Production user data SHALL never be used for
verification launches.

#### Scenario: Dual launch acceptance

- **WHEN** the final acceptance runs both editions side by side
- **THEN** each SHALL reach a ready workbench in its own isolated data dir
- **AND** their startup logs SHALL confirm the expected onboarding entry
