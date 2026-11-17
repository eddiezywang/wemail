# Local Prescreener

## Capability

Fast, rule-based classification that runs before any LLM call. Zero cost, synchronous, no external dependencies.

## Rules

1. **Sender pattern** — Match against `noreply@`, `no-reply@`, `notification@`, `donotreply@`, `mailer-daemon@`, `postmaster@` (case-insensitive prefix match on local part).
2. **Notification domain** — Exact match on domain against a configurable set: `github.com`, `stripe.com`, `aws.amazon.com`, `notifications.google.com`, `mailer.linkedin.com`.
3. **Bulk headers** — Check for `Precedence: bulk` header or presence of `List-Id` header.

## Output

```typescript
interface PrescreenResult {
  skipReply: boolean;
  skipReason?: "noreply-sender" | "notification-domain" | "bulk-mailing-list";
  matchedRule?: string;
}
```

When `skipReply=true`, the orchestrator enqueues `replyDecision` with `maxAttempts=1`. The processor path for pre-screened mail writes a skipped result immediately without calling LLM.

## Configuration

Domain list and sender patterns are configurable via `PrescreenerConfig` with sensible defaults. Not user-configurable in phase one — hardcoded in composition root.

## Headers Access

The prescreener needs access to mail headers beyond what `MailMessage` currently carries. Options:
- Add `headers?: Record<string, string>` to `MailMessage` (preferred, additive)
- Pass raw IMAP envelope data separately

Chosen: add `headers` field to `MailMessage` in `shared/wemail/mail.ts`. Only populate the headers that the prescreener needs: `precedence`, `list-id`, `x-auto-response-suppress`. Other headers are not stored.

## Extensibility

New rules can be added as methods on `LocalPrescreener` and flagged in `PrescreenerConfig`. Future rules might include:
- User-defined sender blocklist
- Subject keyword filtering
- Time-based rules (e.g. skip auto-replies during off-hours)
