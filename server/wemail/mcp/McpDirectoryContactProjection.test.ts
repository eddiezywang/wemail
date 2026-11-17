import assert from "node:assert/strict";
import test from "node:test";
import { toMcpDirectoryContact } from "./McpComposition.js";
import { WEMAIL_MCP_V1_TOOL_DEFINITION_BY_NAME } from "./McpToolCatalog.js";
import { validateMcpSchema } from "./McpSchemaValidator.js";
import type { DirectoryContactSummary } from "../../../shared/wemail/directory.js";

const contact: DirectoryContactSummary = {
  id: "c-1",
  accountId: "acct-1",
  name: "Alice",
  email: "alice@example.com",
  aliases: ["a@example.com"],
  departmentId: "dept-1",
  departmentPath: "Eng/Platform",
  title: "Engineer",
  mobile: "13800000000",
  companyPhone: "010-12345678",
};

test("toMcpDirectoryContact strips PII phone fields", () => {
  const projected = toMcpDirectoryContact(contact);
  // PII regression: mobile and companyPhone must never appear in MCP output.
  assert.ok(!("mobile" in projected), "mobile must not leak (PII)");
  assert.ok(!("companyPhone" in projected), "companyPhone must not leak (PII)");
  assert.equal(projected.name, "Alice");
  assert.equal(projected.departmentId, "dept-1");
  assert.equal(projected.title, "Engineer");
});

test("toMcpDirectoryContact omits optional fields when absent", () => {
  const projected = toMcpDirectoryContact({ id: "c", accountId: "a", name: "Bob", email: "bob@example.com", aliases: [] });
  assert.ok(!("departmentId" in projected));
  assert.ok(!("title" in projected));
});

test("toMcpDirectoryContact output validates against the directory tool schema", () => {
  const projected = toMcpDirectoryContact(contact);
  const schema = WEMAIL_MCP_V1_TOOL_DEFINITION_BY_NAME.get("search_directory_contacts")!.outputSchema;
  assert.deepEqual(validateMcpSchema(schema, { contacts: [projected], total: 1, remoteAvailable: true }), []);
});
