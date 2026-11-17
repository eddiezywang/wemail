## ADDED Requirements

### Requirement: Tag generation over fixed vocabulary

The system SHALL generate tag suggestions only from the phase-one built-in vocabulary: 通知, 待回复, 发布, 告警, 日报, 需求, 会议, 审批.

#### Scenario: Off-vocabulary suggestions are filtered

- **WHEN** `LlmClient` returns a tag not in the built-in list
- **THEN** `TagProcessor` SHALL drop that tag before persisting results

#### Scenario: Fixed prompt only

- **WHEN** `TagProcessor` builds an LLM request
- **THEN** it SHALL use the constants exported by `server/wemail/ai/prompts/tagPrompt.ts`
- **AND** it SHALL NOT accept a prompt override from request body or config

### Requirement: Rejected tags become feedback rules

The system SHALL, on `POST /api/intelligence/messages/:id/tags/:tag/reject`, persist a row in `mail_tag_feedback_rules` capturing the sender pattern and subject prefix of the target message.

#### Scenario: Reject persists a rule

- **WHEN** the renderer rejects tag `通知` on a message from `foo@example.com` with subject `Daily build #12`
- **THEN** `mail_tag_feedback_rules` SHALL contain a row with `sender_pattern = foo@example.com`, a subject prefix, `tag = 通知`, and `action = reject`

### Requirement: Similar future mail loses the rejected tag

The system SHALL, when processing a later message whose sender and subject prefix match a `reject` rule, drop the matching tag from the final suggestion set.

#### Scenario: Similar message does not receive rejected tag

- **WHEN** a new message arrives from the same sender with a matching subject prefix
- **AND** a `reject` rule exists for tag `通知`
- **THEN** `TagProcessor` SHALL remove `通知` from the LLM's suggestions before writing `mail_ai_artifacts`

### Requirement: Accept removes matching reject rules

The system SHALL, on tag accept, delete any matching `reject` rule so the user can undo prior feedback.

#### Scenario: Accept undoes a prior reject

- **WHEN** the renderer accepts tag `通知` on a message whose sender/subject prefix matches an existing `reject` rule
- **THEN** that rule SHALL be deleted from `mail_tag_feedback_rules`

### Requirement: No mail body in tag logs

The system SHALL NOT log mail body content from the tag processor.

#### Scenario: Tag logs are body-free

- **WHEN** `TagProcessor` logs its outcome
- **THEN** the log SHALL contain only message id, counts, and rule-application summary
- **AND** it SHALL NOT contain body or prompt text
