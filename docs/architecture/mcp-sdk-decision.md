# MCP transport implementation decision

## Decision

Use a small WeMail-owned JSON-RPC/Streamable HTTP adapter for v1, constrained to the advertised `initialize`, `notifications/initialized`, `tools/list`, `tools/call`, and session DELETE surface. Do not implement Resources, Prompts, Tasks, Sampling, legacy SSE, or remote binding.

The adapter validates supplied Origins against loopback hosts, keeps authentication ahead of bounded JSON parsing, owns bearer-bound stateful sessions, and is covered by recorded fixtures plus transport tests. Request parsing enforces both declared and streamed byte limits. The narrow surface avoids bringing protocol objects into domain services and lets the current implementation proceed without mutating the dependency tree of a running desktop process. Re-evaluate the official SDK before expanding capabilities or protocol versions.

## Compatibility

- New package dependency: none
- Runtime: existing Hono Node server (`@hono/node-server`)
- Transport: JSON responses over stateful Streamable HTTP semantics
- Binding: `127.0.0.1` or `::1` only
- Browser-origin policy: missing Origin allowed for native clients; supplied Origin must resolve to an exact loopback hostname
- Request body: 40 MiB maximum before JSON parsing
- Compatibility gate: pinned protocol versions and hermetic conformance tests

## Alternatives

- Official stable `@modelcontextprotocol/sdk@1.29.0`: reviewed (MIT, Node 18+) and remains the preferred migration target if the public surface expands. The install attempt was rejected by Windows because the running WeMail desktop held Electron files in `node_modules`; no manifest or lockfile change was made.
- Split `@modelcontextprotocol/server` plus `@modelcontextprotocol/hono`: not adopted for v1 because the reviewed v2 releases were beta.
- Legacy HTTP+SSE transport: rejected because it is deprecated for new implementations.
- Stdio-only MCP: rejected because the approved product design requires a stable local Streamable HTTP endpoint that can be copied into multiple hosts.

## Dependency boundary

Only `server/wemail/mcp/*` and the Electron listener adapter may import MCP transport types. Shared contracts, mail repositories, sync, drafts, todos, pending actions, the Pi runtime, and renderer components remain protocol-neutral.
