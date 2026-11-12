# Unified Mail Send Finalization Design

## Problem

WeMail currently has inconsistent post-send behavior. The regular mail API sends through SMTP and immediately writes a local Sent message, while confirmed Agent sends call SMTP, delete the draft, and report success without persisting the sent message or SMTP delivery result. A later Agent verification searches the local mailbox, finds no forwarded message, and can incorrectly claim that a successfully delivered message was not sent.

## Goals

- Give every successful send path the same post-send behavior.
- Make the sent message visible locally immediately after SMTP acceptance.
- Preserve the SMTP Message-ID and accepted/rejected recipient evidence.
- Prevent Agent verification from treating a missing local Sent row as proof that no send occurred.
- Keep explicit user confirmation as a hard requirement for Agent sends.

## Non-goals

- Do not add IMAP APPEND in this change.
- Do not claim final mailbox delivery beyond the SMTP server's acceptance result.
- Do not redesign the pending-action confirmation UI.

## Design

Introduce a shared mail-send finalization service used by regular sends and confirmed Agent sends. The service will:

1. Validate the outbound draft and call the configured mail provider's `sendDraft` method.
2. Interpret the SMTP delivery result:
   - all intended recipients accepted: successful send;
   - some accepted and some rejected: successful partial delivery with explicit rejected recipients;
   - none accepted, or provider error: failed send.
3. Build and persist a local Sent message containing the SMTP Message-ID, recipients, subject, body, attachments, and delivery evidence.
4. Delete the associated persistent draft only after SMTP acceptance and local Sent persistence succeed.
5. Return a structured result containing the Message-ID and delivery evidence to the caller.

The existing local Sent-message builder will move out of the HTTP route into the shared service boundary. The regular mail route and `MailActionExecutor` will both delegate to that service rather than implementing separate completion logic.

## Agent Behavior

The Agent action execution result will expose the SMTP Message-ID and delivery status without exposing credentials or message bodies. User-facing summaries will distinguish:

- `SMTP 已接受全部收件人`;
- `SMTP 已接受部分收件人` with rejected addresses;
- send failure.

A later verification must treat a confirmed action with SMTP acceptance evidence as a successful submission. If the local or IMAP Sent copy is not yet visible, the Agent may report that the sent record has not synchronized, but must not conclude that the send did not execute.

## IMAP Reconciliation

The local Sent row is an immediate cache record, not a second send. When a later IMAP sync observes a server-side Sent message with the same account and Message-ID, reconciliation should avoid presenting duplicate messages. Existing reconciliation behavior will be reused where sufficient; otherwise a focused Message-ID merge will be added within the mail repository/sync boundary.

## Failure Handling

- SMTP failure: do not create a Sent record and do not delete the draft.
- Complete recipient rejection: treat as failure and retain the draft.
- Partial rejection: persist the Sent record and delivery evidence, retain an explicit partial-delivery result for the UI and Agent.
- Local Sent persistence failure after SMTP acceptance: report that SMTP accepted the message but local recording failed. Do not retry SMTP automatically, because that could duplicate delivery.
- Draft deletion failure after successful persistence: report send success and leave the draft for later cleanup; do not resend.

## Verification

Focused coverage will verify:

- regular and Agent sends use the shared completion path;
- successful sends create a local Sent record with Message-ID and `cc` recipients;
- partial rejection remains visible in the result and persisted delivery data;
- SMTP failure retains the draft and creates no Sent row;
- local persistence failure does not trigger a second SMTP send;
- later lookup can distinguish SMTP acceptance from Sent synchronization state.
