# Security Policy

## Reporting a vulnerability

Please do **not** open a public GitHub issue for security vulnerabilities.
If private vulnerability reporting is enabled, use the **Report a
vulnerability** button on the repository's
[Security Advisories page](https://github.com/eddiezywang/wemail/security/advisories).
If that option is unavailable, ask a maintainer for a private reporting
channel without including vulnerability details; a public issue may be used
only for that contact request. Do not include reproduction steps, affected
data, or credentials in the public request. Maintainers must enable and
verify private vulnerability reporting before publishing the repository.

Include as much of the following as you can: affected version (commit or
release), reproduction steps or a proof of concept, impact assessment,
and any suggested fix. Maintainers will acknowledge and triage reports as
capacity permits; no response or fix deadline is currently guaranteed.

## Supported versions

Security fixes are intended for the current default branch. Until releases
and a maintenance policy are established, older versions are not guaranteed
to receive fixes.

## Security model

WeMail is a local-first desktop application:

- The local API server binds to a loopback interface on the user's
  machine. Mail providers, configured model endpoints, optional messaging
  integrations, and telemetry endpoints receive data as needed for those
  services. AI requests may include mail content; their recipient depends
  on the configured model endpoint.
- Loopback binding is not authentication: the local API does not currently
  provide a per-client authentication boundary against other local
  processes. Browser requests with an Origin header are limited to the
  configured renderer origin, and Host is limited to the listener or
  renderer authority, but requests without an Origin header remain
  accepted. Treat other local software as potentially able to access the
  API; use a trusted OS account and environment while this boundary is
  being strengthened.
- Remote email images may be fetched through the local image proxy. Its
  default policy rejects private addresses; `WEMAIL_TRUSTED_IMAGE_HOST_SUFFIXES`
  explicitly bypasses those address and port restrictions for matching hosts
  and all their subdomains, and should only be configured for trusted
  infrastructure. The benchmark/fake-IP range `198.18.0.0/15` is blocked by
  default, so some proxy configurations may need an explicit trusted suffix.
  Opening a message can cause a request to its image server, revealing the
  user's network address and any identifier embedded in the image URL. The
  heuristics that remove some tracking pixels do not block all trackers.
  The proxy also holds a bounded in-memory image cache, and its responses
  permit a private client cache for up to 24 hours; the browser may persist
  cached responses and URLs according to its own cache policy.
- Telemetry is **disabled by default** when no endpoint is configured.
  Endpoints can be supplied through runtime environment variables or a
  `build/telemetry-config.json` included by a downstream build. Values
  included in an application package, including tokens, can be extracted
  by its recipients and must not be treated as secrets. When enabled,
  telemetry includes the local operating-system username, an installation
  identifier, app and platform versions, and validated event metadata.
- Normal desktop launches store account credentials (IMAP/SMTP passwords)
  using Electron's operating-system-backed secret storage. The explicit
  `WEMAIL_E2E_MODE=1` test mode uses a file-backed, obfuscated store that is
  not cryptographically secure; use only disposable test credentials and
  data in that mode. Mail data is stored locally, including SQLite and an
  attachment disk cache.
- Outbound email is composed locally and sent through the user's own
  SMTP provider.
- Agent-initiated sending and higher-risk actions require confirmation. The
  agent may save drafts and perform certain low-risk changes to one explicitly
  identified message without confirmation. Separately, an authenticated MCP
  client can send, move, or delete mail without another WeMail confirmation;
  treat the MCP credential as authority over the connected mailbox.
- Local Claude Code delegation is disabled by default. Setting
  `WEMAIL_ENABLE_LOCAL_CLAUDE_CODE=1` in the application's process environment
  before starting it exposes
  Agent tools that launch the installed CLI with permission prompts bypassed.
  Delegated tasks can execute commands and access files with the application's
  OS permissions; enable this only in a trusted environment and account for
  untrusted content that an Agent may read. The task prompt is passed to the
  CLI as a process argument. CLI output is written to `claude-code-tasks` in
  the application data directory and can contain sensitive content; tasks may
  continue after WeMail exits. Some WeMail-specific environment variables are
  filtered, but other inherited variables and files may contain credentials.
  New task files use owner-only POSIX modes where
  supported; existing files and Windows access controls depend on the OS and
  data directory. Review and protect these files before sharing diagnostics.

## Scope notes

- Report vulnerabilities in Electron, Chromium, or other dependencies to
  the relevant upstream project. If WeMail is affected, a private report here
  also helps maintainers assess mitigation and updates.
- Reports about missing enterprise features (directory lookup, internal
  provider presets) are not security issues — the open edition ships
  without them by design.
