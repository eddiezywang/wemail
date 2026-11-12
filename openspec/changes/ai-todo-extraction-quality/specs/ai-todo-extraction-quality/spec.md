## ADDED Requirements

### Requirement: Suggested-only AI todos

Todo extraction SHALL not create confirmed todos automatically.

#### Scenario: AI extracts action item

- **WHEN** AI extracts a todo from mail
- **THEN** the todo SHALL be stored with status `suggested`

### Requirement: Duplicate merge

Duplicate AI todos SHALL be merged, not duplicated.

#### Scenario: Extraction rerun

- **WHEN** extraction runs again for the same email/thread, normalized title, and due date
- **THEN** the existing todo SHALL be updated or reused
- **AND** no duplicate todo SHALL be created

### Requirement: Conservative due dates

Todo due dates SHALL only be set when explicitly present or strongly implied.

#### Scenario: Ambiguous date phrase

- **WHEN** source text contains an ambiguous date
- **THEN** dueDate SHALL remain unset unless the processor can justify a strong implication

### Requirement: Deletion suppression

User deletion SHALL suppress the same suggested todo from reappearing for the same email.

#### Scenario: Deleted suggestion

- **WHEN** a user deletes an AI-suggested todo
- **THEN** rerunning extraction for that email SHALL not recreate the same suggestion
