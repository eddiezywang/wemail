# Smart Tag Batch Prompt Optimization Implementation Plan

## Scope

Implement the approved design in
`docs/superpowers/specs/2026-07-23-smart-tag-batch-prompt-optimization-design.md`:
durable labeled feedback, scheduled batch candidate generation, production-path A/B
tagging, guarded activation, targeted re-tagging, UI status, tests, and desktop
acceptance. Preserve unrelated MCP worktree changes.

## Work packages

1. Persistence and compatibility
   - Add migration 57 for optimized prompt fields, stable action `tag_id`, learning
     runs/samples, and targeted re-tagging items.
   - Extend repositories and shared/API shapes while preserving legacy fields.
   - Strip the legacy machine learning block during migration with a default-prompt
     fallback when the remaining user prompt is empty.

2. Production-path classification seam
   - Refactor `TagProcessor` so normal jobs and learning evaluation share the same
     request construction, structured response parsing, and confidence handling.
   - Allow evaluation to bypass feedback-rule post-processing without changing
     production behavior.

3. Batch learning service
   - Replace direct prompt concatenation with an async scheduled batch service.
   - Resolve latest action per email/tag, validate real mail bodies, group by thread,
     and create deterministic optimization/validation splits.
   - Generate a structured candidate prompt from optimization samples only.
   - A/B tag validation mail with current and candidate definitions, replay the full
     batch, confirm passing candidates, and atomically activate or reject.
   - Persist only references, metrics, confidence, hashes, and errors.

4. Targeted re-tagging
   - Snapshot only existing relations for the changed tag.
   - Re-run the real tag classifier and update only the target relation.
   - Remove AI relations when no longer matched; preserve user relations and all
     unrelated intelligence state.
   - Make progress durable, resumable, and visible.

5. API and renderer
   - Return original, optimized, and effective prompt metadata with user tags.
   - Expose learning runs and restore-original behavior.
   - Update the manage dialog and Action Center to show batch status, metrics, and
     targeted re-tagging progress instead of raw behavior appended to prompts.

6. Verification
   - Add migration, repository, service, TagProcessor, route, and renderer tests.
   - Run server and renderer focused tests, full typechecks, and relevant broader
     suites.
   - Rebuild and launch the Windows desktop app with the repository acceptance
     workflow; verify startup and smart-tag management UI.
   - Commit only files belonging to this feature and push after successful
     verification.
