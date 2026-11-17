# WeMail MCP

WeMail can expose the currently signed-in mailbox to local MCP clients. The feature is opt-in, listens only on `127.0.0.1`, and is disabled by default.

## Enable and connect

1. Open **Settings → MCP** and enable **Local MCP**.
2. Keep the fixed port at `43129` unless it conflicts with another local process.
3. Choose the target client format and select **Copy MCP configuration**. WeMail automatically creates and securely stores the local connection credential.
4. Paste the copied JSON into Codex, Claude Desktop, or another compatible local host, then restart/reload that host.

The generated connection has this shape:

```json
{
  "wemail-mail-mcp": {
    "type": "streamablehttp",
    "url": "http://127.0.0.1:43129/mcp",
    "headers": { "Authorization": "Bearer <managed-local-credential>" }
  }
}
```

The copied JSON contains a bearer credential with mailbox access. Do not paste it into chat, logs, screenshots, source control, or remote MCP services. WeMail stores the recoverable credential with the operating system's protected storage and never renders it in Settings. Reopening Settings and copying again reuses the same credential, so existing clients remain connected.

Disabling MCP stops the listener and active sessions but retains the protected credential for a later re-enable. Use **Reset connection credential** if exposure is suspected or you want every copied configuration to stop working. Reset, account logout/replacement, and per-session termination immediately end affected access.

## Safety model

Read tools are account-scoped and return bounded data. List/search results contain envelopes only, including sender and the read, starred, answered, and draft flags, without loading body content or raw headers. Targeted message and thread results include sender, recipients, time, and attachment metadata; the returned attachment id can be passed directly to `get_mail_attachment`. Targeted bodies default to 6,000 characters and cannot exceed 20,000 characters per message. Provider content is labeled untrusted. Inbound attachments are returned as session-bound embedded resources rather than filesystem paths.

Draft detail includes recipients and attachment metadata for review, but never returns attachment Base64. To add an outbound attachment, call `upload_mail_attachment` once per file with canonical Base64 and its decoded size, then pass the returned opaque `uploadRef` to `create_mail_draft`, `update_mail_draft`, or `prepare_mail_send`. References remain valid for at most 15 minutes, are bound to the current account and MCP session, and their temporary data is purged on expiry or when that session ends.

Draft updates and sends from an existing draft may combine its current `attachmentId` values with new `uploadRef` values. Omitting `attachments` retains the current set, an empty array removes all attachments, and a non-empty array defines the complete final order. Direct draft creation and direct send preparation accept only `uploadRef`. The final set allows at most 20 attachments, no more than 25 MiB for one file, and no more than 25 MiB decoded in aggregate. A session may stage at most 20 live uploads and 25 MiB; process-wide temporary staging is capped at 64 MiB.

All public tools advertise MCP read-only, destructive, idempotent, and open-world hints so compatible hosts can present an accurate risk experience. When MCP is enabled, possession of its managed bearer credential authorizes direct use of the full public tool surface.

Draft and Todo edits are local/reversible. Sending, deleting, moving, archiving, spam changes, permanent deletion, batch mutations, and draft/Todo deletion use an idempotent two-call flow without an in-app confirmation:

1. The MCP client prepares and validates the exact parameters; nothing executes yet.
2. WeMail persists the operation as approved without creating an Action Center card.
3. The client commits the operation with an idempotency key. Repeating that exact commit returns the retained result without dispatching twice.

Treat the copied MCP configuration like a full-mailbox credential. A client holding it can send mail or permanently delete mail without another WeMail prompt. Reset the connection credential immediately if it may have been exposed.

If an operation says **outcome unknown**, check the mailbox/provider before taking further action and do not automatically retry.

## Troubleshooting

- **Port occupied:** choose another fixed port in Settings and update the host configuration.
- **401 / authentication required:** copy the current configuration again. If the client still fails, reset the connection credential and replace its old JSON.
- **Windows protected storage unavailable:** unlock the current Windows session and restart WeMail. WeMail will not fall back to plaintext or obfuscated storage for the managed credential.
- **Connection credential damaged:** use **Reset connection credential** in advanced MCP settings, then copy and paste the replacement JSON.
- **Session expired:** reconnect the MCP host; sessions expire after inactivity.
- **Tool unavailable:** sign in to the intended account and confirm the provider supports the capability.
- **403 / origin forbidden:** browser-based callers must use an exact localhost, `127.0.0.1`, or `::1` Origin. Native MCP clients normally send no Origin.
- **Attachment reference not found:** upload again in the same live MCP session and account; references cannot be copied between host sessions and expire after 15 minutes.
- **413 / request too large:** keep each encoded upload request below 40 MiB and the final decoded attachment set at or below 25 MiB.
- **MCP disabled by emergency switch:** remove `WEMAIL_MCP_EMERGENCY_DISABLE=1` only after the incident owner authorizes re-enablement.
- **Operation will not commit:** confirm the active mailbox matches the operation account, check whether the operation expired, and inspect its status in MCP Settings.
