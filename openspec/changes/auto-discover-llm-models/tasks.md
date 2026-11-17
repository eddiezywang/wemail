# Auto-discover LLM Models - Tasks

## Implementation

- [x] Add failing backend tests for OpenAI-compatible and Anthropic discovery, stored-key reuse, deduplication, and safe failures.
- [x] Implement the side-effect-free model discovery service and settings route.
- [x] Extend frontend API contracts and query hooks for model discovery.
- [x] Add a shared searchable model picker with custom-value fallback and focused tests.
- [x] Replace the settings page static model hints with discovery-backed model pickers.
- [x] Integrate discovery into onboarding while preserving skip and manual-entry flows.
- [x] Add/update settings and onboarding interaction tests.
- [x] Run focused backend and frontend tests.
- [x] Run TypeScript type checking and the production client build.

## Execution Agent Report

```text
Change ID: auto-discover-llm-models
Goal: discover endpoint model ids while retaining manual entry.
Files touched: settings route/service/tests, frontend API/query, shared ModelPicker, settings/onboarding UI/tests.
Spec scenarios implemented: OpenAI and Anthropic discovery, stored key reuse, manual fallback, existing/custom values, factual presentation.
Tests added: 4 backend discovery tests, 2 ModelPicker tests, 1 settings discovery test, 1 onboarding discovery test, and 1 browser end-to-end discovery/save test.
Verification commands: settingsRoutes node:test (18/18), focused Vitest (12/12), settings Playwright suite with system Chrome (4/4), npm run typecheck, and npm run build.
Known gaps: the final full server typecheck is blocked by unrelated type errors in the dirty worktree's StartupSyncCoordinator.test.ts callbacks; this command passed before those concurrent files changed. The model-discovery backend suite and production client build pass after the final changes.
Risk notes: generic /models endpoints can include non-chat models; final save-time generation probing remains the authority for usability.
Ready for review: yes
```

## Merge Gate

Block merge if discovery sends secrets in URLs/logs, mutates saved settings, makes unsupported model-quality claims, or removes manual model entry.
