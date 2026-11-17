## ADDED Requirements

### Requirement: Unified LlmClient interface

The system SHALL expose a single `LlmClient.generate(request)` method with concrete adapters for OpenAI-compatible endpoints and for the Anthropic Messages API.

#### Scenario: OpenAI-compatible adapter is pluggable

- **WHEN** `LlmClient` is configured with an OpenAI-compatible provider
- **THEN** `generate` SHALL issue a request to the configured base URL + model
- **AND** SHALL return normalized `{ text, json?, usage }` to the caller

#### Scenario: Anthropic Messages adapter is pluggable

- **WHEN** `LlmClient` is configured with the Anthropic Messages provider
- **THEN** `generate` SHALL issue a Messages-API request with the same `system + user` inputs
- **AND** SHALL return normalized `{ text, json?, usage }`

### Requirement: Fixed summary prompt

The system SHALL use one fixed summary prompt (system + user templates + JSON schema) across all summary generations in phase one.

#### Scenario: Prompt is not user-configurable

- **WHEN** `SummaryProcessor` builds a request for any message
- **THEN** it SHALL use the exported constants from `server/wemail/ai/prompts/summaryPrompt.ts`
- **AND** it SHALL NOT read a prompt override from the database, configuration, or request body

### Requirement: SummaryProcessor with retry ≤ 2

The system SHALL process `summary` jobs via `SummaryProcessor`, persisting a structured `SummaryResult` into `mail_ai_artifacts`, and SHALL retry a failed summary job at most two times before marking it `failed`.

#### Scenario: Successful summary persisted

- **WHEN** `SummaryProcessor.handle(job)` completes successfully
- **THEN** a row SHALL be written to `mail_ai_artifacts` containing the validated JSON summary for `messageId`
- **AND** the job SHALL be marked `done`

#### Scenario: Retry cap at two

- **WHEN** `SummaryProcessor.handle(job)` has already failed twice (attempts = 2)
- **THEN** the next failure SHALL NOT schedule another retry
- **AND** the job SHALL be marked `failed` with `last_error` set (error code only, no body content)

### Requirement: Summary exposed via API

The system SHALL return the persisted summary for a message from `GET /api/intelligence/messages/:id`.

#### Scenario: API returns persisted summary

- **WHEN** the renderer calls `GET /api/intelligence/messages/:id` for a message that has a completed summary
- **THEN** the response SHALL include the summary JSON from `mail_ai_artifacts`

### Requirement: No mail body in AI logs

The system SHALL NOT log mail body content or outbound prompt content from the AI layer.

#### Scenario: AI path logs are body-free

- **WHEN** `LlmClient` or `SummaryProcessor` logs a line
- **THEN** the log SHALL contain only identifiers, model name, usage/latency, and outcome codes
- **AND** it SHALL NOT contain the prompt body or response body text
