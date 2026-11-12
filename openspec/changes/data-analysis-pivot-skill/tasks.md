## Two-layer split

- Layer 1 (data analysis): `server/wemail/analysis/`.
- Layer 2 (chart skill): `server/wemail/design/` (existing).

## 1. Layer 1 — Data Analysis Skill

- [x] 1.1 Generic HTML-table extractor `extractHtmlTables` — tolerant of malformed tags; ANY sender.
- [x] 1.2 `inferDimensions` — schema+value based: date/hour→time, low-card string→type, status→status, number→measure.
- [x] 1.3 `generatePivots` — six preset pivots; A+B tagged switchGroup "trend" + span "full".
- [x] 1.4 `computeComparison` — 环比 (Δ+%) and 同比 (insufficient-history state).
- [x] 1.5 `rawTables` contract on `AutomationDataset` + `htmlTableDataset` product-ready function.
- [x] 1.6 Tests: dimension inference, pivot generation, skip-absent, 环比 math, HTML extractor (7/7 pass).

## 2. Layer 2 — Chart Skill (render the analysis)

- [x] 2.1 `compile({autoPivot:true})` runs inferDimensions + generatePivots + expandThinCharts automatically.
- [x] 2.2 Switchable views: A (total) + B (per-type) → one full-width card, viewer toggles. No ECharts.
- [x] 2.3 Adaptive sizing: span "full" → grid-column 1/-1 (complex charts not squeezed).
- [x] 2.4 Raw-table detail rendering: `renderRawTables` renders each `dataset.rawTables[]` entry as a separate table (original columns/rows, no re-aggregation); viewer auto-enhances each (filter/sort/copy/export).
- [x] 2.5 环比 insight callout: autoPivot prepends a "环比变化" callout with Δ+%.
- [x] 2.6 Chart fixes: switch button 14px; hover 2D distance; axis darker (#8F8E88, stroke-width 1.5).

## 3. Wiring + skill prompt

- [x] 3.1 Wire Layer 1 → Layer 2: autoPivot end-to-end (dataset → infer → pivots → compile → render).
- [x] 3.2 `WemailDesignSkill` §7: default 7-day, day+hour comparison, multi-series splitBy=date.
- [x] 3.3 `htmlTableDataset`: product-ready function (messages → dataset + rawTables) for processor integration.

## 4. Acceptance

- [x] 4.1 typecheck:server pass; analysis 7/7 + design 15/15 tests pass.
- [x] 4.2 autoPivot sample: 7-day × model × status → 5 pivots + switchable trend card + 环比 callout.
- [x] 4.3 Extractor + htmlTableDataset verified on real IDAS data (24 emails → 84 rows → 540K calls); product function ready for processor wiring.
- [x] 4.4 Raw-table detail: per-table export (viewer auto-enhances each table) + combined export ("全部导出 CSV" button).
