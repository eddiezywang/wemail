import assert from "node:assert/strict";
import test from "node:test";
import { extractToolCitations } from "./AgentToolCitationExtractor.js";

test("attachment filenames label the attachment rather than both mail and attachment", () => {
  const citations = extractToolCitations("propose_allowance_invoice_upload", {
    excluded: [{ emailId: "mail", attachmentId: "attachment", filename: "94.pdf" }],
  });
  assert.equal(citations.length, 2);
  assert.equal(citations.filter((citation) => citation.source.label === "94.pdf").length, 1);
});
