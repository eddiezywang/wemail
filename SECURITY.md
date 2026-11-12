# Security Policy

## Reporting a vulnerability

Please do **not** open a public GitHub issue for security
vulnerabilities. Report them privately via
[GitHub Security Advisories](https://github.com/eddiezywang/wemail/security/advisories/new)
on this repository (repository maintainers can create a draft advisory
there).

This repository is currently private. GitHub's *Private vulnerability
reporting* (for external reporters) and *secret scanning / push
protection* are not available on this plan while the repository is
private; the owner must enable and verify them in the repository
settings **before** the project is ever made public. Until then, use the
draft-advisory link above or contact the maintainer through their GitHub
profile.

Include as much of the following as you can: affected version (commit or
release), reproduction steps or a proof of concept, impact assessment,
and any suggested fix. You will get an acknowledgement within a few days
and a fix timeline once the report is triaged.

## Supported versions

Only the latest release on the default branch receives security fixes.

## Security model

WeMail is a local-first desktop application:

- The local API server binds to a loopback interface on the user's
  machine; no mail data is sent to any cloud service operated by this
  project.
- Telemetry is **disabled by default** and only activates when an
  explicit runtime configuration supplies endpoints.
- Account credentials (IMAP/SMTP passwords) are stored through the
  operating system's encrypted secret storage; mail bodies and
  attachments live in a local SQLite database.
- Outbound email is composed locally and sent through the user's own
  SMTP provider.
- The agent runtime never auto-sends email: drafts and agent actions
  always require explicit user confirmation, and WeCLI mutations are
  preview-only until confirmed.

## Scope notes

- Vulnerabilities in Electron, Chromium, or upstream dependencies should
  be reported upstream; we track and pull their security releases.
- Reports about missing enterprise features (directory lookup, internal
  provider presets) are not security issues — the open edition ships
  without them by design.
