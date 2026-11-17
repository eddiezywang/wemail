## Context

The baseline has a `wecli_audit_logs` table and a skills route skeleton. There is no classifier, no runtime, no repository. Package D owns the confirmation dialog; this package produces the server-side contracts the dialog triggers.

## Goals / Non-Goals

**Goals:**

- Deterministic classifier: `ls` and `list` subcommands → `auto`; everything else → `requires-confirmation`.
- Runtime that appends `-f json` when safe and parses output into typed results.
- Audit log for every invocation: who requested, what command, classification, confirmation decision, exit code, elapsed time, outcome code — never mail bodies.
- REST surface for the agent / renderer: `classify / run` (simplified two-step; see Decisions).

**Non-Goals:**

- Generalized shell execution. Only `wecli` is supported.
- Regex-based parsing of arbitrary user input; the classifier looks at the leading subcommand.
- Streaming CLI output in phase one.

## Decisions

- **Classifier rules.** Input is a parsed command of shape `{ command: 'wecli', args: string[] }`. If `args[0]` (the subcommand) is exactly `ls` or `list`, classification is `auto`. Any other subcommand, or an empty arg list, is `requires-confirmation`. Alternative rejected: trying to infer read-only-ness from flags — too easy to misclassify.
- **`-f json` enforced where possible.** If args already include `-f <anything>`, runtime respects it; otherwise runtime appends `-f json`. Parsed JSON is returned to the caller; on parse failure the runtime falls back to raw text with a warning.
- **Two-step for mutations (simplified phase-one).** `POST /wecli/classify` returns the classification only. `POST /wecli/run` classifies and executes; when classification is `requires-confirmation` and `approvedBy` is missing, the server returns `412` with the exact classification payload so the renderer can show the confirm dialog; the renderer re-issues the same POST with `approvedBy` populated. Phase-one simplification: `approvedBy` is a plain string (non-empty, ≤ 64 chars, printable ASCII) — no server-issued tokens, no TTL.
- **Upstream interfaces consumed.** `AppLogger` (Package H, once available — otherwise a local shim), `AgentActionConfirmDialog` (Package D) consumed by the renderer.
- **Shared types.** `shared/wemail/skills.ts` is the DTO home; `WecliTypes.ts` narrows server-side shapes.
- **Audit log is append-only.** Rows are never mutated after insert; retention is handled by Package H.

## Risks / Trade-offs

- **[Risk] User bypasses confirmation via custom client.** → Mitigation: enforcement lives on the server; `/wecli/run` refuses to spawn (and writes a refused audit row) when `approvedBy` is missing for a `requires-confirmation` command. Phase-one simplification defers one-time tokens / TTL to a later round.
- **[Risk] Command injection via agent-supplied args.** → Mitigation: pass args as an array to the spawn call; never shell-interpolate.
- **[Risk] `wecli` missing on PATH.** → Mitigation: clear error code; UI surfaces a "wecli not installed" message without leaking paths.
- **[Risk] Large JSON output.** → Mitigation: cap result size; truncate with a flag.

## Migration Plan

- Additive; `wecli_audit_logs` already exists.
- Rollback: remove classifier / runtime / repository; revert route handlers.

## Open Questions

- Confirmation token TTL — deferred past phase one; phase one uses plain-string `approvedBy` (non-empty, ≤ 64 chars, printable ASCII) rather than a server-issued token.
