## Implementation Boundaries

- Mono design system + validator: `server/wemail/design/monoTokens.ts` and `server/wemail/design/monoValidator.ts`.
- Compiler + renderer: `server/wemail/design/DesignRecipeCompiler.ts`, `DesignRenderer.ts`, `InsightReportTemplates.ts`.
- Shared contracts: `shared/wemail/designArtifacts.ts`.
- Skill prompt: `server/wemail/agent/WemailDesignSkill.ts`.
- Delivery boundary: `server/wemail/design/AgentArtifactDeliveryService.ts`.
- Viewer runtime: `server/wemail/design/DesignRenderer.ts` (trusted hashed script) + `app/components/applicationMessages/ArtifactViewer.tsx` (sandbox).
- Visual reference: `prototype/echarts-thin-spec/lieflat-full.html`.

Sections are dependency ordered. 1–2 form Gate A, 3–4 Gate B, 5 Gate C, 6 Gate D, 7 Gate E.

## 1. Mono Design System Port

- [x] 1.1 Port `mono-tokens.js` into `server/wemail/design/monoTokens.ts` — ink/paper/muted/faint/grid, ladders, dark variants, Inter, capsule/bar radius, quarticOut, `obsReveal`, `rnd`, `seriesColor`, `CARD_CSS`.
- [x] 1.2 Port the validator into `monoValidator.ts` — saturated-color ban, `Math.random` ban, dup-id, inline-script syntax; path-separator-safe `relativePath` (fixes lieflat's Windows self-skip bug).
- [x] 1.3 Retire the branded-color palette in `DesignRenderer.styles()`; every color/typography value routed through mono tokens (saturated `#d86145`/`#356b86`/`#a65d20` removed; mono validator passes on output).

## 2. Contracts

- [x] 2.1 `ChartFamily` + `ThinChartSpec` in `shared/wemail/designArtifacts.ts`; `waffle` added to `ChartSpec.type`.
- [x] 2.2 `scope` on `DesignRequest`/`DesignRecipe` + `provenance` block; `DesignRecipeCompiler` populates them from `dataset.provenance`.
- [x] 2.3 Per-chart `source` + report-level provenance stamp in the recipe contract.

## 3. Compiler: Validate + Expand

- [x] 3.1 `buildCharts` keyword logic replaced: `request.charts` (thin spec) expanded via `expandThinCharts`; otherwise inferred from data shape. `x`/`y`/`splitBy` bound to real fields.
- [x] 3.2 Guardrails: line/area require temporal; aggregation crossing mixed units refused; series colors fixed ladder order.
- [x] 3.3 Temporal detection requires **>1 distinct parseable date** (the original bug). Snapshot → no trend; multi-email dates qualify.
- [x] 3.4 占比 defaults to `waffle` (thin spec `family:"waffle"` → `ChartSpec.type:"waffle"`).

## 4. Renderer: Mono Family Templates

- [x] 4.1 Mono family renderers: bar (capsule + solid), line (grid-line kept, mono), waffle (new, dot grid + legend).
- [x] 4.2 Two-scenario handling via compiler temporal logic: snapshot → no trend chart; multi-point → line permitted.
- [x] 4.3 Conclusion-style titles + four-piece card (h2 + sub + chart + source).

## 5. Report Shell + Viewer Runtime

- [x] 5.1 WeMail brand header (logo mark + wordmark) in the artifact shell.
- [x] 5.2 Data-source/provenance line at report level (footer) and per-chart, bound to `dataset.provenance`.
- [x] 5.3 Legibility: source text at `#6A6963` / 10.5px (contrast floor); mono token enforcement via validator.
- [x] 5.4 Viewer runtime: trusted app-owned script emitted by `DesignRenderer`, bound by its SHA-256 in CSP (`script-src 'sha256-…'`), iframe sandbox `allow-scripts allow-downloads` (no `allow-same-origin`). Provides filter (auto-generated), column sort, copy-value, CSV export — zero model tokens.

## 6. Skill / Prompt (`WemailDesignSkill`)

- [x] 6.1 Data-shape→chart decision tree + candidate-audit guidance.
- [x] 6.2 Conclusion-as-title rule, self-check, "when to say no".
- [x] 6.3 Two-scenario guidance (single visualize / multi analyze, dates = temporal).

## 7. Acceptance

- [x] 7.1 Regression tests: snapshot + "趋势" → no line; multi-point → line allowed; 占比 → waffle; mixed-unit → refused.
- [x] 7.2 `monoValidator` passes on generated artifacts (asserted in test).
- [x] 7.3 Trusted-script invariant asserted: exactly one `<script id="wemail-viewer-runtime">`, no `src`, no inline handlers.
- [x] 7.4 Trust invariants: model emits no HTML/JS; CSP locked to the single hashed script; every value bound to a dataset field.
- [x] 7.5 `typecheck:server`, `typecheck:desktop`, full `tsc -b`, `DesignArtifactPipeline.test.ts` (10/10), and `openspec validate --strict` all pass.
