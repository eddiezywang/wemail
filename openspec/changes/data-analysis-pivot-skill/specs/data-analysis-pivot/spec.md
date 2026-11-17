## ADDED Requirements

### Requirement: The system infers analytical dimensions from a dataset
The data-analysis skill SHALL infer, from a dataset's schema and values, which fields are TIME (date/hour), which are TYPE (low-cardinality categorical), which is STATUS (success/fail), and which are MEASURES (numeric). Inference is automatic — no caller-declared dimension map.

#### Scenario: monitoring dataset with date, model, status, count
- **WHEN** a dataset has a date field, a low-cardinality string field (model), a status-named string field (deal_status), and a number field (cnt)
- **THEN** the skill SHALL classify them as time / type / status / measure respectively

#### Scenario: a dimension is absent
- **WHEN** the dataset has no date/hour field
- **THEN** the time dimension SHALL be empty, and pivots that need time SHALL be skipped (no empty chart produced)

### Requirement: Six preset analytical pivots are generated from the inferred dimensions
The skill SHALL emit, as chart specs, the preset pivots that the inferred dimensions support: total trend (time × measure), by-type trend (time × type, multi-series), type share (type × measure), outcome (status × type|time), and type ranking (type top-N × measure). Pivots whose required dimensions are absent SHALL be omitted.

#### Scenario: time + type + status + measure all present
- **WHEN** all four dimension classes are present
- **THEN** the skill SHALL emit a total-trend line, a by-type multi-series line, a type-share waffle, an outcome stacked-bar, and a type-ranking bar

#### Scenario: total vs per-type are a switchable pair
- **WHEN** both a total trend and a by-type trend are generated
- **THEN** Layer 2 SHALL pre-render both as alternate SVGs and the viewer runtime SHALL toggle visibility between them (single HTML, no client-side chart library)

### Requirement: Period-over-period comparison is computed when history exists
The skill SHALL compute 环比 (latest period vs previous period, absolute and percent) when at least two periods of data exist, and SHALL present an honest "insufficient history" state for 同比 (year-over-year) when no year-ago data is available.

#### Scenario: two days of data
- **WHEN** the dataset spans at least two distinct time-period values
- **THEN** the skill SHALL compute the period-over-period delta for the primary measure
