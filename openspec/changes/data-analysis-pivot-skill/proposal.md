## Why

The design-artifact pipeline renders a flat dataset into charts, but it does not ANALYZE the data: no dimension inference, no preset analytical pivots, no period-over-period comparison. Users need data 透视 (multi-dimensional analysis) from monitoring emails — to surface problems text cannot — not decoration. The current single-aggregate charts do not serve that.

## What Changes

Split the work into two layers:

- **Layer 1 — Data Analysis Skill** (`server/wemail/analysis/`, new): a generic HTML-table extractor; dimension inference (time / type / status / measure); six preset analytical pivots; period-over-period (环比) and year-over-year (同比) computation. Produces an analysis-ready dataset + a set of chart specs (the pivots) + insight strings.
- **Layer 2 — Chart Skill** (`server/wemail/design/`, existing, lieflat-styled): consumes the analysis output and renders it as a single HTML artifact (mono + muted palette, lieflat layout). No behaviour change to the rendering contract beyond consuming pivots and rendering switchable alternate views + raw-table detail.

### Constraints (locked)

- Single HTML output. **No client-side ECharts / chart library.** Interactivity (filter/sort/copy/export/view-toggle) is the trusted viewer runtime only.
- "Data pivoting" is a fixed set of six preset views driven by inferred dimensions — not a fully dynamic pivot engine.
- Switchable views (e.g. total vs per-type) are pre-rendered as alternate SVGs; the viewer runtime toggles visibility. No client-side re-charting.

## The dimension framework

A monitoring dataset has at least: **time** (hour/date — always) + **type** (one categorical: model / channel / order-type / customer-type / endpoint / scenario …). Optionally: **status** (success/fail) + **measures** (count / latency / amount / rate).

## The six preset pivots

| Pivot | Dimensions | Chart | Question |
|---|---|---|---|
| A total trend | time × measure(sum) | line | volume over time |
| B by-type trend | time × type | multi-series line | each type over time (= "per-model") |
| C type share | type × measure | waffle/bar | which type dominates |
| D outcome | status × time or status × type | stacked / heatmap | success/failure distribution |
| E peak/anomaly | time extrema | peak annotation | peak hours / anomalous days |
| F type ranking | type top-N × measure | bar | biggest/smallest types |

"Total ↔ per-type" switch = pivot A vs B, pre-rendered, viewer toggles.

## Capabilities

### New
- `data-analysis-pivot`: generic HTML-table extraction, dimension inference, six preset pivots, 环比/同比.

### Modified
- `design-artifact-generation`: consume pivot chart specs; render switchable alternate views; render raw-table detail (multiple original tables, per-table + combined export).

## Impact
- New `server/wemail/analysis/` (extractor, dimension inferrer, pivot generator, comparison calculator).
- `shared/wemail/automation.ts`: preserve raw tables (`rawTables`), analysis dimensions.
- `server/wemail/design/`: render pivots, switchable views, raw-table detail.
- `WemailDesignSkill`: two-layer guidance (analysis skill produces pivots; chart skill renders).

## Success Criteria
- Given a monitoring dataset, dimensions are inferred correctly (time/type/status/measure).
- The six applicable pivots are generated as chart specs (skipping any whose dimensions are absent).
- A 7-day monitoring dataset yields a total-trend + per-type-trend that the viewer can toggle between, single-HTML, no ECharts.
- Detail section reproduces the original tables (multiple), each exportable, plus combined export.
- 环比 computed when ≥2 periods exist; 同比 shows an honest "insufficient history" state otherwise.
