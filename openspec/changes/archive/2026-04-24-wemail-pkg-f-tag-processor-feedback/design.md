## Context

`mail_jobs` already emits `tags` jobs (Package C). `LlmClient` exists (Package E). `mail_tag_feedback_rules` exists as an empty table. This package implements the processor, the feedback loop, and the accept/reject API.

## Goals / Non-Goals

**Goals:**

- A fixed tag prompt over a fixed vocabulary (the eight built-in tags).
- `TagProcessor` that applies feedback rules BEFORE returning results: if a rule says "sender X + tag Y is rejected", that tag is removed or demoted.
- A persistence layer for feedback rules keyed on sender and/or subject pattern.
- API surface: tag accept / reject records the rule and updates the message's tag state.

**Non-Goals:**

- Free-form user-defined tags (phase two).
- Cross-user / team feedback sharing.
- Full-text clustering; phase-one similarity is "same sender" and "subject prefix" heuristics.

## Decisions

- **Fixed vocabulary.** `tagPrompt.ts` exports `BUILTIN_TAGS = ['通知','待回复','发布','告警','日报','需求','会议','审批']` and instructs the LLM to choose subsets only. Post-process clamps any off-vocabulary tag to nothing.
- **Feedback rule shape.** `mail_tag_feedback_rules`: `id, sender_pattern, subject_pattern, tag, action ('reject' | 'promote'), created_at`. Lookup uses exact-match sender and subject prefix (first N chars). Alternative rejected: regex or embeddings — too heavy for phase one.
- **Application stage.** Rules apply in `TagProcessor` after the LLM returns suggestions and before writing to `mail_ai_artifacts`. Rejected tags are either dropped entirely (hard reject) or have confidence demoted below a threshold; we go with "drop" in phase one for clearer UX.
- **API surface.** `POST /api/intelligence/messages/:id/tags/:tag/reject` and `.../accept`. Reject writes a `mail_tag_feedback_rules` row derived from the message's sender + subject prefix; accept removes matching reject rules.
- **Reuse of LlmClient.** No new AI client — this package depends on Package E's abstraction. Upstream interfaces consumed: `MailIntelligenceProcessor` (Package C), `LlmClient` (Package E), `DB Service mail API` (Package B).
- **No body in logs.** Same rule as summary; tag logs only include message id, suggestion count, rule-applied count.

## Risks / Trade-offs

- **[Risk] Over-aggressive rejections fossilize bad behavior.** → Mitigation: accept of a previously rejected tag deletes matching rules; document TTL considerations for future retention (Package H).
- **[Risk] Subject-prefix matching is crude.** → Mitigation: document pattern length (e.g. 32 chars) and allow future evolution behind the same storage shape.
- **[Risk] LLM hallucinates off-vocabulary tags.** → Mitigation: strict post-filter against `BUILTIN_TAGS`.
- **[Risk] Feedback rules grow without bound.** → Mitigation: Package H owns retention for ephemeral data, but per Handoff §5.H, tag feedback is long-retention; dedupe by `(sender_pattern, subject_pattern, tag, action)` UNIQUE.

## Migration Plan

- Additive migrations for any missing columns on `mail_tag_feedback_rules` + a UNIQUE index.
- Rollback: delete processor + prompt files; drop new columns if necessary.

## Open Questions

- Exact subject-prefix length — start with 32.
