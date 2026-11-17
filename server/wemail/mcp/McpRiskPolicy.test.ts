import assert from "node:assert/strict";
import test from "node:test";
import { WEMAIL_MCP_V1_TOOL_NAMES } from "../../../shared/wemail/mcp.js";
import { classifyMcpInvocation } from "./McpRiskPolicy.js";

// MCP defaults to open permissions: no tool requires separate WeMail
// confirmation, and every mutating tool may execute directly. The former
// high-risk / fail-closed semantics have been removed.

test("no tool ever requires separate WeMail confirmation", () => {
  for (const tool of WEMAIL_MCP_V1_TOOL_NAMES) {
    const decision = classifyMcpInvocation(tool, {});
    assert.equal(
      decision.requiresWemailConfirmation,
      false,
      `${tool} must not require confirmation`,
    );
    assert.ok(decision.reason.length > 0, tool);
  }
});

test("formerly fail-closed inputs no longer gate execution", () => {
  // A disguised mailbox action on set_mail_state used to fail closed; under
  // the open policy it is simply treated as a direct mutation.
  const disguised = classifyMcpInvocation("set_mail_state", { action: "archive" });
  assert.equal(disguised.requiresWemailConfirmation, false);
  assert.equal(disguised.mayExecuteProviderMutation, true);

  // An unrecognized prepare_mail_actions action no longer flips to confirmation.
  const unknownAction = classifyMcpInvocation("prepare_mail_actions", { action: "nope" });
  assert.equal(unknownAction.requiresWemailConfirmation, false);
});

test("read tools may not mutate; mutating tools may execute directly", () => {
  const reads = ["list_mail_accounts", "list_mail_messages", "search_mail", "get_mail_message"] as const;
  for (const tool of reads) {
    assert.equal(
      classifyMcpInvocation(tool, {}).mayExecuteProviderMutation,
      false,
      `${tool} is read-only`,
    );
  }
  const mutators = [
    "set_mail_state",
    "prepare_mail_actions",
    "prepare_mail_send",
    "commit_mail_operation",
    "prepare_delete_entity",
    "record_tag_feedback",
  ] as const;
  for (const tool of mutators) {
    assert.equal(
      classifyMcpInvocation(tool, {}).mayExecuteProviderMutation,
      true,
      `${tool} may execute under the open policy`,
    );
  }
});
