# Unified LLM Runtime Design

## Goal

Use one authoritative in-process controller for every model-backed WeMail feature. Saving a model configuration must make every new AI request use that configuration immediately, without restarting the desktop app. A request already running must finish with the configuration it started with.

## Problem

The application currently stores overlapping LLM state in the composition root, direct compose service, per-account processors, Agent, and Curator. `reloadLlmSettings()` replaces only some consumers. In particular, direct AI compose captures a client at application boot, so saving a valid configuration later can leave Settings reporting ready while compose reports `AI compose is not configured`.

## Runtime boundary

Introduce `LlmRuntime` as the sole owner of active LLM state:

```text
Llm settings persistence + validation
              |
              v
       LlmRuntime.replace()
              |
              v
    immutable LlmRuntimeSnapshot
              |
              +-- Agent
              +-- AI compose
              +-- summaries/tags/translation/todos
              +-- Curator and account processors
```

The runtime owns provider configuration, client construction, availability status, and model routing for `default`, `draft`, `summary`, and `agent` lanes. No feature service may persist a parallel mutable client/configuration copy.

## Snapshot semantics

`runtime.snapshot()` returns an immutable value containing the active client (if configured), provider metadata, and resolved models for all lanes.

- A new interactive request reads exactly one snapshot before it begins.
- Queue work and long-running operations bind their snapshot at dispatch/start time.
- `replace()` atomically publishes a new snapshot only after a new client has been built successfully.
- A task already holding an older snapshot continues normally; subsequent requests read the new snapshot.
- An unavailable runtime yields one shared unavailable result. Callers must not invent feature-specific configuration checks.

## Integration

`LlmSettingsService` remains the persistent configuration and secret store. The settings route validates/probes the submitted configuration, persists it, and then invokes the runtime replacement path.

The composition root creates one runtime at boot and passes its lookup interface—not individual `llmClient`, `llmConfig`, or `llmModel` fields—to model-backed services. For services whose processors are naturally constructed per account, account wiring requests the current snapshot when constructing a new processor graph. Existing processors are not mutated mid-run.

Direct compose resolves a `draft` snapshot for every request. Agent, Curator, and background processor wiring resolves their appropriate lane through the same runtime. Status UI reads the runtime status, so it represents the same availability decision used by execution.

## Error behavior

If no valid snapshot is available, all model-backed paths surface a common `AI runtime is not configured` domain error that maps to an actionable 503 response. Network/provider failures remain generation errors (for example, 502) and are not misreported as missing configuration.

## Acceptance criteria

1. Start the app without a model, save a valid configuration, then immediately create an AI draft without restarting; it uses the configured draft/default model.
2. Save configuration A, start a controlled long-running request, save configuration B, then verify the running request uses A and the next request uses B.
3. Agent, compose, summary, tag, translation, todo, and Curator obtain model/client availability from the same runtime interface; no composition-level consumer accepts an independently captured LLM client/config/model triple.
4. The configured status shown by Settings is derived from the runtime and cannot disagree with AI compose availability.
5. Missing key/default model yields the shared unavailable error; upstream model failures retain their existing error classification.
6. Focused unit/integration tests cover replacement, lane routing, direct compose hot reload, and in-flight snapshot stability.

## Out of scope

This change does not add provider types, change secret persistence, cancel active requests, or migrate historical AI results.
