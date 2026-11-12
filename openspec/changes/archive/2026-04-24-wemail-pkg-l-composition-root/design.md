## Context

Packages A–K shipped sequentially over the last two weeks. Each landed with its own tests, but none of them is instantiated at Electron boot. `electron/main/local-api.ts` currently calls `startLocalApiServer()` without passing any dependencies, and `server/api/app.ts` mounts skeleton route modules that return 503 or empty payloads. Until a bootstrap layer wires the services together and feeds them into the route factories, the desktop app has no working API surface.

## Goals / Non-Goals

**Goals:**
- Single `composeApp` entry point that constructs every service in a deterministic order.
- Lazy construction for anything that depends on an authenticated account (primarily `ImapSmtpMailProvider`).
- Live rebinding of `Mail Core sync worker`'s provider on account login/logout without restart.
- Integration test that drives the full path with in-process fakes.
- A `stop()` function that shuts every subsystem down in reverse order for test isolation and clean quit.

**Non-Goals:**
- Adding any new business capability — this is pure wiring.
- Multi-account: one active account at a time, matching Package A.
- Replacing or redesigning any Package A–K public API.

## Decisions

**Decision 1: A single `composeApp` factory over DI container.**
Rationale: the graph is fixed (13 steps, no runtime swaps beyond provider rebind) and fully known at compile time. A hand-written factory is easier to read, type-check, and test than introducing a DI framework. Alternative considered: `tsyringe` / `awilix` — rejected, unnecessary complexity.

**Decision 2: Lazy `ImapSmtpMailProvider`, eager everything else.**
Rationale: the provider is the only service that hard-requires live credentials. Everything else (repos, queue, bus, agent runtime) can be constructed with just the DB + secrets store and remains idle until there's work. Keeps the cold-boot path deterministic.

**Decision 3: Provider rebind via `accountService` events, not full recomposition.**
Rationale: tearing down and rebuilding the whole app on every login would churn the queue and bus, losing in-flight jobs. Subscribing `Mail Core sync worker` to login/logout and swapping its provider reference is a bounded, testable change.

**Decision 4: Route factories receive the whole composition handle.**
Rationale: Package K already exposes `buildMailRoutes(deps)` etc. Passing the composition as `deps` is the least-friction mount point. Alternative — passing narrow interfaces — was rejected because it duplicates the typing Package K already has.

**Decision 5: `stop()` returned alongside services.**
Rationale: required for the integration test and graceful quit. Reverse-order teardown matches construction order and avoids use-after-stop on dependent services.

## Risks / Trade-offs

- [Risk] Login event handler rebinds the provider while `Mail Core sync worker` is mid-fetch → Mitigation: atomic swap + drain the current cycle before the swap takes effect.
- [Risk] A future package adds a circular dep between bus and retention → Mitigation: keep bus construction before retention; add a lint-style assertion in the integration test that all `stop()` calls complete within a timeout.
- [Risk] LLM client misconfigured at boot throws and crashes the app → Mitigation: construct `LlmClient` lazily-with-cached-error so intelligence processors log a clear failure instead of taking down the whole composition.
- [Trade-off] The composition handle is wide — every route gets everything. Accepted: local-only API, no blast radius, keeps wiring simple.

## Migration Plan

1. Land the factory and integration test with existing packages unchanged.
2. Flip `local-api.ts` and `server/api/app.ts` to consume the composition in the same PR.
3. Verify `npm run test:server` and `build:desktop`, then smoke-test the desktop shell.

Rollback: revert the two wiring commits; Package A–K code stays untouched.

## Open Questions

- Should `composeApp` accept an optional override map for tests, or should tests compose directly? Current plan: optional `overrides` param keyed by service name, defaulting to `{}`.
