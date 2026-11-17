# Secure Mail MCP acceptance evidence

> Historical test record: the results, endpoint and tool count below describe
> the environment at the time of the run, not the current release. Re-run the
> current checks for a release rather than treating this record as evidence.

Change: `expose-secure-mail-mcp`

Automated evidence is maintained in the following focused suites:

- `McpHttpTransport.test.ts`, `McpSessionManager.test.ts`, and protocol fixtures: authentication ordering, Origin rejection, declared/streamed request-body limits, initialize/initialized, annotated tools, errors, bearer-bound sessions, cleanup, cancellation, and loopback policy.
- `McpExternalHostAcceptance.test.ts`: real local server, Codex and Claude Desktop configuration shapes, live annotated catalog, sender/flag envelopes, message-to-attachment-id round trip, inbound attachment resources, staged outbound uploads, cross-session reference rejection, draft/Todo management, pending send, exact approval, one idempotent commit, rotation, revocation, and old-token rejection.
- `McpMessageTools.test.ts` and `McpAttachmentTool.test.ts`: body-free sender/flag projections, sender/recipient/time/attachment metadata, cursor limits, adaptive thread byte budgets, untrusted/truncated bodies, ownership, MIME/byte/25 MB checks, cache reuse, and session-bound resources.
- `McpAttachmentUploadStore.test.ts`, `McpDraftAndStateTools.test.ts`, and `McpOperationTools.test.ts`: bounded in-memory staging, expiry and lifecycle cleanup, account/session isolation, canonical Base64 and declared-size validation, reference-only draft/send schemas, retain/replace/remove semantics, duplicate rejection, mixed existing/new attachment ordering, and validation before repository writes or prepared operations.
- `McpOperationTools.test.ts`, `mcpApprovalRoute.test.ts`, and `McpPersistence.test.ts`: zero-side-effect direct approval for new operations, compatibility approval for legacy pending operations, canonical payload hash, rejection/expiry/cancel, concurrency, key conflict, provider uncertainty, restart reconciliation, and metadata-only persistence.
- `McpSection.test.tsx` and `PendingActionCard.test.tsx`: one-time secret handling, live catalog, direct-authority warnings, operation guidance, and compatibility rendering for legacy MCP approval cards.
- `McpListenerController.test.ts`: stable listener management, token/session termination, occupied-port isolation, emergency disable, and renderer API survival.

Release verification must also record successful server/renderer/desktop typechecks, server/renderer/browser tests, Windows desktop build, launch with no white screen, stable endpoint across restart, and privacy-safe log/audit inspection.

## Verification record (2026-07-22)

- OpenSpec CLI `1.6.0` installed and `openspec validate expose-secure-mail-mcp --strict` used as the contract gate.
- MCP/control-plane focused suite: 80/80 passed, including the real loopback server and Codex/Claude-style host configurations.
- SecretStore/account persistence regression suite: 13/13 passed after making Windows replacement writes recoverable.
- Renderer MCP/settings/approval suite: 23/23 passed. The real-browser MCP settings smoke test also passed and confirmed default-off behavior, `http://127.0.0.1:3129/mcp`, 26 live tools, and disabled token creation before listener enablement.
- Server, renderer, and Electron TypeScript checks passed; `npm run build:desktop` passed.
- Electron production-renderer smoke test passed and captured `workspace/reports/electron-production-renderer-health.png`; the window rendered without a white screen. Stable-listener restart and occupied-port isolation are covered by `McpListenerController.test.ts` and the real-server acceptance suite.
- Full renderer suite: 98 files and 665/665 tests passed after aligning stale inbox page-size expectations with the current 50-item bound.
- Full server suite: 1,899 tests collected, 1,898 passed, 0 failed, and 1 intentionally skipped. The repaired coverage includes Agent send execution, intelligence summary recovery, queue startup tag repair, migration compatibility, and MCP route composition.
- Full browser suite: 20/20 passed, including the secure MCP settings entry and smart-tag regression flow. Windows SecretStore replacement writes use recoverable destination replacement and no longer fail repeated fixture login/token updates.
- Midscene visual-model environment variables were unavailable, so visual acceptance used the repository Playwright browser and Electron suites instead.

## Contract hardening verification record (2026-07-22)

- MCP hardening-focused suites passed, covering complete message/draft metadata, attachment-id retrieval, annotations, aggregate Base64 limits, adaptive thread paging, Origin validation, and declared/streamed request limits.
- Full server suite: 1,905 tests collected, 1,904 passed, 0 failed, and 1 intentionally skipped.
- Root application, server, and Electron TypeScript checks passed with `npm run typecheck`, `npm run typecheck:server`, and `npm run typecheck:desktop`.

## Envelope and attachment upload verification record (2026-07-23)

- Focused MCP suites: 35/35 passed, including envelope sender/flags, staged upload validation and capacity, cross-session rejection through the real HTTP transport, draft retain/replace/remove behavior, mixed existing/new send ordering, session termination cleanup, and composition shutdown cleanup.
- OpenSpec `secure-mail-mcp` passed strict validation.
- Full server suite: 1,909 tests collected, 1,908 passed, 0 failed, and 1 intentionally skipped.
- Root application, server, and Electron TypeScript checks passed with `npm run typecheck`, `npm run typecheck:server`, and `npm run typecheck:desktop`.
- MCP/settings/approval renderer suites: 3 files and 23/23 tests passed. A separate full renderer run produced no assertion failure but did not exit within the 15-minute runner limit; the timed-out Vitest process tree was cleaned up.
- `npm run build:desktop` passed. The focused production-renderer browser settings suite passed 5/5 and confirmed the disabled-by-default local endpoint and 27 live public tools.
