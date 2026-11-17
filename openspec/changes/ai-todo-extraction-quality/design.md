# AI Todo Extraction Quality - Design

## Lifecycle

AI extraction creates `suggested` todos only. Users can confirm, complete, restore, or delete them. Manual todos are created in the same repository but can start as confirmed.

## Dedupe

Deduplicate AI todos by account, source email/thread, normalized title, and due date. Re-running extraction merges with the existing suggestion rather than inserting a duplicate.

## Date Handling

Due dates are set only when explicit or strongly implied by source text. Ambiguous phrases should remain unset with a low-confidence signal instead of guessing.
