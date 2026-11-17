import assert from "node:assert/strict";
import { test } from "node:test";
import {
  WEMAIL_MCP_ERROR_CODES,
  WEMAIL_MCP_V1_TOOL_NAMES,
} from "../../../shared/wemail/mcp.js";
import {
  WEMAIL_MCP_V1_TOOL_DEFINITIONS,
  WEMAIL_MCP_V1_TOOL_DEFINITION_BY_NAME,
  type McpJsonSchema,
} from "./McpToolCatalog.js";
import { McpPublicRegistry } from "./McpPublicRegistry.js";
import type { AgentEvent } from "../../../shared/wemail/agent.js";

const EXPECTED_V1_TOOLS = [
  "list_mail_accounts",
  "list_mail_folders",
  "sync_mail_account",
  "get_mail_sync_status",
  "list_mail_messages",
  "search_mail",
  "get_mail_message",
  "get_mail_thread",
  "get_mail_attachment",
  "upload_mail_attachment",
  "list_mail_drafts",
  "get_mail_draft",
  "create_mail_draft",
  "update_mail_draft",
  "set_mail_state",
  "prepare_mail_actions",
  "prepare_mail_send",
  "commit_mail_operation",
  "get_mail_operation_status",
  "cancel_mail_operation",
  "list_todos",
  "get_todo",
  "create_todo",
  "update_todo",
  "complete_todo",
  "restore_todo",
  "prepare_delete_entity",
  "get_mail_intelligence",
  "search_mail_semantic",
  "ask_mail_question",
  "record_tag_feedback",
  "list_agent_attention",
  "get_conversation_state",
  "search_directory_contacts",
] as const;

function assertStrictObjectRoot(schema: McpJsonSchema, label: string) {
  assert.equal(schema.type, "object", `${label} root must be an object`);
  assert.equal(
    schema.additionalProperties,
    false,
    `${label} must reject unknown root properties`,
  );
}

test("public MCP v1 tool catalog is frozen and duplicate-free", () => {
  assert.deepEqual(WEMAIL_MCP_V1_TOOL_NAMES, EXPECTED_V1_TOOLS);
  assert.equal(new Set(WEMAIL_MCP_V1_TOOL_NAMES).size, EXPECTED_V1_TOOLS.length);
  assert.equal(WEMAIL_MCP_V1_TOOL_DEFINITIONS.length, EXPECTED_V1_TOOLS.length);
  assert.equal(WEMAIL_MCP_V1_TOOL_DEFINITION_BY_NAME.size, EXPECTED_V1_TOOLS.length);
});
test("every public MCP tool declares strict schemas, risk, and response bound", () => {
  for (const definition of WEMAIL_MCP_V1_TOOL_DEFINITIONS) {
    assertStrictObjectRoot(definition.inputSchema, `${definition.name} input`);
    assertStrictObjectRoot(definition.outputSchema, `${definition.name} output`);
    assert.ok(definition.description.length >= 20, `${definition.name} description`);
    assert.ok(definition.maxResponseBytes > 0, `${definition.name} response bound`);
    assert.ok(definition.domain, `${definition.name} domain`);
    assert.ok(definition.risk, `${definition.name} risk`);
    assert.deepEqual(
      Object.keys(definition.annotations).sort(),
      ["destructiveHint", "idempotentHint", "openWorldHint", "readOnlyHint"],
      `${definition.name} annotations`,
    );
    for (const value of Object.values(definition.annotations)) assert.equal(typeof value, "boolean");
  }
});

test("tool annotations describe concrete read, prepare, state, and commit behavior", () => {
  assert.deepEqual(WEMAIL_MCP_V1_TOOL_DEFINITION_BY_NAME.get("get_mail_message")?.annotations, {
    readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
  });
  assert.deepEqual(WEMAIL_MCP_V1_TOOL_DEFINITION_BY_NAME.get("prepare_mail_send")?.annotations, {
    readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false,
  });
  assert.deepEqual(WEMAIL_MCP_V1_TOOL_DEFINITION_BY_NAME.get("set_mail_state")?.annotations, {
    readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true,
  });
  assert.deepEqual(WEMAIL_MCP_V1_TOOL_DEFINITION_BY_NAME.get("commit_mail_operation")?.annotations, {
    readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true,
  });
});

test("message, draft, and thread schemas expose review metadata with coherent bounds", () => {
  for (const toolName of ["list_mail_messages", "search_mail"] as const) {
    const item = WEMAIL_MCP_V1_TOOL_DEFINITION_BY_NAME.get(toolName)!.outputSchema.properties?.items.items;
    assert.ok(item?.properties?.from, `${toolName} from`);
    assert.ok(item?.properties?.flags, `${toolName} flags`);
  }
  const message = WEMAIL_MCP_V1_TOOL_DEFINITION_BY_NAME.get("get_mail_message")!;
  assert.equal(message.inputSchema.properties?.maxBodyCharacters.maximum, 1_000_000);
  const messageProperties = message.outputSchema.properties?.message?.properties ?? {};
  for (const field of ["from", "to", "cc", "bcc", "receivedAt", "attachments"]) {
    assert.ok(messageProperties[field], field);
  }
  const thread = WEMAIL_MCP_V1_TOOL_DEFINITION_BY_NAME.get("get_mail_thread")!;
  assert.equal(thread.inputSchema.properties?.maxBodyCharacters.maximum, 1_000_000);
  assert.equal(thread.inputSchema.properties?.pageSize.maximum, 1_000);
  assert.equal(thread.outputSchema.properties?.messages.maxItems, 1_000);
  const draft = WEMAIL_MCP_V1_TOOL_DEFINITION_BY_NAME.get("get_mail_draft")!;
  assert.equal(draft.maxResponseBytes, 16 * 1024 * 1024);
  const draftProperties = draft.outputSchema.properties?.draft?.properties ?? {};
  for (const field of ["to", "cc", "bcc", "attachments", "createdAt", "sourceMessageId"]) {
    assert.ok(draftProperties[field], field);
  }
});

test("attachment upload bounds bytes and draft tools accept references only", () => {
  const upload = WEMAIL_MCP_V1_TOOL_DEFINITION_BY_NAME.get("upload_mail_attachment")!;
  assert.equal(upload.inputSchema.properties?.size.maximum, 25 * 1024 * 1024);
  assert.equal(upload.inputSchema.properties?.dataBase64.maxLength, 34_952_536);
  assert.deepEqual(upload.annotations, {
    readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false,
  });
  const createItem = WEMAIL_MCP_V1_TOOL_DEFINITION_BY_NAME.get("create_mail_draft")!.inputSchema.properties?.attachments.items;
  assert.ok(createItem?.properties?.uploadRef);
  assert.equal(JSON.stringify(createItem).includes("attachmentId"), false);
  for (const toolName of ["update_mail_draft", "prepare_mail_send"] as const) {
    const item = WEMAIL_MCP_V1_TOOL_DEFINITION_BY_NAME.get(toolName)!.inputSchema.properties?.attachments.items;
    assert.equal(item?.oneOf?.length, 2);
    assert.equal(JSON.stringify(item).includes("dataBase64"), false);
  }
});

test("internal-only tool names are not accidentally part of the MCP catalog", () => {
  const internalOnly = [
    "wecli_run",
    "run_curator",
    "read_workspace_file",
    "refresh_directory",
    "propose_automation_rule_change",
    "trigger_summary",
    "get_business_preferences",
  ];
  for (const name of internalOnly) {
    assert.ok(!WEMAIL_MCP_V1_TOOL_DEFINITION_BY_NAME.has(name as never), name);
  }
});

test("stable MCP error codes are unique", () => {
  assert.equal(new Set(WEMAIL_MCP_ERROR_CODES).size, WEMAIL_MCP_ERROR_CODES.length);
});

test("internal handler registration and public catalog reads cannot alter the Pi renderer protocol", () => {
  const piEvent: AgentEvent = { type: "text_delta", contentIndex: 0, text: "unchanged" };
  const registry = new McpPublicRegistry({
    run_curator: (() => ({ ok: true })) as never,
    list_mail_accounts: () => ({ accounts: [] }),
  } as never);
  assert.deepEqual(registry.list().map((tool) => tool.name), EXPECTED_V1_TOOLS);
  assert.deepEqual(piEvent, { type: "text_delta", contentIndex: 0, text: "unchanged" });
  assert.equal(registry.hasHandler("list_mail_accounts"), true);
  assert.equal((registry as any).hasHandler("run_curator"), false);
});
