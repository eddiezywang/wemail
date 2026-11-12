## MODIFIED Requirements

### Requirement: Chart selection is semantically appropriate and bounded
The design skill SHALL accept a thin data-logic chart spec (`family`, `x`, `y`, optional `splitBy`, `agg`, `where`, `top`) from the model and SHALL resolve the final chart type from the dataset's shape, never from keywords in the prompt. The compiler SHALL validate each spec against the dataset and SHALL refuse charts whose encoding contradicts the data: a `line` or `area` chart SHALL require a temporal field with more than one distinct date; an aggregation SHALL NOT cross mixed units; a share / 100%-构成 chart SHALL default to dot-waffle rather than a pie. A refused spec SHALL yield a safe empty or partial state with a recorded reason and SHALL NOT produce a fabricated chart.

#### Scenario: Snapshot dataset with "趋势" in the prompt
- **WHEN** the dataset has no temporal field and the agent prompt or objective contains "趋势" or "trend"
- **THEN** the compiler SHALL NOT emit a `line` or `area` chart
- **AND** SHALL produce a bar, table, or waffle, or a safe empty state with the reason "no temporal dimension"

#### Scenario: Multi-email dataset provides a temporal axis
- **WHEN** the dataset has at least two distinct source-email dates
- **THEN** the compiler SHALL treat those dates as a temporal field
- **AND** a `line` chart SHALL be permitted with the date field on the X-axis

#### Scenario: Share of a whole
- **WHEN** the chart encodes a part-of-whole / 100% composition
- **THEN** the compiler SHALL default to a dot-waffle
- **AND** SHALL use a donut only when waffle cannot carry the shape, with a recorded reason

#### Scenario: Aggregation crosses mixed units
- **WHEN** a requested aggregation would sum or average values whose declared units differ
- **THEN** the compiler SHALL refuse the aggregation with a reason
- **AND** SHALL NOT produce a chart that compares incomparable units on one axis

### Requirement: Design mode selection follows explicit intent and data characteristics
The design skill SHALL distinguish two scenarios from the source scope: single-email visualization (one source email, `purpose: visualize`) and multi-email correlation (multiple same-type source emails, `purpose: analyze`). A single-email snapshot SHALL NOT yield a trend chart or a cross-source conclusion. A multi-email dataset SHALL support horizontal comparison across the source emails, using their dates as the temporal axis where relevant, and SHALL require multi-source provenance for any cross-email conclusion.

#### Scenario: Single email is visualized
- **WHEN** the dataset originates from one source email and has a single observation point
- **THEN** the skill SHALL choose `purpose: visualize`
- **AND** SHALL NOT produce a trend chart or a conclusion that claims change over time

#### Scenario: Multiple same-type emails are correlated
- **WHEN** the dataset originates from more than one same-type source email
- **THEN** the skill SHALL choose `purpose: analyze`
- **AND** SHALL support cross-email comparison families (ranked bars, small multiples, slope, trend over email dates)
- **AND** SHALL bind every cross-email conclusion to multi-source provenance

## ADDED Requirements

### Requirement: Chart visuals follow the mono editorial design system
Every chart and report SHALL render in the mono design system: a grayscale token ladder (ink, paper, muted, faint, grid, fixed-order series ladder), Inter typography, capsule bar ends, and `quarticOut` motion. Series colors SHALL be assigned by importance along the ladder in fixed order and SHALL NOT be cycled or re-ordered by rank. A validator SHALL reject any non-ladder (saturated) color, `Math.random` usage, duplicate element ids, and failing inline-script syntax, and SHALL be path-separator-safe across Windows and POSIX.

#### Scenario: Artifact uses only ladder colors
- **WHEN** the renderer produces an artifact
- **THEN** every chart color SHALL come from the mono token ladder
- **AND** the validator SHALL fail on any saturated or branded color value

#### Scenario: Multi-series importance mapping
- **WHEN** a chart shows more than one series
- **THEN** the most important series SHALL be the darkest ladder step
- **AND** a change in series ranking SHALL NOT repaint surviving series

#### Scenario: Chart title carries a conclusion
- **WHEN** a chart is titled
- **THEN** the title SHALL state a judgment about the data
- **AND** SHALL NOT be a bare chart-type name

### Requirement: Artifacts carry a WeMail brand header and data-source line
Every artifact SHALL render a WeMail brand header at the top (logo mark and wordmark). Every chart and the report SHALL display a data-source line bound to `dataset.provenance`. When provenance is unavailable the renderer SHALL show a safe "source unavailable" state and SHALL NOT fabricate a source string.

#### Scenario: Artifact is opened
- **WHEN** any formal artifact is rendered
- **THEN** it SHALL display the WeMail brand header
- **AND** each chart SHALL display a data-source line resolving to real provenance

#### Scenario: Provenance is missing
- **WHEN** a chart's source cannot be resolved to dataset provenance
- **THEN** the renderer SHALL show a safe unavailable state
- **AND** SHALL NOT invent a source label

### Requirement: Chart and text output meets a legibility floor
Source, caption, legend, and axis text SHALL clear a minimum contrast ratio against its surface and a minimum font size. Information that cannot fit at or above the floor SHALL be moved to hover / tooltip or omitted, never shrunk below the floor. The renderer SHALL honor `prefers-reduced-motion` for all transitions.

#### Scenario: Caption text is legible
- **WHEN** a source line, caption, or axis label is rendered
- **THEN** its color and size SHALL clear the configured contrast and font-size floor
- **AND** a too-small label SHALL be moved to hover rather than shrunk to fit
