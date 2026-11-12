## Context

`PiAgentRuntime` currently defaults `maxIterations` to six and reuses it in the legacy planner loop, planner-stream tool-result gate, native PI tool-call hook, and PI turn counter. This makes a legitimate sequence of distinct mail reads consume the same budget as a repeated no-progress loop. The runtime already has exact tool-and-argument repeat detection, one repair attempt, per-tool timeouts, a whole-run timeout, and cancellation, so the six-step cutoff duplicates safety controls while producing false failures.

Mail discovery tools return envelope data without bodies. `read_mail_source` returns one targeted stored body, while `batch_get_mail_intelligence` returns intelligence state for several messages but not body content. A report over several messages therefore requires one model/tool round trip per body and accumulates raw results inefficiently.

Dynamic skills are selected from the original user request and loaded into the initial system prompt. They do not need a mid-run tool budget. The design therefore focuses on execution guards and bounded mail data access rather than skill-loading changes.

## Goals / Non-Goals

**Goals:**

- Permit legitimate mail-analysis and artifact workflows to exceed six productive steps.
- Detect infinite or stalled execution by observed progress rather than total low iteration count.
- Preserve deterministic emergency, timeout, repeat, cancellation, and high-risk-action safeguards.
- Apply one guard model consistently across all three runtime paths.
- Reduce round trips for multi-message analysis with a bounded, account-isolated batch source-read tool.
- Keep mail bodies out of logs, generic observations, and failure conclusions.

**Non-Goals:**

- Unlimited execution without a deadline or emergency ceiling.
- Loading an unbounded mailbox or placing all recent mail bodies into model context.
- Changing confirmation requirements for send, delete, move, archive, automation, or other mutations.
- Building a general-purpose map/reduce engine or changing the WeMail AgentEvent protocol.
- Changing dynamic skill routing or artifact-review semantics.

## Decisions

### 1. Replace `maxIterations` with an execution-limits model

Introduce independently named runtime limits rather than increasing the existing shared value:

- exact repeated tool-and-normalized-arguments allowance: retain the current value of two;
- consecutive no-progress allowance: four;
- emergency executed-tool ceiling: 64;
- per-tool deadline: retain 30 seconds;
- whole-run deadline: default to five minutes for interactive analysis runs;
- user cancellation: always immediately authoritative.

The normal turn count and accumulated tool-result count will no longer terminate a run. A final model turn after the last permitted tool result must remain possible.

Alternative considered: increase `maxIterations` from 6 to 20. Rejected because mailbox size and workflow shape still make any low shared number arbitrary, and it preserves the coupling that caused the defect.

Alternative considered: remove every upper bound. Rejected because argument variation can evade exact-repeat detection and external providers can stall or produce unbounded work.

### 2. Track consecutive semantic progress

Add a runtime-owned progress tracker shared by the legacy planner and PI adapters. It records:

- normalized tool call fingerprints;
- privacy-safe result digests;
- discovered mail identifiers and cursors;
- successfully read message identifiers;
- workflow task, draft, checkpoint, phase, and revision identifiers;
- artifact identifiers and versions;
- pending-operation identifiers;
- consecutive no-progress count and total executed tools.

A successful result advances progress when it introduces a new domain progress key. For tools without a specialized classifier, a novel successful call fingerprint plus a novel privacy-safe result digest counts as progress. Failed calls, equivalent results, and empty results without a new cursor count as no progress. One empty search may therefore increment the counter, but the next model turn remains available to explain the valid empty outcome.

Progress keys and result digests remain in memory for the run and are not persisted as mail-content traces. Body text and HTML are excluded from digest input; batch-source progress is keyed by successfully returned message IDs and truncation metadata.

Alternative considered: treat every successful tool call as progress. Rejected because a model can vary irrelevant arguments while receiving the same result indefinitely.

### 3. Stop before disallowed work and preserve the final outcome

Exact-repeat and emergency-call checks run before tool execution. No-progress classification runs after the tool result. When a guard fires, the adapter aborts PI once, emits one structured conclusion, emits one termination event, and then settles the run. The conclusion categorizes the cause as repeated call, stalled progress, emergency resource ceiling, tool deadline, run deadline, or cancellation.

The planner-stream gate that currently synthesizes `agent reached max iterations` from tool-result count will be removed. Native PI turn counting may remain diagnostic metadata but will not terminate productive execution.

### 4. Add `batch_read_mail_source` as a bounded internal tool

The new tool accepts:

- `ids`: 1–20 message IDs;
- `maxCharsPerMessage`: default 4,000, maximum 20,000;
- `maxTotalChars`: default and maximum 80,000.

It deduplicates identifiers by first occurrence, verifies every message against the active account, and returns ordered entries. Successful entries include envelope metadata, bounded `bodyText`, attachment metadata, and per-entry truncation state. Missing, unavailable, or cross-account IDs return an unavailable entry without revealing which condition occurred. HTML is excluded from the initial batch surface to reduce prompt size and active-content risk; the existing targeted tool remains available when HTML is explicitly required.

The tool observation reports only requested, returned, unavailable, and truncated counts. It never embeds body content. The existing `safeToolObservation` and logger constraints continue to apply.

Alternative considered: change `read_mail_source` to accept either one ID or an array. Rejected because a separate schema preserves compatibility and makes batch limits and privacy behavior explicit.

Alternative considered: allow 50 messages because `batch_get_mail_intelligence` allows 50. Rejected because full body text has a substantially larger context and privacy cost than envelope and intelligence metadata.

### 5. Keep model context bounded at the data boundary

Batching reduces round trips but does not imply unbounded context. The tool enforces both per-message and aggregate character limits. The Agent remains responsible for selecting a bounded set from `search_mail` or `list_mail`, then using structured intelligence or staged batches when the selected set is larger.

This change does not implement transcript compaction. The emergency ceiling and whole-run deadline remain final safeguards if the model fails to converge.

### 6. Preserve compatibility while retiring ambiguous configuration

Internal evaluation fixtures may temporarily map `maxIterations` to the emergency ceiling only where a deterministic small ceiling is necessary for a test scenario. Production construction will use the new explicit limits and will not expose `maxIterations` as the semantic control for turns, calls, and results. Tests will cover native PI, planner-stream PI, and legacy planner behavior so future adapter changes cannot reintroduce inconsistent cutoffs.

## Risks / Trade-offs

- [Longer runs consume more model tokens] → Bound bodies at the tool boundary, retain a five-minute deadline and 64-call emergency ceiling, and add usage-focused tests.
- [A progress classifier misses a legitimate domain key] → Use a conservative successful-novel-call fallback and add fixtures for mail, workflow, artifact, and pending-operation tools.
- [A varied loop appears novel] → Require a novel result digest as well as novel arguments for fallback progress, and retain the emergency ceiling.
- [Batch body reads increase sensitive data exposure to the configured model] → Require explicit selected IDs, enforce account ownership and size limits, exclude HTML by default, and keep bodies out of logs.
- [Runtime modes drift] → Implement the tracker as a shared component and run the same behavioral fixture against every mode.
- [Five-minute runs feel unresponsive] → Preserve streaming status and cancellation; a deadline is a ceiling, not an expected duration.

## Migration Plan

1. Add the execution-limit types and shared progress tracker behind existing runtime construction.
2. Add focused tracker tests before removing fixed iteration checks.
3. Integrate the tracker into the legacy planner, native PI, and planner-stream paths.
4. Add and register `batch_read_mail_source` with account-isolation, truncation, cancellation, and privacy tests.
5. Update runtime and evaluation fixtures that intentionally require small deterministic ceilings.
6. Run server tests and all TypeScript checks, then exercise a recorded multi-mail report sequence with more than six productive steps.
7. Roll back by restoring the prior runtime version; no database or persisted conversation migration is required.

## Open Questions

None. The numeric defaults are conservative implementation defaults and remain independently configurable for tests and future tuning.
