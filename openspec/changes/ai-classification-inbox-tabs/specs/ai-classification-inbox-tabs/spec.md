## ADDED Requirements

### Requirement: Stable category tabs

Category tabs SHALL be stable across app restarts.

#### Scenario: Built-in categories always returned

- **WHEN** categories are requested
- **THEN** required system categories SHALL be returned with canonical ids
- **AND** dynamic categories SHALL appear only after required system categories

### Requirement: Language-independent ids

Built-in categories SHALL use canonical ids independent of display language.

#### Scenario: Localized UI keeps canonical id

- **WHEN** the UI displays a translated category label
- **THEN** API requests SHALL still use the canonical category id

### Requirement: Category feedback suppression

User feedback SHALL suppress repeated wrong category suggestions for similar mail.

#### Scenario: Rejected suggestion is suppressed

- **WHEN** a user rejects a category for a sender and subject pattern
- **THEN** similar future mail SHALL not show that category unless strong contrary evidence exists

### Requirement: Account-isolated filtering

Category filtering SHALL not mix mail across accounts.

#### Scenario: Category counts match filtered results

- **WHEN** category counts and filtered messages are requested for an account
- **THEN** counts SHALL match the filtered result set for that same account only
