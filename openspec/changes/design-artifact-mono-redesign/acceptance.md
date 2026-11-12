# Acceptance — Mono Data Report Redesign

Not yet implemented. Acceptance is gated on the criteria below; measured results are recorded here when each gate passes.

## Bug regression — the original "值趋势" defect

- A snapshot dataset (single time point) with "趋势" in the agent prompt SHALL NOT produce a `line` / `area` chart; it SHALL produce a bar / table / waffle or a safe empty state with a recorded reason.
- The same logical shape rendered as a multi-email dataset (≥ 2 distinct source-email dates) SHALL be eligible for a `line` chart whose X-axis is the date field.

## Two scenarios

- Single-email scope (`purpose: visualize`) SHALL NOT claim a trend from a snapshot; titles SHALL describe that email's own data.
- Multi-email scope (`purpose: analyze`) SHALL support cross-email comparison (ranked bars, small multiples, slope, or trend over email dates) and SHALL carry multi-source provenance.

## Visual system

- `monoValidator` SHALL pass on every generated artifact: no non-ladder color, no `Math.random`, no duplicate id, no failing inline-script syntax.
- The validator SHALL be path-separator-safe (passes identically on Windows and POSIX).
- No branded / saturated color SHALL remain in `DesignRenderer` output.

## Shell and legibility

- Every artifact SHALL render the WeMail brand header (logo mark + wordmark).
- Every chart and the report SHALL show a data-source / provenance line bound to `dataset.provenance`; a missing source SHALL show a safe state, never a fabricated string.
- Source / caption / axis text SHALL clear the contrast floor and minimum font sizes.

## Viewer runtime

- Filter (auto-generated from low-cardinality dimensions), column sort, copy-value (click cell → clipboard + toast), and CSV export SHALL work in the artifact viewer.
- CSV export SHALL respect the active filter.

## Trust invariants (unchanged)

- The model SHALL emit no HTML / JS; CSP SHALL remain locked to vendored / local resources only.
- Every chart / metric / table value SHALL bind to a dataset field; fabrication SHALL fail validation.

## Verification commands

- `npm run typecheck:server`, `npm run typecheck:desktop`, and focused renderer / automation tests. Exact commands and measured results are recorded here at acceptance time.

## Verified — 2026-07-31

- `npm run typecheck:server` — pass (exit 0).
- `npm run typecheck:desktop` — pass (exit 0).
- `npm run typecheck` (`react-router typegen && tsc -b`, covers renderer/electron/server) — pass (exit 0).
- `node --import tsx --test server/wemail/design/DesignArtifactPipeline.test.ts` — 10/10 pass. Includes the original-bug regression (snapshot + "趋势" → no line), multi-point time series → line allowed, 占比 → waffle, cross-unit aggregation refused, brand header + source line present, exactly one trusted `<script id="wemail-viewer-runtime">`, no `src`, and `validateArtifactHtml` (mono validator) passing on real output.
- `openspec validate design-artifact-mono-redesign --strict` — `Change is valid`.

### End-to-end (mail → dataset → chart → publish)

- `node --import tsx --test server/wemail/automation/MonitoringBotAutomation.acceptance.test.ts` — pass. The full monitoring-mail → extract → design → render (line chart) → publish → bot route works with the mono renderer.
- `server/wemail/automation/SubscriptionInsightAutomation.acceptance.test.ts` — pass.
- `server/wemail/configuration/AutomationAuthoringAgentService.acceptance.test.ts` — pass (line-chart preview before rule creation).

### Refinement found during e2e verification

Running the monitoring e2e caught two temporal-detection bugs the unit tests missed, both fixed in `DesignRecipeCompiler.isTemporalAxis`:
- It first rejected legitimate intra-day `HH:MM` string series (the monitoring "时段" field) — the old test only passed via the `forceLine` "趋势" keyword. Fixed by accepting date/time-like string fields.
- `Date.parse("37573")` returns a timestamp in V8, so a numeric measure was mis-flagged as a time axis. Fixed by pattern-matching (`^\d{4}-\d{1,2}-\d{1,2}` / `^\d{1,2}:\d{2}`) on string fields instead of bare `Date.parse`, and excluding number-typed fields.

### Notes

- 5.4 viewer runtime implemented as a trusted, SHA-256-bound inline script under `sandbox="allow-scripts allow-downloads"` (no `allow-same-origin`). Clipboard copy degrades to `execCommand` then a value toast if the sandbox blocks `navigator.clipboard`; CSV export uses a Blob URL (requires `allow-downloads`, present). Live clipboard/download behavior in the Electron sandbox is not unit-tested here and should be confirmed in a manual/e2e pass.

