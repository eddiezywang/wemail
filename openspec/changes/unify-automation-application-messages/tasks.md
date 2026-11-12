## 1. Canonical Automation Contracts

- [ ] 1.1 Add failing contract tests for legacy trigger normalization and UI/REST/Agent capability parity.
- [x] 1.2 Extend shared automation contracts with canonical schedule, selection scope, processing mode, collection processor, and collection action types while preserving legacy rule reads.
- [ ] 1.3 Implement a canonical capability registry for trigger schedules, condition fields/operators, scopes, processors, and actions with runtime schemas, labels, descriptions, and risk metadata.
- [x] 1.4 Add capability discovery output suitable for both the settings UI and PI tool schema construction.
- [x] 1.5 Add central normalization and validation tests for unsupported capabilities, unbounded automatic scopes, invalid timezone schedules, and legacy rows.
- [x] 1.6 Implement the shared automation rule application service and route repository mutations through it.

## 2. Unified Preview and Confirmation Snapshots

- [ ] 2.1 Add regression tests proving existing dry-run divergence for `conditionRules`, natural-language conditions, and temporal expressions.
- [ ] 2.2 Replace duplicate dry-run matching with side-effect-free execution planning that uses production candidate selection and match evaluation.
- [x] 2.3 Add preview results for resolved windows, matched counts/references, truncation, planned processors, planned actions, and warnings.
- [x] 2.4 Add a migration and repository for expiring account-scoped automation preview snapshots with normalized rule JSON, rule hash, capability fingerprint, and source revision.
- [x] 2.5 Implement preview creation and exact snapshot lookup in the automation rule service.
- [x] 2.6 Require create/update commits to verify preview ownership, expiry, hash, capability fingerprint, and optimistic source revision.
- [x] 2.7 Add tests that changed, expired, cross-account, and stale preview snapshots cannot be committed.

## 3. Calendar Scheduling and Collection Runs

- [ ] 3.1 Add deterministic schedule tests for daily local time, interval compatibility, timezone validation, DST boundaries, restart catch-up, and recurrence anchoring.
- [x] 3.2 Implement canonical interval and calendar occurrence calculation without completion-time drift.
- [ ] 3.3 Add migrations for collection-run scope/window manifests, rule revision, processor state, and bounded matched references.
- [ ] 3.4 Implement indexed account/window/folder/tag candidate queries with configurable candidate limits.
- [x] 3.5 Implement immutable rolling-window and previous-occurrence collection scope resolution.
- [ ] 3.6 Add claimed collection-run execution with unique trigger keys and at-most-one latest missed-window catch-up.
- [x] 3.7 Preserve existing incoming-mail, deferred execution, manual run, and interval-rule behavior through compatibility tests.

## 4. Collection Processor Framework

- [ ] 4.1 Define registered processor interfaces, bounded mail projections, typed results, validation, retry classification, and privacy-safe diagnostics.
- [x] 4.2 Implement collection execution that evaluates conditions per candidate and invokes processors once with one matched-set manifest.
- [x] 4.3 Adapt `MailDigestService` as the registered `mailDigest` collection processor without duplicating its prompt or result validation.
- [ ] 4.4 Implement an `invoiceReadinessAnalysis` processor using existing invoice metadata and allowance-readiness services.
- [ ] 4.5 Add processor tests for empty sets, truncation, invalid model output, missing LLM configuration, partial metadata, and source references.
- [x] 4.6 Persist validated processor result references and privacy-safe failures in automation run audit data.

## 5. Application Message Domain and API

- [x] 5.1 Add shared application-message, structured-content block, typed reference, typed interaction, filter, and unread-count contracts.
- [x] 5.2 Add migrations for application messages, references, interaction payloads, read/archive state, source rule/run uniqueness, and query indexes.
- [x] 5.3 Implement account-scoped application-message repository CRUD, pagination, filters, unread counts, mark-read, and archive operations.
- [x] 5.4 Implement Markdown-to-allowlisted-block normalization and reject scripts, event handlers, active embeds, unsafe URLs, and remote tracking content.
- [x] 5.5 Add application-message routes and client query/mutation functions with strict account ownership checks.
- [ ] 5.6 Add hostile-content, cross-account, pagination, unread-state, missing-reference, and persistence tests.

## 6. Automation Message Publication

- [x] 6.1 Register `publishApplicationMessage` as a collection action with canonical parameters, presentation metadata, and low-risk delivery semantics.
- [x] 6.2 Implement idempotent publication from validated processor output with source rule/run and mail/attachment references.
- [ ] 6.3 Ensure processor or publication failure cannot create duplicate or partially visible messages on retry.
- [ ] 6.4 Add execution tests proving a multi-mail collection produces one message per run rather than one per email.
- [ ] 6.5 Connect existing digest history to shared processor/message references without duplicating generation.

## 7. Message Center Desktop UI

- [x] 7.1 Add sidebar message-center navigation with account-scoped unread badge and responsive workbench routing.
- [ ] 7.2 Build the paginated message list with read, type, source, and archive filters plus loading, empty, and error states.
- [x] 7.3 Build a reusable message detail renderer for allowlisted rich blocks, source metadata, and unavailable references.
- [x] 7.4 Implement responsive detail presentation using an in-app modal or detail column without opening a separate desktop window.
- [ ] 7.5 Implement safe navigation interactions for referenced emails, rules, runs, drafts, and audited operations.
- [ ] 7.6 Route mutating message interactions through the existing pending-action confirmation policy.
- [ ] 7.7 Add component and browser tests for unread updates, history persistence, long content, hostile content, deep links, and interaction confirmation.

## 8. UI Rule Configuration Parity

- [x] 8.1 Refactor automation API routes to use canonical normalization, validation, preview snapshots, and mutation service calls.
- [ ] 8.2 Drive form trigger, condition, scope, processor, and action options from capability discovery instead of handwritten enums.
- [x] 8.3 Add calendar schedule, timezone, collection scope, processor, and application-message delivery controls to the rule form.
- [x] 8.4 Update rule list/detail presentation to show trigger, next run, scope, condition groups, natural-language condition, processing, delivery, and recent status.
- [x] 8.5 Require the form to show and commit the exact normalized preview revision.
- [ ] 8.6 Add UI/REST parity tests for every registered user-configurable automation capability.

## 9. PI Agent Configuration Parity

- [ ] 9.1 Generate PI automation tool schemas and human-readable capability guidance from the canonical capability registry.
- [ ] 9.2 Update rule inspection tools to return canonical configuration, next-run time, recent run outcomes, and published message references.
- [x] 9.3 Update preview tooling to preserve structured conditions, natural-language conditions, scopes, processors, deliveries, and temporal expressions.
- [x] 9.4 Change rule proposal tools to accept preview ID/hash and create an exact canonical pending-action payload instead of retransmitting a rule.
- [ ] 9.5 Render structured automation confirmation cards from the preview snapshot with schedule, scope, conditions, processing, delivery, warnings, and risk.
- [x] 9.6 Update confirmed Agent execution to commit through the shared automation rule service and reject stale or cross-account snapshots.
- [ ] 9.7 Add Agent support for create, update, enable, disable, delete, explain, inspect history, and propose-manual-run workflows.
- [ ] 9.8 Add deterministic Agent tests for iterative draft refinement, ambiguous rule selection, missing schedule information, unsupported capabilities, and confirmation bypass attempts.
- [ ] 9.9 Extend live Agent scenarios for daily digest notification and invoice-readiness notification rules from natural language through confirmed execution.

## 10. Desktop Delivery, Retention, and Final Verification

- [x] 10.1 Add shared action-required (default on), new-mail (default off), and sound preferences with sender-plus-subject privacy rules and no importance filtering.
- [x] 10.2 Add a shared notification coordinator, policy, per-account live-mail aggregator, bounded delivery ledger, native Windows Toast XML renderer, and typed activation router.
- [ ] 10.3 Extend retention cleanup for application messages, tombstoned references, unread counts, and preview snapshot expiry.
- [x] 10.4 Add initial/historical synchronization-session aggregation with one in-app progress state, one final in-app summary, live-delivery watermarks, and no historical Windows notification burst.
- [x] 10.5 Remove direct mail-event desktop delivery, duplicate renderer new-mail toasts, and the startup-ready notification; route eligible producers through the coordinator only.
- [x] 10.6 Add notification failure, disabled preference, foreground behavior, privacy redaction, XML escaping, aggregation, deduplication, resolved-target, and deep-link tests.
- [x] 10.7 Decide and document the compatibility strategy for existing daily digest settings, then implement and test the selected migration or adapter behavior.
- [x] 10.8 Run focused automation, Agent, digest, message-center, notification, retention, route, and migration tests.
- [x] 10.9 Run `npm run test:server`, `npm run test:renderer`, all server/desktop/renderer type checks, and `npm run build:desktop` after notification delivery implementation and resolve regressions.
- [ ] 10.10 Run browser/Electron acceptance scenarios for UI-created and Agent-created equivalent rules, scheduled publication, restart catch-up, history, references, confirmed follow-up actions, Windows light/dark themes, scaling, Focus Assist, and notification sound.
