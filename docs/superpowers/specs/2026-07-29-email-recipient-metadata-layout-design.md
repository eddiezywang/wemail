# Email Recipient Metadata Layout Design

## Goal

Keep message metadata readable when an email has many recipients. The timestamp must not share the recipient-details row or reduce the width available to expanded To, Cc, and Bcc addresses.

This detail-level change is paired with [Detail-First Workbench Layout Design](./2026-07-29-detail-first-workbench-layout-design.md), which reallocates desktop pane widths in favor of the email detail column.

## Layout

Both the single-message view and an expanded message inside a thread use the same two-row header:

1. **Primary row:** sender on the left; timestamp and message actions on the right.
2. **Recipient row:** recipient summary or expanded recipient details use the full available width below the primary row.

The timestamp remains visually associated with the sender, while recipient metadata is separated into its own line. Reply, more-actions, and draft indicators keep their existing behavior.

## Recipient Details

- The collapsed state continues to show the compact “发送给” summary.
- Expanding displays available 收件人、抄送、密送 rows.
- Expanded address values wrap across the full message width instead of being constrained to a narrow left column.
- The disclosure button remains next to the recipient summary/details and does not toggle the enclosing thread message.

## Scope

The change applies to `SingleMessageView` and the expanded state of `ThreadMessage`. The collapsed thread preview, subject header, message body, routing, and mail data contracts are unchanged.

## Accessibility and Testing

- Existing recipient disclosure labels and `aria-expanded` behavior remain unchanged.
- Tests verify that the timestamp is in the primary sender row and `RecipientDetails` is rendered as a separate following row.
- Existing recipient expansion and thread-toggle isolation tests continue to pass.
