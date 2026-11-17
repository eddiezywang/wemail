# WeMail MCP Envelope and Attachment Upload Design

## Status

Approved for implementation on 2026-07-22.

This document supplements `2026-07-22-wemail-mcp-contract-hardening-design.md`. It closes two remaining MCP contract gaps:

- Mail list and search results do not expose sender or message state.
- Draft and send tools still accept inline Base64 attachments, so JSON Schema cannot express the aggregate decoded-size limit across all attachments.

## Goals

1. Return sender and message flags from mail list and search tools without loading message bodies or raw headers.
2. Move attachment bytes into a bounded, session-scoped upload step.
3. Make draft and send requests small and schema-bounded by accepting attachment references instead of inline Base64.
4. Preserve explicit replace, retain, and remove semantics when editing drafts.
5. Prevent attachment references from crossing MCP sessions or mail accounts.

## Non-goals

- Resumable or multipart uploads.
- Persistent upload storage across process restarts.
- Reusing staged uploads between MCP sessions.
- Uploading attachments directly into the mailbox without a draft or send operation.
- Maintaining compatibility with inline Base64 attachment objects in draft and send tools.

## Mail Envelope Contract

The list and search result schemas will add:

- `from`: the parsed sender mailbox data already represented by the shared MCP envelope contract.
- `flags`: an object containing `seen`, `flagged`, `answered`, and `draft` booleans.

The repository queries will additionally select `sender_json` and `flags_json`. They will continue to omit body content and raw headers. Both list and search results will use the same envelope projection so the fields do not drift between tools.

## Attachment Upload Tool

Add a public MCP tool named `upload_mail_attachment`.

### Input

The tool accepts exactly one attachment per request:

```json
{
  "accountId": "account-id",
  "filename": "report.pdf",
  "mimeType": "application/pdf",
  "size": 12345,
  "dataBase64": "..."
}
```

Constraints:

- `size` is the decoded byte size and must not exceed 25 MiB.
- `dataBase64` has a bounded string length sufficient for one 25 MiB canonical Base64 payload.
- The server verifies canonical Base64 and verifies that its decoded size equals `size`.
- The MCP HTTP transport retains its 40 MiB request-body limit.

### Output

```json
{
  "uploadRef": "opaque-reference",
  "attachment": {
    "filename": "report.pdf",
    "mimeType": "application/pdf",
    "size": 12345
  },
  "expiresAt": "2026-07-22T12:34:56.000Z"
}
```

`uploadRef` is opaque. Clients must not derive account, session, or storage information from it.

### Tool annotations and risk

The tool annotations are:

- `readOnlyHint: false`
- `destructiveHint: false`
- `idempotentHint: false`
- `openWorldHint: false`

The operation is a bounded local write and does not mutate mailbox state or send mail. It uses the expensive rate class because it transfers and retains binary content.

## Temporary Upload Store

Uploads are held in memory only. The store records the opaque reference, MCP session hash, account ID, attachment metadata, canonical Base64 data, creation time, and expiration time.

Limits:

- Maximum decoded size per upload: 25 MiB.
- Maximum live uploads per MCP session: 20.
- Maximum aggregate decoded size per MCP session: 25 MiB.
- Maximum aggregate decoded size across the process: 64 MiB.
- Time to live: 15 minutes.

The store rejects a new upload when a live capacity limit would be exceeded. It does not evict another session's live upload to make room.

Expired entries are removed during store access and periodic cleanup. All uploads owned by a session are purged when `McpSessionManager` reports that the session terminated, including explicit close, token revocation, idle expiry, or client deletion. The composition root clears the store on shutdown.

References are reusable within the same live session until they expire. This supports safe retries. Once a draft or prepared send operation resolves an upload, that operation persists its own attachment value and no longer depends on the temporary store.

## Draft and Send Attachment References

Draft creation, draft update, and send preparation no longer accept inline attachment bytes. Their `attachments` array has at most 20 items, and every item is exactly one of:

```json
{ "uploadRef": "opaque-reference" }
```

or:

```json
{ "attachmentId": "existing-draft-attachment-id" }
```

Rules:

- Creating a draft or preparing a direct send without a draft accepts only `uploadRef` items.
- Updating a draft, or preparing a send from a draft, may mix existing `attachmentId` items with new `uploadRef` items.
- Omitting `attachments` retains the draft's current attachments.
- Providing an empty array removes all attachments.
- Providing a non-empty array defines the complete final ordered attachment set.
- Duplicate references or duplicate final attachment IDs are rejected.
- Every upload reference must belong to the current MCP session and requested account and must still be live.
- Every existing attachment ID must belong to the referenced draft.
- The resolved final attachment set must contain at most 20 files and at most 25 MiB decoded data in aggregate.

The MCP boundary resolves references to the existing outbound attachment representation before calling draft or send services. Mail storage therefore remains independent of the temporary upload store.

## Error Mapping

- Malformed metadata, invalid canonical Base64, size mismatch, duplicates, or an invalid attachment combination: `invalid_arguments`.
- A single upload or resolved attachment set exceeds its allowed size: `attachment_too_large`.
- An expired, unknown, cross-session, cross-account, or wrong-draft reference: `attachment_not_found`.
- Per-session or global temporary upload capacity is exhausted: `rate_limited`.

Errors must not reveal whether a reference exists in another account or session.

## Compatibility

Inline Base64 attachments are intentionally removed from draft and send input schemas. Keeping them would preserve the unbounded aggregate request contract this design is intended to eliminate.

This is an MCP contract change. The public tool count increases from 26 to 27, and tool catalog snapshots, UI tool metadata, documentation, and external-client fixtures must be updated together.

## Verification

Focused automated coverage will verify:

1. List and search results include parsed `from` and all four flags.
2. List and search repository projections still omit message bodies and raw headers.
3. Upload schema bounds a single request and rejects malformed, mismatched, or oversized Base64.
4. Upload references cannot cross sessions or accounts.
5. Expiration, session termination, and composition shutdown purge temporary uploads.
6. Per-session upload count, per-session byte size, and global byte size limits are enforced.
7. Draft create, retain, ordered replacement, mixed existing/new replacement, and removal semantics work as specified.
8. Send preparation resolves staged uploads and existing draft attachments correctly.
9. Draft and send schemas contain no inline Base64 attachment field.
10. The full control-plane test suite, frontend typecheck, client build, and a real MCP client flow pass.

## Security Notes

- Upload references use cryptographically strong opaque values.
- Reference lookup uses the current authenticated MCP session rather than client-supplied ownership data.
- Account and session mismatches use the same not-found response as unknown references.
- Filename and MIME type are metadata only and do not control filesystem paths because staged uploads never touch disk.
- Temporary attachment data is bounded and erased when its lifecycle ends.
