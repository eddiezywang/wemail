import assert from "node:assert/strict";
import test from "node:test";
import { toMcpEnvelope } from "./McpComposition.js";
import { WEMAIL_MCP_V1_TOOL_DEFINITION_BY_NAME } from "./McpToolCatalog.js";
import { validateMcpSchema } from "./McpSchemaValidator.js";
import type { MailCoreMessageSummary } from "../../../shared/wemail/mailCoreProtocol.js";

// Regression guard for the MCP content-tool failures: the DB summary carries
// fields (`messageId`, `to`, `sentAt`, invoice flags) that the MCP envelope
// output schema rejects under `additionalProperties: false`. Spreading the raw
// summary previously caused `mcp-handler-output-schema-violation`, which the
// transport hides as `internal_error`. `toMcpEnvelope` must project only the
// schema-allowed fields, and the result must validate cleanly.

const summary: MailCoreMessageSummary = {
  id: "mail-1",
  accountId: "acct-1",
  folder: "INBOX",
  messageId: "<rfc@example.com>",
  threadId: "thread-1",
  from: { email: "sender@example.com", name: "Sender" },
  to: [{ email: "me@example.com" }],
  subject: "Daily report",
  snippet: "See https://example.com/secret for details",
  receivedAt: "2026-08-11T13:00:00.000Z",
  sentAt: "2026-08-11T12:59:00.000Z",
  hasAttachments: true,
  flags: { seen: false, flagged: true, answered: false, draft: false },
  invoiceDetected: true,
  invoiceStatusTag: "unpaid",
};

test("toMcpEnvelope projects only schema-allowed fields and validates", () => {
  const envelope = toMcpEnvelope(summary);

  // The MCP envelope schema must never carry `messageId`, `to`, `sentAt`, or
  // invoice flags leaked from the underlying MailCoreMessageSummary.
  assert.ok(!("messageId" in envelope), "messageId must not leak");
  assert.ok(!("to" in envelope), "to must not leak");
  assert.ok(!("sentAt" in envelope), "sentAt must not leak");
  assert.ok(!("invoiceDetected" in envelope), "invoiceDetected must not leak");

  // The link in the snippet is sanitised by safeEnvelopeSnippet.
  assert.equal(envelope.snippet, "See [link] for details");

  const listSchema = WEMAIL_MCP_V1_TOOL_DEFINITION_BY_NAME.get("list_mail_messages")!.outputSchema;
  const issues = validateMcpSchema(listSchema, { items: [envelope] });
  assert.deepEqual(issues, [], "list_mail_messages output must validate");
});

test("the raw summary spread would fail validation (documents the fix)", () => {
  const leakingEnvelope = {
    ...summary,
    from: { email: summary.from.email },
    snippet: summary.snippet,
  };
  const listSchema = WEMAIL_MCP_V1_TOOL_DEFINITION_BY_NAME.get("list_mail_messages")!.outputSchema;
  const issues = validateMcpSchema(listSchema, { items: [leakingEnvelope] });
  assert.ok(issues.length > 0, "spreading the raw summary must fail additionalProperties:false");
  assert.ok(
    issues.some((issue) => issue.message === "is not allowed"),
    "the rejection must come from disallowed extra properties",
  );
});