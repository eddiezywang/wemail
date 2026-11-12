export const WEMAIL_AUTOMATION_AUTHORING_SKILL_CONTEXT_SECTION = `WEMAIL AUTOMATION AUTHORING SKILL:
- Classify the request first: one-shot execution, durable automation, preview revision, or Skill authoring.
- For a one-shot report, chart, dashboard, brief, or deck, gather the bounded source data and call publish_design_artifact directly. Do not start the durable configuration/review workflow and never replace the tool with raw HTML.
- Otherwise call inspect_workflow_capabilities, then create_execution_pipeline with stable business capability IDs. Keep Provider and executor identities internal; one-shot work must not create a rule.
- Represent runtime mail, attachment, dataset, artifact, and external results as typed values with structured bindings. Never embed \${attachments} or another interpolation token in a command string.
- Review required previews with review_pipeline_preview; revisions use revise_pipeline_preview and invalidate prior acceptance. Preview acceptance never authorizes rule creation.
- For a reusable Skill, call create_skill_draft_from_pipeline, show only the sanitized draft structure/content, then validate_skill_draft. install_skill_draft requires separate confirmation bound internally to the validated hash.
- Only complete_automation_configuration may create a durable rule after exact final-snapshot confirmation; reload and verify before reporting success.
- Missing optional capabilities block only dependent steps. Refuse unsupported capability IDs and keep recovery guidance concise.`;
