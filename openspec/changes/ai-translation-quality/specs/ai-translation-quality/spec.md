## ADDED Requirements

### Requirement: Paragraph order preservation

Translation SHALL preserve paragraph order.

#### Scenario: Multi-paragraph email

- **WHEN** an email is translated
- **THEN** translated paragraph mappings SHALL appear in the same order as source paragraphs

### Requirement: Translation cache

Translation SHALL use cached result for same email, language, and version.

#### Scenario: Repeat request

- **WHEN** translation is requested twice with the same cache key
- **THEN** the second request SHALL return cached result without calling the LLM

### Requirement: Protected tokens

Translation SHALL not translate email addresses, URLs, code blocks, or tracking IDs.

#### Scenario: Source contains URL and code

- **WHEN** translation completes
- **THEN** URLs, email addresses, code blocks, and tracking ids SHALL remain unchanged

### Requirement: Target language preference

Translation SHALL respect user target language preference.

#### Scenario: Request omits target language

- **WHEN** the user profile has a default target language
- **THEN** translation SHALL use the profile target language
