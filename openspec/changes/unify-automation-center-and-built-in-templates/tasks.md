## 1. Shared contracts and compatibility model

- [x] 1.1 Add local-profile/account automation owner and current/selected/all-connected account-scope contracts.
- [x] 1.2 Add account-qualified mail, attachment, provenance, application-message, and typed-action reference contracts.
- [x] 1.3 Add template manifest, localized metadata, configuration schema, UI schema, pipeline blueprint, binding, and upgrade contracts.
- [x] 1.4 Add unified automation list-item and detail contracts covering V1 and V2 without exposing provider identities.
- [x] 1.5 Add rule health, workflow-stage summary, next-occurrence, latest-output, and upgrade-availability contracts.
- [x] 1.6 Add bounded run-summary, run-detail, run-revision, step-detail, usage, delivery-outcome, and recovery-action contracts.
- [x] 1.7 Add frozen input-manifest item, result envelope, renderer identity, provenance, and discriminated action-candidate contracts.
- [x] 1.8 Add `SubscriptionInsightResult` and its bounded nested highlight, category, action, keep, coverage, empty, and truncation types.
- [x] 1.9 Add serialization and backwards-compatibility tests for all new shared contracts.

## 2. SQLite persistence and migrations

- [x] 2.1 Add additive migrations for automation owner type/profile ID, account scope, template ID/version/hash, result schema, and renderer binding.
- [x] 2.2 Add template package/index tables for immutable built-in and personal versions, activation, compatibility, and content hashes.
- [x] 2.3 Extend run persistence with planned occurrence, run revision, frozen identities, account resolution, model resolution, and result envelope references.
- [x] 2.4 Add frozen manifest storage with account-qualified references, content hashes, reasons, per-account counts, and retention metadata.
- [x] 2.5 Extend step-run storage with typed stage, bounded summaries, usage, retry safety, side-effect evidence, delivery destination, and retention class.
- [x] 2.6 Add archived-rule state and reference-aware permanent-deletion support without changing existing enabled semantics.
- [x] 2.7 Add indexes and uniqueness constraints for local-profile rules, template bindings, run occurrence keys, run revisions, and cross-account references.
- [x] 2.8 Add migration tests from current V1/V2 databases, minimal historical fixtures, restart recovery, rollback flags, and idempotent re-open.

## 3. Unified V1/V2 Automation Center projection

- [x] 3.1 Implement `UnifiedAutomationQueryService` that unions account-visible V1, V2, and local-profile rules without duplicate IDs.
- [x] 3.2 Implement deterministic V1 purpose, workflow-stage, health, latest-run, and configuration projection adapters.
- [x] 3.3 Implement V2 projection from trigger, recipes, pipeline, snapshots, delivery plan, runtime state, and template binding.
- [x] 3.4 Implement authoritative health derivation for healthy, running, needs-attention, paused, disabled, and never-run states.
- [x] 3.5 Implement unified list, detail, archive, and reference-aware delete local API routes while preserving existing V1/V2 endpoints.
- [x] 3.6 Add current-account plus local-profile visibility rules and reject cross-profile or cross-account detail access.
- [x] 3.7 Add query-service and API tests for V1-only, V2-only, coexistence, Agent-created rules, disabled failures, partial delivery, and no duplication.

## 4. Run observability and recovery services

- [x] 4.1 Extend rule-run claiming to freeze planned boundaries, template/pipeline/model/renderer identities, account resolution, and input manifest.
- [x] 4.2 Persist stage and step transitions before publishing progress and increment a stable run revision.
- [x] 4.3 Implement bounded run-summary and authorized run-detail query services.
- [x] 4.4 Add local SSE or revision-polling projection for active run progress with duplicate-revision suppression.
- [x] 4.5 Derive running, succeeded, empty, partial, failed, cancelled, and outcome-unknown from persisted step/effect state.
- [x] 4.6 Implement step-scoped recovery eligibility using immutable input, capability fingerprint, authorization, artifact availability, and retry-safety evidence.
- [x] 4.7 Implement retry-delivery and other safe failed-step retries without rerunning successful upstream stages.
- [x] 4.8 Implement typed expired-detail, expired-artifact, changed-input, missing-source, and uncertain-side-effect responses.
- [x] 4.9 Add run-observability tests for restart, delayed occurrence, idempotency, partial delivery, exact retry, unsafe retry refusal, redaction, and retention expiry.

## 5. Canonical draft parity for Agent and structured editing

- [x] 5.1 Add APIs to create or resume one `ExecutionPipelineDraft` from a V2 rule or a V1 upgrade source.
- [x] 5.2 Add typed draft patch operations for owner/scope, trigger, data, analysis, artifact, delivery, template configuration, and advanced policy.
- [x] 5.3 Enforce optimistic revision conflicts and return a bounded semantic conflict summary.
- [x] 5.4 Route structured edits through current validation, preview, review invalidation, exact confirmation, commit, and verification services.
- [x] 5.5 Update Agent tools and context so “请 Agent 修改” resumes the same draft rather than creating a parallel configuration.
- [x] 5.6 Make verified unified-detail availability part of Agent durable-success verification and return an open-rule interaction.
- [x] 5.7 Keep direct V1 toggle/run compatibility while requiring a V2 upgrade draft for material edits.
- [x] 5.8 Add integration tests for form-to-Agent, Agent-to-form, stale revisions, V1 upgrade, exact confirmation, and false-success prevention.

## 6. Local automation template registry

- [x] 6.1 Define the repository source and Electron packaged-resource paths for built-in automation templates.
- [x] 6.2 Implement template manifest parsing, localization, hashing, immutable version discovery, compatibility, and tamper detection.
- [x] 6.3 Validate template configuration/UI schemas, pipeline blueprints, result/renderer references, capabilities, limits, and non-executable restrictions.
- [x] 6.4 Implement managed personal-template storage and prevent protected built-in ID shadowing.
- [x] 6.5 Implement template list, inspect, configuration validation, preview-instantiation, and confirmed-instantiation services and routes.
- [x] 6.6 Compile resolved template configuration and defaults into the canonical pipeline draft without invoking an independent scheduler or executor.
- [x] 6.7 Persist exact template/result/renderer bindings in confirmed rule versions.
- [x] 6.8 Implement template upgrade detection, semantic diff, preview, exact confirmation, version activation, and rollback.
- [x] 6.9 Implement save-successful-workflow-as-template through existing sanitization and exact-install services.
- [x] 6.10 Add registry tests for application upgrades, personal templates, invalid UI schemas, tampering, protected IDs, instantiation, upgrade, and rollback.

## 7. Automation Center list and detail shell

- [x] 7.1 Replace foreground V1-only queries with unified automation list/detail queries behind a rollback flag.
- [x] 7.2 Preserve the existing global-navigation plus list/detail page structure and remove renderer schema-version branching.
- [x] 7.3 Update the list header with enabled and needs-attention counts, new automation action, and Agent creation entry.
- [x] 7.4 Render installed rules with name, trigger, health, latest outcome, relative time, and accessible non-color status.
- [x] 7.5 Add a bounded recommended-template section with purpose, default timing, required readiness, preview, and add action.
- [x] 7.6 Add overview, run-history, and configuration detail tabs with URL/deep-link state.
- [x] 7.7 Add responsive drill-in navigation for narrow windows and preserve selection across refresh.
- [x] 7.8 Add keyboard, focus, screen-reader, reduced-motion, localization, empty-state, loading, and error behavior.
- [x] 7.9 Add renderer tests for V1/V2 coexistence, recommendations, selection, narrow layout, accessibility, and authoritative health.

## 8. Workflow rail and overview experience

- [x] 8.1 Implement the reusable trigger/data/analysis/artifact/delivery workflow-rail component from unified stage projections.
- [x] 8.2 Render confirmed structure while idle and persisted stage progress while a run is active.
- [x] 8.3 Localize stage-local blockers with impact, available output, and deduplicated recovery actions.
- [x] 8.4 Add overview metrics for next occurrence, latest result, recent success health, and available output without making token usage primary.
- [x] 8.5 Add latest-result preview using the safe artifact/result viewer and a correct no-artifact state.
- [x] 8.6 Add enable, test, run-now, ask-Agent-to-change, archive, and permanent-delete interactions with distinct authorization semantics.
- [x] 8.7 Add visual and interaction tests for healthy, running, empty, partial, failed, paused, disabled, and never-run rules.

## 9. Run history and run-detail foreground

- [x] 9.1 Replace shallow recent-run rows with bounded status, planned/actual time, duration, input/result counts, and delivery summaries.
- [x] 9.2 Add filtering for outcome, production/test, and date while keeping list requests bounded.
- [x] 9.3 Implement desktop run-detail modal or sheet and narrow-window full-height drill-in behavior.
- [x] 9.4 Render business result/artifact, coverage, source links, workflow timeline, and destination outcomes before diagnostics.
- [x] 9.5 Render model, token/resource usage, immutable hashes, warnings, and privacy-safe errors in collapsed technical details.
- [x] 9.6 Add step-local retry controls only when the server projects an eligible recovery action.
- [x] 9.7 Show typed expired source/artifact/detail states without broken links or reconstructed content.
- [x] 9.8 Add renderer and Electron tests for progress updates, restart restoration, partial delivery, retry, expired detail, and keyboard focus.

## 10. Structured configuration and template editing UI

- [x] 10.1 Replace direct legacy-form material editing with the canonical draft editor while retaining simple compatible V1 toggles and tests.
- [x] 10.2 Add ordinary sections for name/description, account scope, trigger/timezone, data preferences, analysis, output, and delivery.
- [x] 10.3 Add advanced sections for model policy, Cron, catch-up, retention, instruction override, bounds, and template/version metadata.
- [x] 10.4 Render template-specific controls from validated UI schema using only registered safe components.
- [x] 10.5 Add real-data or fixture preview, natural-language review handoff, stale-review explanation, and exact final confirmation summary.
- [x] 10.6 Add semantic conflict reload UX for stale form or Agent revisions.
- [x] 10.7 Add template upgrade diff, regenerated preview, confirmation, and rollback UI.
- [x] 10.8 Add structured-editor tests for Agent parity, advanced controls, invalid configuration, preview/review, stale conflict, and exact confirmation.

## 11. Cross-account ownership and collection

- [x] 11.1 Extend rule, message, artifact, run, and pending-action repositories to support account or local-profile ownership.
- [x] 11.2 Add explicit current, selected, and all-connected account-scope resolution with confirmation-time account disclosure.
- [x] 11.3 Implement fair bounded cross-account candidate collection and per-account scanned/selected accounting.
- [x] 11.4 Freeze account-qualified manifest references and content hashes at claim time and reuse them on retry.
- [x] 11.5 Update Message Center queries so one local-profile result is listed once alongside account results.
- [x] 11.6 Implement safe account-qualified mail and attachment deep links with account switching and disconnected-source states.
- [x] 11.7 Define future-occurrence behavior for accounts added to or removed from an all-connected scope without changing claimed runs.
- [x] 11.8 Add isolation, fairness, disconnect, new-account, deep-link, manifest-retry, and duplicate-message tests.

## 12. “邮箱速览” data and analysis pipeline

- [x] 12.1 Add the versioned built-in `subscription-daily-insight` template package, metadata, configuration/UI schema, defaults, pipeline blueprint, and bindings.
- [x] 12.2 Persist bounded normalized List-Id, List-Unsubscribe, bulk precedence, platform, security, and campaign/link signals required by selection.
- [x] 12.3 Add deterministic subscription candidate selection with private/business/spam/phishing/reply/consumed-unchanged exclusions.
- [x] 12.4 Add bounded structured semantic classification only for ambiguous candidates with untrusted-content safety.
- [x] 12.5 Add message, thread, campaign, sender, normalized-subject, time, and link-fingerprint grouping across accounts.
- [x] 12.6 Add ordered platform-update consolidation and multi-account duplicate grouping with full provenance.
- [x] 12.7 Implement the specialized bounded subscription-insight analysis capability without using `MailDigestService`.
- [x] 12.8 Validate `SubscriptionInsightResult` bounds, manifest provenance, category/action counts, empty reason, and coverage statistics.
- [x] 12.9 Add account-fair large-mailbox limits, priority for risk/high-value signals, explicit truncation, and model/token budgets.
- [x] 12.10 Add deterministic fixtures and content-quality evaluation for useful, private, business, duplicate, promotional, security, empty, truncated, and prompt-injection cases.

## 13. Subscription insight renderer, messages, and typed actions

- [x] 13.1 Implement versioned result-validator and renderer-registry support for `SubscriptionInsightResult`.
- [x] 13.2 Implement localized accessible `SubscriptionInsightView` for highlights, curated categories, recommended actions, keep recommendations, coverage, and empty/partial states.
- [x] 13.3 Limit the primary view to four highlighted source links while retaining full provenance in run detail.
- [x] 13.4 Publish one local-profile Application Message result and suppress publication for default empty success.
- [x] 13.5 Apply the default desktop/Bot notification policy only for risk or actionable results and keep destination outcomes separate.
- [x] 13.6 Implement discriminated unsubscribe, mute-sender, verify-security, merge-duplicate, and keep-subscription candidate resolvers.
- [x] 13.7 Route mutation candidates through pending-action preview/confirmation and omit actions whose targets cannot be verified.
- [x] 13.8 Route urgent security signals to immediate attention handling in addition to the daily result.
- [x] 13.9 Add safe generic fallback for unavailable historical renderer versions.
- [x] 13.10 Add renderer, application-message, action-safety, source-link, empty, partial, urgent, and historical-version tests.

## 14. Reconciliation, retention, rollout, and acceptance

- [x] 14.1 Reconcile existing Agent-authored V2 rules into the unified center and mark eligible V1 rules with non-destructive upgrade availability.
- [x] 14.2 Add retention jobs for 30-day detail/manifest/artifact defaults while preserving lightweight summaries and referenced immutable metadata.
- [x] 14.3 Add archived-rule retention and reference-aware permanent deletion with explicit user impact.
- [x] 14.4 Add feature flags and rollback paths for unified center reads, structured canonical editing, template catalog, cross-account scope, and 邮箱速览.
- [x] 14.5 Document user terminology, template authoring boundaries, advanced configuration, retention, cross-account behavior, and troubleshooting.
- [x] 14.6 Add server acceptance for V1/V2 coexistence, Agent/form parity, exact confirmation, template creation/upgrade, and restart-safe runs.
- [x] 14.7 Add complete 邮箱速览 acceptance across multiple accounts, frozen 24-hour window, grouping, provenance, renderer, Message Center, Bot, and typed actions.
- [x] 14.8 Add failure acceptance for no content, truncation, account disconnect, missing renderer, unavailable Bot, stale capability, prompt injection, and partial delivery.
- [x] 14.9 Run shared/server/desktop typechecks, server and renderer suites, migration tests, production desktop build, and relevant Electron E2E.
- [x] 14.10 Verify rollback to the legacy center does not delete or mutate V2 rules, templates, runs, manifests, or artifacts.
