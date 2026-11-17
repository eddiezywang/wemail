## MODIFIED Requirements

### Requirement: Complete artifacts open inside an isolated WeMail viewer
The client SHALL open validated artifacts inside the workbench using an opaque-origin sandboxed browser surface and SHALL provide the data-interaction capabilities declared by the artifact manifest as application-owned trusted runtime. For any artifact that contains a data table, the viewer SHALL support filtering by low-cardinality dimensions, column sorting, copy-value on cell click, and CSV export of the currently filtered rows — all through the trusted runtime, never through artifact-authored JavaScript.

#### Scenario: User opens a report with a data table
- **WHEN** the selected artifact contains a tabular component
- **THEN** the viewer SHALL offer filter, column sort, copy-value, and CSV export controls
- **AND** these controls SHALL be auto-generated from the table's column cardinality by the trusted runtime

#### Scenario: User opens a deck
- **WHEN** the selected artifact kind is `deck`
- **THEN** the viewer SHALL provide a fixed 16:9 stage, keyboard navigation, page count, optional fullscreen, and reduced-motion behavior

#### Scenario: Artifact is unavailable or invalid
- **WHEN** the artifact expired, is missing, fails hash validation, or cannot be rendered safely
- **THEN** the message SHALL remain readable from its persisted summary
- **AND** the viewer SHALL show an actionable unavailable state without executing partial content

## ADDED Requirements

### Requirement: The artifact viewer provides data-interaction capabilities that cost the model nothing
The viewer runtime SHALL provide table filter, column sort, copy-value, and CSV export as trusted renderer-side capabilities. Filter controls SHALL be generated automatically from low-cardinality columns. CSV export SHALL emit the currently filtered rows with a UTF-8 BOM. None of these capabilities SHALL require the model to emit additional spec, markup, or script.

#### Scenario: Filter and export are consistent
- **WHEN** a user applies a filter and then exports
- **THEN** the exported CSV SHALL contain only the rows matching the active filter
- **AND** SHALL be encoded UTF-8 with BOM

#### Scenario: Copy a value
- **WHEN** a user clicks a data cell
- **THEN** the cell's value SHALL be copied to the clipboard
- **AND** the viewer SHALL show a non-blocking confirmation

#### Scenario: Auto-generated filter controls
- **WHEN** a table has a string column with low cardinality
- **THEN** the viewer SHALL render a pill or select filter for that column
- **AND** SHALL NOT require the model to declare the filter
