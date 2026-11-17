import assert from "node:assert/strict";
import test from "node:test";
import type { ClaudeCodeTaskService } from "./ClaudeCodeRuntime.js";
import { createEnabledClaudeCodeAgentTools } from "./ClaudeCodeTools.js";

test("local code execution tools require explicit opt-in", () => {
  const service = {} as ClaudeCodeTaskService;
  assert.deepEqual(createEnabledClaudeCodeAgentTools(service, {}), []);
  assert.deepEqual(createEnabledClaudeCodeAgentTools(service, { WEMAIL_ENABLE_LOCAL_CLAUDE_CODE: "true" }), []);
  const names = createEnabledClaudeCodeAgentTools(service, { WEMAIL_ENABLE_LOCAL_CLAUDE_CODE: "1" }).map((tool) => tool.name);
  assert.ok(names.includes("start_local_claude_code"));
  assert.ok(names.includes("cancel_local_claude_code_task"));
});
