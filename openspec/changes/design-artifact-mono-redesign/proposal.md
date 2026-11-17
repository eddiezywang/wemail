## Why

The current data-report / design-artifact pipeline (`server/wemail/design/`) decides chart type, axes, and titles with keyword regex in `DesignRecipeCompiler.buildCharts`. In production this produced self-contradictory charts — e.g. a "值趋势" line whose subtitle said "按时间观察变化" but whose X-axis was a categorical channel field, because the word "趋势" in the agent prompt triggered `forceLine` even though the dataset had no temporal field. The renderer (`DesignRenderer`) hand-rolls thin SVG/CSS with a branded-color palette, ships no WeMail brand header, no data-source/provenance line, and none of the viewer-level interactivity its own `runtimeCapabilities: ["table-sort","copy-value"]` claims to provide.

A side-by-side evaluation of the installed `lieflat-charts` skill showed its mono / editorial visual language reads as more polished and legible for this content. The decision is to adopt that visual language as the rendering standard — **ported into our trusted renderer, not vendored as a skill**: lieflat generates standalone HTML for non-programmers and lacks provenance binding, brand header, and viewer runtime. The model still emits only a thin data-logic spec; the renderer owns all visuals. This change also makes the two real usage scenarios explicit, because they change which chart families are honest.

## What Changes

- **Port the mono design system** from `lieflat-charts` into `DesignRenderer`: the grayscale token ladder (`mono-tokens.js` — ink/paper/muted/grid, 7-step ladder, capsule bar radius, Inter typography, quarticOut motion) becomes the single source of truth for chart visuals, replacing the current branded-color `styles()`. A repo-local validator enforces "明度即数据" (importance = darkness, fixed ladder order; no saturated color), mirroring lieflat's `validate.mjs`.
- **Fix chart-type selection.** The model emits a thin spec (`{family, x, y, splitBy?, agg?, where?, top?}`); `DesignRecipeCompiler` becomes a validator + expander, not a keyword guesser. Guardrails: refuse `line`/`area` without a temporal field; refuse summing across units; assign series colors in fixed ladder order; 占比 defaults to **dot-waffle**, not pie.
- **Two scenarios, explicit:**
  1. *Single-email visualization* (`purpose: visualize`, one source email): faithfully chart that email's structured data; a single-time-point snapshot MUST NOT produce a trend line; titles state what the email's data shows.
  2. *Multi-email correlation / horizontal comparison* (`purpose: analyze`, multiple same-type source emails): cross-email comparison — ranking, deltas, small multiples, and trends where **the source emails' dates are the temporal axis** (trends become legitimate here). Cross-email conclusions require multi-source provenance.
- **Report shell additions:** a WeMail logo / brand header at the top of every artifact, and a real data-source / provenance line on every chart and at the report level (bound to `dataset.provenance`, never fabricated). Legibility floor enforced (source/caption text clears contrast minimums; minimum font sizes).
- **Viewer runtime:** implement the already-declared `table-sort` and `copy-value` capabilities, plus filter and CSV export, in the artifact viewer — all renderer-side, zero model tokens.
- **Skill / prompt:** port lieflat's data-shape→chart decision tree, conclusion-as-title rule, 14-point self-check, and "when to say no" into `WemailDesignSkill`, so the model picks honest chart families and writes conclusion titles.
- **Trust invariants preserved:** the model never emits HTML/JS; only vendored libraries (Chart.js / ECharts) run; CSP stays locked; every value binds to real dataset fields.

## Capabilities

### Modified

- `design-artifact-generation`: mono design system; thin-spec → validator+expander compiler with guardrails; two-scenario chart selection (single visualize vs multi analyze); logo + provenance; conclusion-titled cards; legibility floor.
- `application-message-artifact-viewer`: implement filter / sort / copy-value / export viewer runtime; brand header; legibility.

## Impact

- `server/wemail/design/DesignRenderer.ts`, `DesignRecipeCompiler.ts`, `InsightReportTemplates.ts` — rewrite visual system + selection logic.
- `shared/wemail/designArtifacts.ts` — thin chart spec + scenario/provenance fields.
- `server/wemail/agent/WemailDesignSkill.ts` — decision tree, conclusion titles, self-check, two-scenario guidance.
- `server/wemail/design/AgentArtifactDeliveryService.ts` — validation boundary (guardrails).
- Renderer artifact viewer — viewer runtime + brand header.
- `prototype/echarts-thin-spec/lieflat-full.html` is the visual reference; `report.html` (branded) is retired.
- `~/.claude/skills/lieflat-charts` stays installed as an invokable reference skill (PolyForm Noncommercial; app is non-commercial).

## Success Criteria

- No self-contradictory chart can be produced: a snapshot dataset never yields a trend line; a multi-email dataset can.
- Single-email and multi-email scenarios select chart families appropriate to their data shape and source count.
- All chart color/typography comes from the mono token ladder (validator passes; no saturated/branded colors remain).
- Every artifact shows the WeMail brand header and a non-fabricated data-source/provenance line; text clears the legibility floor.
- The viewer supports filter, sort, copy-value, and CSV export.
- Existing trust invariants hold (model emits no code; CSP locked; every value bound to a dataset field).
