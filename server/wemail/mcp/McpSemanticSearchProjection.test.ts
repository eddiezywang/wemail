import assert from "node:assert/strict";
import test from "node:test";
import { toMcpSearchChunk, toMcpQaClaim } from "./McpComposition.js";
import { WEMAIL_MCP_V1_TOOL_DEFINITION_BY_NAME } from "./McpToolCatalog.js";
import { validateMcpSchema } from "./McpSchemaValidator.js";
import type { SemanticSearchChunk, MailQaClaim } from "../../../shared/wemail/intelligence.js";

test("toMcpSearchChunk projects only schema-allowed fields and truncates snippet", () => {
  const chunk: SemanticSearchChunk = {
    emailId: "mail-1",
    chunkId: "chunk-1",
    score: 0.87,
    snippet: "x".repeat(2000),
    messageId: "m-1",
    subject: "Subject",
    sender: "sender@example.com",
    recipient: "me@example.com",
    receivedAt: "2026-08-11T10:00:00.000Z",
    folder: "INBOX",
    read: false,
    starred: true,
    hasAttachments: false,
  };
  const projected = toMcpSearchChunk(chunk);
  assert.equal(projected.snippet.length, 1000, "snippet truncated to 1000");
  assert.equal(projected.score, 0.87);

  const schema = WEMAIL_MCP_V1_TOOL_DEFINITION_BY_NAME.get("search_mail_semantic")!.outputSchema;
  const issues = validateMcpSchema(schema, { mode: "semantic", chunks: [projected], totalChunks: 1 });
  assert.deepEqual(issues, [], "search_mail_semantic output must validate");
});

test("toMcpSearchChunk conditionally omits optional metadata", () => {
  const projected = toMcpSearchChunk({ emailId: "m", chunkId: "c", score: 0.1, snippet: "hi" });
  assert.ok(!("messageId" in projected), "optional fields omitted when absent");
  const schema = WEMAIL_MCP_V1_TOOL_DEFINITION_BY_NAME.get("search_mail_semantic")!.outputSchema;
  assert.deepEqual(validateMcpSchema(schema, { mode: "lexical", chunks: [projected], totalChunks: 0 }), []);
});

test("toMcpQaClaim truncates text and bounds citations", () => {
  const claim: MailQaClaim = {
    text: "x".repeat(3000),
    citations: Array.from({ length: 15 }, (_, i) => ({
      emailId: `m-${i}`,
      chunkId: `c-${i}`,
      quote: "q".repeat(2000),
    })),
  };
  const projected = toMcpQaClaim(claim);
  assert.equal(projected.text.length, 2000, "text truncated to 2000");
  assert.equal(projected.citations.length, 10, "citations capped at 10");
  const first = projected.citations[0];
  assert.ok(first, "at least one citation present");
  assert.equal(first.quote!.length, 1000, "quote truncated to 1000");
});
