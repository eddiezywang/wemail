# Unified LLM Runtime implementation plan

> **For implementation:** follow this plan with test-first changes. Each task is independently verifiable before moving on.

**Goal:** Make one immutable, versioned LLM runtime snapshot the only source of truth for every model-backed feature. A saved configuration must be visible to every newly-started request without restart, while work already holding a snapshot completes using its prior client and model.

**Architecture:** `LlmRuntime` owns the active settings, provider config, client, and per-lane model selection. It publishes a complete replacement snapshot atomically. Long-lived services ask it for a snapshot at request start; account-runtime factories capture one snapshot during construction. No consumer owns an independently mutable LLM reference.

**Tech stack:** Node ESM, TypeScript, `node:test`, existing `LlmClient` adapters, React/Tauri composition.

---

## Task 1: Add the atomic LLM runtime and prove snapshot isolation

**Files:**
- Create: `server/wemail/ai/LlmRuntime.ts`
- Create: `server/wemail/ai/LlmRuntime.test.ts`
- Modify: `server/wemail/bootstrap/composition/settings.ts`

1. Write tests using fake clients and an injected client factory:
   - An unavailable runtime reports `configured: false`.
   - Configured runtime exposes its provider, client, and lane models; draft/summary/agent fall back to default model.
   - A snapshot captured before `replace()` retains client/model A after the runtime publishes B.
   - Factory failure publishes a fully unavailable snapshot, never a partially-new or stale configuration.
2. Run `node --import tsx --test server/wemail/ai/LlmRuntime.test.ts`; it must fail because the runtime is absent.
3. Implement:
   ```ts
   export type LlmLane = "default" | "agent" | "summary" | "draft";
   export interface LlmRuntimeSnapshot {
     readonly generation: number;
     readonly configured: boolean;
     readonly settings: LlmRuntimeSettings | null;
     readonly config?: LlmProviderConfig;
     readonly client?: LlmClient;
     modelFor(lane: LlmLane): string | undefined;
   }
   export class LlmRuntime {
     snapshot(): LlmRuntimeSnapshot;
     replace(settings: LlmRuntimeSettings | null): LlmRuntimeSnapshot;
   }
   ```
   Build config/client in locals and publish a snapshot with one assignment. Preserve pure provider-adapter helpers, but remove `LlmRefHolder` and `createLlmRef`.
4. Re-run the focused test and `npm run typecheck`; both must pass.
5. Commit: `feat: add atomic LLM runtime`.

## Task 2: Make direct compose acquire one runtime snapshot per request

**Files:**
- Modify: `server/wemail/intelligence/IntelligenceService.ts`
- Modify: `server/wemail/intelligence/IntelligenceService.compose.test.ts`
- Modify: `server/wemail/bootstrap/composition/intelligence.ts`
- Modify: `server/wemail/automation/RuleSuggester.ts`

1. Add failing compose tests that build `IntelligenceService` once with an unavailable runtime, call `replace(A)`, and verify compose succeeds without recreating the service. Add a delayed A request: replace with B before resolving it, then prove that request used A and the next request uses B.
2. Run `node --import tsx --test server/wemail/intelligence/IntelligenceService.compose.test.ts`; the current constructor-captured client must fail the hot-reload test.
3. Replace `llmConfigured`, `llmProvider`, `llmModel`, `llmClient`, and `updateLlmStatus()` dependencies with `llmRuntime: LlmRuntime`. At the start of each new model-facing operation, take exactly one snapshot and use it after awaits. `composeMail()` must capture its snapshot before the first await.
4. Change `composeIntelligence()` and `RuleSuggester` to use the runtime rather than a boot-time client/model pair.
5. Re-run the focused compose test. Commit: `fix: resolve compose LLM from runtime snapshots`.

## Task 3: Route processors, agent, title generation, and curator through the runtime

**Files:**
- Modify: `server/wemail/bootstrap/AppComposition.ts`
- Modify: `server/wemail/bootstrap/reloadLlmSettings.ts`
- Modify: `server/wemail/bootstrap/composition/agent.ts`
- Modify: `server/wemail/bootstrap/composition/intelligence.ts`
- Modify: `server/wemail/bootstrap/composition/curator.ts`
- Modify: `server/wemail/agent/AgentTitleGenerator.ts` if needed
- Modify: `server/wemail/bootstrap/AppComposition.integration.test.ts`

1. Add a failing integration test: boot without a model, reload valid settings, then compose successfully without app restart. Add a delayed-operation switch test proving old work uses fake A while new compose, curator, and newly-built account processor use B.
2. Run `node --import tsx --test server/wemail/bootstrap/AppComposition.integration.test.ts`; it must fail while consumers retain boot state.
3. Instantiate exactly one `LlmRuntime` in `composeApp()`, seeded from persisted settings plus overrides. `reloadLlmSettings()` first calls `replace(settings)`, then takes a fresh snapshot only to rebuild delegates/runtimes that deliberately capture configuration.
4. Pass a single `LlmRuntimeSnapshot` (not config/settings/client triples) to Pi agent delegate construction, per-account processors, and `TaskAgentStatusUpdater`. Let title generation and curator creation obtain a snapshot for each new operation. Remove mutable `setLlmClient()`, `llmRef`, and boot-time snapshot comments.
5. Re-run integration tests and:
   ```bash
   rg -n "LlmRefHolder|createLlmRef|setLlmClient|updateLlmStatus|llmClient: llmRef|llmConfig: llmRef" server/wemail
   ```
   There must be no production hits. Commit: `refactor: route AI consumers through LLM runtime`.

## Task 4: Make settings and status expose the same runtime state

**Files:**
- Modify: `server/api/routes/settingsRoutes.ts` only if necessary
- Modify: `server/api/app.ts` only if necessary
- Modify: `apps/windows-client/src/app/components/settings/sections/ModelSection.tsx` only if necessary
- Add focused API/UI tests as required

1. Add a failing API test: save settings, then `GET /api/intelligence/status` returns the runtime’s provider/default model. An invalid replacement must report unconfigured, never the previously saved model.
2. Keep settings persistence as the sole save path and `reloadLlmSettings()` as the sole post-save transition. Make status read `LlmRuntime.snapshot()`, not cached service display fields.
3. Run focused API/UI tests and `npm run typecheck`. Commit: `fix: report unified LLM runtime status`.

## Task 5: Complete regression and desktop acceptance

1. Run:
   ```bash
   npm test
   npm run typecheck
   npm run build:client
   ```
2. Confirm construction is centralized:
   ```bash
   rg -n "createOpenAiCompatibleClient|createAnthropicMessagesClient|buildLlmClient" server/wemail --glob '!server/wemail/ai/LlmRuntime.ts' --glob '!server/wemail/bootstrap/composition/settings.ts'
   rg -n "llmClient:|llmConfig:|llmSettings:" server/wemail/bootstrap
   ```
   Only runtime/bootstrap adapter code may construct clients; no consumer may receive independently managed config/settings/client state.
3. Desktop smoke test: start unconfigured; save a valid model and invoke draft/summary/agent with no restart; start a delayed draft under A, save B, verify it finishes with A, and verify a new draft uses B. Repeat replacement failure/recovery and confirm feature behavior matches Settings status.
4. Commit only verification fixes, then report command outputs, architecture-search output, and switch-boundary evidence. Do not claim acceptance while any model-backed feature owns a stale live client/model reference.
