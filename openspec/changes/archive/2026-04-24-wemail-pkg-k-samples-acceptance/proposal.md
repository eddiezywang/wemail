## Why

Phase one needs a shared fixture and checklist so any contributor can regression-test the full intelligence pipeline (summary, tags, draft, agent) against realistic mail. This package adds a curated set of mail samples, an acceptance checklist document, and an in-repo sample module that tests can import.

## What Changes

- Add `docs/testing/wemail-mail-samples.md` — curated descriptions of sample categories.
- Add `docs/testing/wemail-acceptance-checklist.md` — human-readable smoke checklist.
- Add `server/wemail/testing/mailSamples.ts` — typed in-repo sample objects covering every required category.

Sample categories (Handoff §5.K):

- 通知类, 询问类, 会议类, 发布结果类, 告警类, 日报类, 需求协作类, 群发邮件, 长线程邮件, 含附件邮件, 中英混合邮件, 疑似 prompt injection 邮件.

## Capabilities

### New Capabilities
- `samples-acceptance`: curated mail fixtures and the phase-one acceptance checklist.

### Modified Capabilities
- (none)

## Dependencies

- Upstream OpenSpec changes: **none** (pure fixture / documentation package; safe to ship in parallel).

## Constraints

Hard constraints from Handoff §2 that this change MUST honor:

- Electron + single account + IMAP/SMTP.
- LLM: OpenAI-compatible + Anthropic Messages.
- Built-in agent is PI (not Claude Code).
- WeCLI: auto-approve `ls/list` only; everything else needs confirmation; all audited.
- Logout MUST NOT wipe local DB.
- New mail → durable queue; summary retry ≤ 2.
- One fixed summary prompt.
- Agent may draft but never auto-send.
- No mail body in logs (the sample file is source code, not a log; but consumers must not log bodies).
- Windows-only phase one, but samples stay cross-platform.

## Impact

- Docs: `docs/testing/wemail-mail-samples.md`, `docs/testing/wemail-acceptance-checklist.md`.
- Code: `server/wemail/testing/mailSamples.ts` — imported by tests in Packages A–J.
- Dependencies: none.
