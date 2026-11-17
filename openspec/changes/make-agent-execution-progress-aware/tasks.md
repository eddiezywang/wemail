## 1. Execution Guard Foundation

- [x] 1.1 Add independently named execution-limit options and production defaults for exact repeats, consecutive no-progress steps, emergency tool calls, tool deadlines, and whole-run deadlines.
- [x] 1.2 Implement a run-scoped progress tracker with normalized call fingerprints, privacy-safe result digests, domain progress keys, consecutive no-progress counting, and emergency-call accounting.
- [x] 1.3 Add focused tracker tests for new mail IDs, cursors, message reads, workflow phases and revisions, artifacts, pending operations, empty results, equivalent results, failures, and varied no-progress calls.

## 2. Runtime Integration

- [x] 2.1 Integrate the shared tracker into the legacy planner path and remove termination based on the shared low iteration loop while preserving final model output after the last tool result.
- [x] 2.2 Integrate the shared tracker into native PI hooks, remove productive termination from `turnCount`, and enforce exact-repeat and emergency checks before tool execution.
- [x] 2.3 Remove the planner-stream tool-result-count cutoff and apply the same progress and termination semantics used by the other runtime paths.
- [x] 2.4 Emit distinct structured conclusions for exact-repeat loops, consecutive no-progress stalls, emergency call ceilings, tool deadlines, run deadlines, and cancellation.
- [x] 2.5 Update runtime construction and evaluation fixtures to use explicit execution limits, retaining deterministic small ceilings only where a test intentionally exercises a guard.

## 3. Bounded Batch Mail Reading

- [x] 3.1 Add the internal `batch_read_mail_source` schema and handler with 1–20 IDs, first-occurrence deduplication, ordered entries, per-message truncation, and an 80,000-character aggregate bound.
- [x] 3.2 Enforce active-account ownership for every requested message and return indistinguishable unavailable entries for missing and cross-account IDs.
- [x] 3.3 Register the batch tool in Agent composition and ensure its description guides the model to use it only after bounded mail selection.
- [x] 3.4 Add mail-tool tests for success, ordering, duplicates, missing messages, cross-account isolation, input limits, aggregate truncation, cancellation, attachment metadata, and privacy-safe observations.

## 4. Cross-Mode Behavioral Coverage

- [x] 4.1 Add a shared behavioral fixture that completes a productive multi-mail analysis and artifact sequence with more than six steps in legacy planner, native PI, and planner-stream modes.
- [x] 4.2 Add cross-mode fixtures proving exact repeated calls and varied no-progress calls stop consistently without executing disallowed follow-up tools.
- [x] 4.3 Add tests proving a final assistant answer is still produced after the last allowed productive tool result.
- [x] 4.4 Add deadline and cancellation tests proving abort occurs once and the emitted conclusion uses the correct reason category.
- [x] 4.5 Add privacy regression tests proving progress tracking, observations, conclusions, and logs never include mail body text or HTML.

## 5. Verification

- [x] 5.1 Run the focused `PiAgentRuntime` and `MailAgentTools` test suites and resolve regressions.
- [ ] 5.2 Run `npm run test:server`.
- [x] 5.3 Run `npm run typecheck`, `npm run typecheck:server`, and `npm run typecheck:desktop`.
- [x] 5.4 Exercise a representative recent-seven-days multi-mail HTML report flow and verify search, bounded batch read, analysis, artifact preview, and final response complete without a fixed-iteration failure.
