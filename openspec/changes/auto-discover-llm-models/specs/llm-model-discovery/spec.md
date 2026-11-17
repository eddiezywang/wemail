# LLM Model Discovery

## Requirements

### Requirement: Discover models without saving settings

WeMail SHALL provide a model discovery operation that uses submitted or locally stored credentials without persisting configuration or generating model output.

#### Scenario: OpenAI-compatible discovery succeeds

- **WHEN** a valid OpenAI-compatible Base URL and API key expose a model list
- **THEN** WeMail returns deduplicated model ids and factual ownership metadata
- **AND** reports the detected protocol
- **AND** does not alter saved LLM settings

#### Scenario: Anthropic discovery succeeds

- **WHEN** an Anthropic endpoint exposes its model list
- **THEN** WeMail uses Anthropic authentication and version headers
- **AND** returns normalized model ids

### Requirement: Manual model entry remains available

The model picker SHALL remain editable regardless of discovery support or outcome.

#### Scenario: Discovery is unsupported

- **WHEN** the configured endpoint rejects or does not implement model listing
- **THEN** the UI explains that models could not be fetched
- **AND** the user can type a model id and continue to the existing save-time validation

#### Scenario: Existing model is missing from refreshed results

- **WHEN** a saved or typed model id is not present in a refreshed list
- **THEN** the UI preserves it as a custom current value

### Requirement: Model presentation is factual

The model picker SHALL NOT infer quality, speed, price, suitability, or capabilities from a model id.

#### Scenario: Model list is rendered

- **WHEN** discovered models are displayed
- **THEN** each option displays its id and only metadata returned by the endpoint or local selection state
