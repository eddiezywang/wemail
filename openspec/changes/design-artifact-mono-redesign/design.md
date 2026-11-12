# Design — Mono Data Report Redesign

## Context

The `design-artifact-generation` capability (added by `agent-automation-design-artifacts`) compiles a `DesignRecipe` from a dataset and renders it through a trusted deterministic renderer (`DesignRecipeCompiler` + `DesignRenderer`). Two defects surfaced in production:

1. **Chart-type selection is a keyword heuristic.** `DesignRecipeCompiler.buildCharts` decides line-vs-bar from regex on the agent prompt (`forceLine = /折线|趋势/`), independent of the dataset's actual shape. With no temporal field present, it produced a "值趋势" line whose subtitle claimed "按时间观察变化" while the X-axis fell back to a categorical field — a self-contradictory chart by construction.
2. **The visual layer is unbranded and partly inert.** `DesignRenderer` hand-rolls thin SVG/CSS in a branded-color palette with no WeMail header, no data-source line, and the viewer capabilities its own `runtimeCapabilities` declares (`table-sort`, `copy-value`) are not implemented.

A side-by-side evaluation against the installed `lieflat-charts` skill showed its mono / editorial visual language — grayscale ladder, conclusion-style titles, capsule bars, hairline lines, dot-waffle for shares — reads as more legible and polished for this content. The user approved adopting that visual language as the standard.

## Goals

- Chart type chosen from data shape, never from prompt keywords; self-contradictory charts impossible.
- One visual language (mono) across every chart and report, enforced by a validator.
- Two usage scenarios handled explicitly and differently: single-email visualize vs multi-email horizontal comparison.
- Every artifact carries the WeMail brand header and a non-fabricated data-source line; text clears a legibility floor.
- Viewer runtime (filter / sort / copy-value / export) implemented, renderer-side, zero model tokens.
- Trust invariants unchanged: model emits no code; CSP locked; every value bound to dataset provenance.

## Non-Goals

- Changing the model → spec → trusted-renderer architecture (kept).
- Supporting branded / color chart styles. Mono only; users wanting color need a different skill (lieflat's "say no").
- Geographic / choropleth charts (no mapping pipeline).
- Replacing Chart.js or ECharts. Mono tokens are library-agnostic; both remain.

## The two scenarios

The pipeline already distinguishes `purpose: visualize` (single source email) from `purpose: analyze` (multiple). This change makes that split carry chart-selection consequences:

| | Single-email (`visualize`) | Multi-email (`analyze`) |
|---|---|---|
| Source | one email's structured data | N same-type emails |
| Temporal axis | none (snapshot) | source-email dates |
| Trend chart | forbidden (no time dimension) | allowed (dates = temporal) |
| Conclusions | what this email shows | cross-email comparison |
| Families | chunky bar, hairline line*, dot waffle, basics | + ranked bars, small multiples, slope |

*hairline line is permitted only when a real temporal field exists; in single-email scope that means the email itself contains a time series, not a snapshot.

This is the same mechanism as the temporal guardrail: a field is temporal only with **>1 distinct parseable date**. A snapshot has none, so `line` is refused; multi-email dates qualify, so `line` becomes honest. The original bug is therefore impossible in either scenario.

## Mono design system

Port `mono-tokens.js` into `server/wemail/design/monoTokens.ts` as the single source of truth: ink `#1C1C1A` / paper `#F0EFEB` / muted / faint / grid, a 7-step gray ladder `L` and 5-step `LAD`, dark-card variants, Inter typography tokens, capsule `barRadius`, `cardRadius` 24, `quarticOut` motion, `obsReveal`, deterministic `rnd`. The validator (`monoValidator.ts`) enforces ladder-only color (reject saturated values), bans `Math.random`, checks duplicate ids, and syntax-checks inline `<script>` — and is path-separator-safe, fixing lieflat's Windows-backslash self-skip bug (the validator must compare relative paths with `path.sep` awareness, not a forward-slash literal). "明度即数据": series colors are assigned by importance along the ladder in fixed order, never cycled or re-ordered by rank.

The tokens are library-agnostic (Chart.js, ECharts, and hand-written SVG all consume them — lieflat itself mixes all three), so the renderer keeps its engines and swaps only the design system.

## Chart selection: thin spec + guardrails

The model emits only a thin data-logic spec: `{ family, x, y, splitBy?, agg?, where?, top? }`. `DesignRecipeCompiler` becomes a **validator + expander**, not a keyword guesser: it resolves `family` (from the spec, or inferred from data shape when omitted), binds `x` / `y` / `splitBy` to real dataset fields, and enforces:

- **No `line` / `area` without a temporal field** (>1 distinct parseable date; multi-email source dates qualify).
- **No aggregation across mixed units** (detect via a `unit`-like column or divergent field labels).
- **占比 defaults to dot-waffle**, not pie.
- **Series colors in fixed ladder order** by importance.

A rejected spec returns a safe empty / partial state with a reason; it never fabricates a chart.

## Why port, not vendor

`lieflat-charts` is an LLM-facing skill that produces standalone HTML for non-programmers. WeMail needs server-rendered-from-spec artifacts embedded in the app, with a viewer runtime, provenance binding, and a brand header — none of which lieflat provides, and all of which are existing WeMail invariants. Vendoring the skill as-is would duplicate the render path and bypass provenance. Porting the tokens + template skeletons into the existing trusted renderer adopts the visual language without weakening invariants. The skill stays installed as an invokable reference for ad-hoc charts (PolyForm Noncommercial; the app is non-commercial).

## Report shell and viewer

- **Brand header**: logo mark + WeMail wordmark + report meta at the top of every artifact.
- **Data-source line**: report-level and per-chart, bound to `dataset.provenance`; never fabricated.
- **Legibility**: source / caption / axis text must clear a contrast floor; minimum font sizes enforced (SVG half-card 6.5px / wide 5.5px; HTML source ≥ 10.5px and contrast-checked). lieflat's over-faint `.src` is deliberately darkened.
- **Viewer runtime**: filter (auto-generated from low-cardinality dimensions), column sort (▲/▼), copy-value (click cell → clipboard + toast), CSV export (current filter, UTF-8 BOM). Declared in `runtimeCapabilities`; all renderer-side; zero model tokens.

## Risks and mitigations

- **Mono may read as plain for monitoring dashboards.** Accepted by user decision; mono is the standard. A future need for status colors maps onto the dark-card / importance ladder, not categorical hues.
- **Porting templates is manual work.** Bounded: port the families the two scenarios need first (chunky bar, hairline line, dot waffle, ranked / small multiples), extend later.
- **Guardrail false positives** (refuses a legitimate chart). Mitigated by returning a reason and a safe fallback, and by inferring family from data shape when the model omits it.
