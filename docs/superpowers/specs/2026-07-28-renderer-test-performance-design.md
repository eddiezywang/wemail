# Renderer Test Performance Design

## Goal

Reduce the renderer Vitest suite from more than twenty minutes to a predictable, maintainable runtime without weakening test coverage or introducing cross-file mock pollution.

## Confirmed bottlenecks

- Top-level `@phosphor-icons/react` imports make affected component files spend roughly 21–24 seconds in module loading while their assertions usually finish in under one second.
- All 107 test files currently pay the jsdom and renderer setup cost, including pure TypeScript tests that do not use browser APIs.
- `fileParallelism: false` forces serial execution.
- Vitest 4 ignores the removed `poolOptions.forks.singleFork` option.
- Disabling isolation globally is fast but unsafe because several tests rely on module mocks and singleton state.

## Selected design

1. Enable Vitest dependency optimization for `@phosphor-icons/react` and start with two fork workers.
2. Keep isolation enabled for renderer tests while parallelizing test files.
3. Split tests into a jsdom renderer project and a Node project containing only tests verified not to require DOM globals.
4. Replace top-level Phosphor imports with per-icon package entry points. Preserve imported symbol names and component behavior.
5. Keep mock-sensitive or browser-dependent `.test.ts` files in the renderer project instead of classifying by extension alone.

## Safety and verification

- Run focused icon-heavy and icon-free component tests after configuration and import changes.
- Run the Node and renderer projects separately to detect environment misclassification.
- Run TypeScript checking to verify all granular icon exports.
- Run the complete renderer suite and compare wall-clock duration with the recorded baseline.
- If two-worker execution exposes an existing order dependency, keep the affected group isolated rather than disabling parallel execution globally.

## Alternatives considered

- Parallelization alone was rejected because every worker would still parse the large icon barrel and increase CPU and memory contention.
- Global `isolate: false` was rejected because the repository contains cross-file module mocks and singleton state.
- Moving every `.test.ts` file to Node was rejected because some TypeScript-only tests still use browser storage, DOM APIs, or renderer-specific modules.
