## 1. Contract Freeze and Compatibility Baseline

- [ ] 1.1 Add failing contract tests for V2 rules, pipeline steps, typed values, structured bindings, capability snapshots, authorization envelopes, DesignRecipe, ChartSpec, artifact manifests, and artifact references.
- [ ] 1.2 Add parity fixtures that capture current V1 per-message actions, scheduled collection processors, application-message publication, Agent preview/proposal, and `wecli.operation` behavior.
- [ ] 1.3 Define explicit size/count/time bounds for mail candidates, attachments, datasets, charts, artifact resources, preview lifetime, and temporary materialization.
- [ ] 1.4 Add feature flags for V2 authoring/execution and Message Artifact viewing so rollback does not disable V1 rules or structured messages.

## 2. Automation Provider Registry

- [ ] 2.1 Implement provider registration, discovery query, capability descriptors, schemas, risk, side effects, preview support, idempotency, confidence, and fingerprints.
- [ ] 2.2 Implement compatibility classification for identical, metadata-only, optional-input, breaking-schema, missing-capability, provider-identity, and risk-increase changes.
- [ ] 2.3 Upgrade capability discovery APIs and canonical Agent/UI schema projection to use registry descriptors.
- [ ] 2.4 Add built-in Mail Provider adapters for existing read and mailbox mutation actions.
- [ ] 2.5 Add Processor Provider adapters for mail digest, invoice extraction/readiness, aggregation, and dataset normalization.
- [ ] 2.6 Add Application Message Provider and internal Artifact Store provider/service boundaries.

## 3. V2 Rule, Binding, and Pipeline Runtime

- [ ] 3.1 Add V2 rule normalization, validation, immutable version persistence, authorization, and V1-to-V2 compatibility compilation.
- [ ] 3.2 Implement typed automation values and resource-reference validation with account ownership and bounded serialization.
- [ ] 3.3 Implement literal, trigger, collection, previous-step, run, and coalesce bindings with schema-aware path validation.
- [ ] 3.4 Implement explicit `single`, `all`, and one-source `each` expansion and reject implicit Cartesian products.
- [ ] 3.5 Implement sequential step execution, dependency handling, `stop`/`continue`, safe retries, and step-run persistence.
- [ ] 3.6 Route existing V1 action/processor behavior through provider-compatible execution primitives and pass parity tests before removing direct branches.

## 4. Durable Scheduling and Restart Catch-up

- [ ] 4.1 Separate immutable rule configuration from mutable schedule runtime state.
- [ ] 4.2 Implement stable rule-revision occurrence keys, concurrent claim protection, planned recurrence anchors, and immutable run windows.
- [ ] 4.3 Implement `catchUpLatest` with default 72-hour maximum age, delayed-run metadata, skipped-stale diagnostics, and no unbounded backlog.
- [ ] 4.4 Ensure `previousScheduleWindow` uses planned boundaries during delayed execution and retries reuse the original resolved window.
- [ ] 4.5 Add interval, daily timezone, DST, restart, concurrent tick, and stale revision tests.

## 5. Generic WeCLI Provider

- [ ] 5.1 Add binary/version discovery and restricted structured-help/plain-help command traversal with cache invalidation.
- [ ] 5.2 Normalize command paths and arguments into schemas and safe argv templates without adding business-command branches.
- [ ] 5.3 Add declared/inferred discovery confidence, conservative risk classification, exact argv preview, and fingerprint snapshots.
- [ ] 5.4 Materialize AttachmentReferences into validated run-scoped temporary files, execute with `shell: false`, retain WeCLI audit linkage, and clean files after success/failure.
- [ ] 5.5 Add startup cleanup for abandoned temporary directories and tests for path traversal, missing files, size limits, hash mismatch, timeout, authentication, and partial external failure.
- [ ] 5.6 Migrate the invoice-upload scenario to discovered command templates and remove the special-case dependency after acceptance passes.

## 6. Agent Automation Authoring

- [ ] 6.1 Add the concise internal `wemail-automation-authoring` skill with capability discovery, compilation, preview, repair, and proposal workflow.
- [ ] 6.2 Add `discover_automation_capabilities` and upgrade `preview_automation_rule` to return structured compile errors and per-step sample plans.
- [ ] 6.3 Implement at most two materially different automatic repair attempts and persist privacy-safe repair records in preview snapshots.
- [ ] 6.4 Bind pending actions to `previewId`, `ruleHash`, capability snapshots, source revision, account, and expiry; commit exactly the previewed rule.
- [ ] 6.5 Add one structured confirmation presentation for trigger/catch-up, scope/limits, ordered steps, sample results, warnings, side effects, and risk.
- [ ] 6.6 Add Agent read tools and explanations for runtime state, delayed catch-up, step results, capability drift, artifact/message references, and failures.
- [ ] 6.7 Extend live scenario tests for unsupported action refusal, discovery-before-use, invoice upload, scheduled report, stale preview, drift pause, and no duplicate rules.

## 7. `wemail-design` Skill and Design Contracts

- [ ] 7.1 Initialize the internal `wemail-design` skill with concise SKILL.md, one-level references, recipe/theme assets, Agent UI metadata where applicable, and deterministic recipe validation.
- [ ] 7.2 Add mode-selection, information-hierarchy, chart-selection, report, dashboard, deck, accessibility, security, and quality references.
- [ ] 7.3 Implement DesignRequest, DesignRecipe, component allowlist, Design System, ChartSpec, provenance, notification summary, and quality requirement contracts.
- [ ] 7.4 Implement sample-time recipe compilation for `auto`, `brief`, `report`, `dashboard`, and `deck`, with `report` as the narrative default and deck only for explicit presentation intent.
- [ ] 7.5 Validate that all metrics, aggregations, charts, tables, and conclusions reference real Dataset fields and produce meaningful empty/partial-failure states.
- [ ] 7.6 Forward-test the skill on invoice, customer-feedback, project-progress, execution-result, and empty-dataset prompts without leaking expected outputs.

## 8. Trusted Design Renderer and Artifact Store

- [ ] 8.1 Implement deterministic DesignRecipe rendering with application-owned chart, filter, collapse, table, copy, and deck runtime modules.
- [ ] 8.2 Add artifact manifest/resource contracts, immutable versioning, content hashes, account ownership, provenance, preview expiry, formal retention, and bounded storage.
- [ ] 8.3 Implement HTML/CSS allowlists, dangerous element/attribute removal, URL validation, strict CSP, runtime capability injection, and validation before persistence and serving.
- [ ] 8.4 Add artifact APIs that authorize exact resources and content types without directory listing or arbitrary path reads.
- [ ] 8.5 Add cleanup for expired previews and unreferenced formal artifacts while preserving artifacts referenced by retained messages.
- [ ] 8.6 Add tests for no fabricated data, reproducible rendering, content hashes, historical immutability, size limits, missing resources, and cross-account denial.

## 9. Application Message and Artifact Viewer UX

- [ ] 9.1 Extend application-message contracts and persistence with optional artifact ID/version, key metrics, delayed-run status, and typed `openArtifact` interaction.
- [ ] 9.2 Keep list/detail APIs lightweight and fetch the complete artifact only when the user opens it.
- [ ] 9.3 Add list cards for title, preview, unread state, severity, time, bounded metrics, source, and delayed catch-up indication.
- [ ] 9.4 Add an isolated Artifact Viewer using a sandboxed opaque-origin iframe, typed host bridge, loading/error/expired states, source navigation, rule navigation, and supported print/export controls.
- [ ] 9.5 Add report/dashboard scrolling and interaction behavior plus deck 16:9 canvas, keyboard navigation, fullscreen, page count, overflow checks, and reduced motion.
- [ ] 9.6 Deep-link eligible privacy-safe Windows notifications to the persisted application message and never directly authorize a mutation.
- [ ] 9.7 Add component, browser, and desktop E2E tests for unread/archive state, deep links, unavailable references, complete report display, charts, filtering, and deck navigation.
- [x] 9.8 Automatically publish every formal one-shot Agent artifact to an idempotent application message and return bounded delivery metadata.
- [x] 9.9 Add structured Agent artifact events/message parts and render persistent artifact cards that reuse the isolated in-workbench viewer.
- [x] 9.10 Add a direct structured-data-to-artifact Agent capability for one-shot reports/charts and prohibit raw HTML success fallbacks in the runtime skill contract.

## 10. Security, Privacy, and Operational Hardening

- [ ] 10.1 Add hostile artifact fixtures for scripts, event handlers, forms, frames, remote beacons, dangerous URLs, CSS escapes, SVG payloads, navigation, host-message spoofing, and resource traversal.
- [ ] 10.2 Verify artifact frames have no same-origin, popup, form, top-navigation, Node, preload, IPC, permission, or unrestricted network capability.
- [ ] 10.3 Ensure raw sender HTML never enters Design Dataset or Artifact HTML and all extracted content is escaped as data.
- [ ] 10.4 Keep logs and telemetry metadata-only: IDs, counts, sizes, duration, status, error code, capability ID/fingerprint, and content hash.
- [ ] 10.5 Add run and rule diagnostics for truncation, delayed catch-up, capability drift, unavailable authentication, skipped dependencies, and artifact delivery failures.

## 11. Rollout, Migration, and Removal

- [ ] 11.1 Enable built-in providers behind flags and compare V1/V2 outputs on fixtures and non-mutating live previews.
- [ ] 11.2 Enable internal V2 invoice and scheduled-report scenarios, then enable Agent V2 creation for test accounts.
- [ ] 11.3 Enable Message Artifact publication and viewing separately from V2 execution so either surface can be rolled back independently.
- [ ] 11.4 Upgrade V1 rules only when edited and confirmed; retain V1 execution until adapter parity and rollback gates pass.
- [ ] 11.5 Remove adapter-specific action and collection branches only after unit, scenario, browser, desktop, security, restart, and migration acceptance passes.
- [ ] 11.6 Record final acceptance evidence, known limits, rollback steps, and formal decision on whether generic HTTP/MCP/plugin providers enter a later change.
