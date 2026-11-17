## ADDED Requirements

### Requirement: Account-isolated semantic search

Semantic search SHALL be account-isolated.

#### Scenario: Search account A

- **WHEN** semantic search is run for account A
- **THEN** results SHALL include only email ids belonging to account A

### Requirement: Cited QA answers

Answers SHALL include citations for every factual claim.

#### Scenario: Answer found in mail chunks

- **WHEN** mail QA returns an answer
- **THEN** each factual claim SHALL cite supporting email/chunk references

### Requirement: Non-blocking indexing

Indexing SHALL not block normal mail sync.

#### Scenario: Indexing delayed

- **WHEN** semantic indexing is slow or unavailable
- **THEN** normal mail sync and mail list routes SHALL continue to work

### Requirement: Lexical degradation

Search SHALL degrade to lexical mode if embedding provider is unavailable.

#### Scenario: Embedding unavailable

- **WHEN** embedding generation fails or is not configured
- **THEN** semantic search route SHALL return lexical results with a fallback indicator
