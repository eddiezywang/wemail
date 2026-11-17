# samples-acceptance Specification

## Purpose
TBD - created by archiving change wemail-pkg-k-samples-acceptance. Update Purpose after archive.
## Requirements
### Requirement: Typed mail samples for every phase-one category

The system SHALL provide a `server/wemail/testing/mailSamples.ts` module that exports at least one `MailMessage`-shaped sample for each of the following categories: 通知类, 询问类, 会议类, 发布结果类, 告警类, 日报类, 需求协作类, 群发邮件, 长线程邮件, 含附件邮件, 中英混合邮件, 疑似 prompt injection 邮件.

#### Scenario: All categories are exported

- **WHEN** a test imports `ALL_SAMPLES` from `server/wemail/testing/mailSamples.ts`
- **THEN** the array SHALL contain at least one entry per listed category
- **AND** every entry SHALL validate against the `MailMessage` shape from `shared/wemail/mail.ts`

### Requirement: Acceptance checklist covers Handoff §2 rules

The system SHALL ship `docs/testing/wemail-acceptance-checklist.md` that includes a checkbox for every Handoff §2 hard rule (logout preserves DB, new mail enqueues three jobs, summary retry ≤ 2, WeCLI non-ls requires confirmation, agent cannot auto-send, no mail body in logs, one fixed summary prompt, built-in agent is PI).

#### Scenario: Checklist is reviewable by a human

- **WHEN** a reviewer opens `wemail-acceptance-checklist.md`
- **THEN** they SHALL find a dedicated checkbox for each listed rule
- **AND** each checkbox SHALL reference the corresponding section or behavior in the codebase

### Requirement: Samples document explains each category

The system SHALL ship `docs/testing/wemail-mail-samples.md` that describes every sample category and how to extend them.

#### Scenario: Documentation lists all categories

- **WHEN** a reviewer opens `wemail-mail-samples.md`
- **THEN** they SHALL find a dedicated section for each category with a short description

### Requirement: Prompt-injection sample is explicit

The system SHALL include at least one sample that contains realistic prompt-injection attempts in subject and body, so intelligence processors can regression-test their prompts.

#### Scenario: Injection sample is present

- **WHEN** a test imports the prompt-injection sample
- **THEN** its body and subject SHALL contain directives that attempt to override system instructions
- **AND** documentation SHALL mark it as a prompt-injection test fixture

