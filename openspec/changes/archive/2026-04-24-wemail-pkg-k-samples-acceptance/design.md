## Context

Without shared fixtures, every package invents its own mail sample and regression coverage drifts. This package produces one authoritative sample module and a reviewable checklist that mirrors the Handoff §2 hard rules.

## Goals / Non-Goals

**Goals:**

- A typed `mailSamples.ts` module exporting at least one sample per required category, compatible with the `MailMessage` shape from `shared/wemail/mail.ts`.
- A human-readable Markdown doc explaining each category and how to use the samples.
- A Markdown checklist that walks through phase-one acceptance (login, sync, summary/tag/draft produced, agent tool calls, WeCLI confirmation, logout preserves DB).

**Non-Goals:**

- Fuzz generation, randomized samples, or synthetic mass corpora.
- Running the samples through real LLMs as part of this package — that is each consumer's responsibility.
- Externally hosting the samples.

## Decisions

- **Samples are plain objects, not RFC822.** They match the normalized `MailMessage` type so tests can skip parsing. Alternative rejected: raw `.eml` files — harder to diff and maintain.
- **One file per category is overkill.** A single `mailSamples.ts` with named exports (`notificationSample`, `questionSample`, …) plus a `ALL_SAMPLES` array.
- **Prompt-injection sample is explicit.** It includes realistic injection attempts in the subject and body so Packages E/F/G can assert their prompts are not subverted.
- **Checklist mirrors Handoff §2 rules.** Each rule maps to a checkbox: logout preserves DB, new mail enqueues three jobs, summary retries ≤ 2, WeCLI non-ls requires confirmation, agent cannot send.
- **No proprietary content.** All samples are invented / synthetic; no real mail bodies from real users.
- **Shared types reused.** `shared/wemail/mail.ts`. No upstream runtime interface consumed.

## Risks / Trade-offs

- **[Risk] Samples drift from real production shapes.** → Mitigation: keep samples aligned with `MailMessage`; any schema change in Package B requires updating samples.
- **[Risk] Checklist rots.** → Mitigation: tie checklist items to Handoff §2 rules by explicit reference; review during Package H integration.
- **[Risk] Samples accidentally used as training data.** → Mitigation: documentation note — samples are for automated testing only.

## Migration Plan

- Purely additive.
- Rollback: delete the three new files.

## Open Questions

- Whether to split the prompt-injection sample into multiple sub-samples (subject injection, body injection, attached file injection) — recommended follow-up.
