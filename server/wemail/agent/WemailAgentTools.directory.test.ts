import assert from "node:assert/strict";
import test from "node:test";
import {
  createWemailAgentTools,
  WEMAIL_AGENT_CAPABILITIES,
  type WemailAgentToolDeps,
} from "./WemailAgentTools.js";

const DIRECTORY_TOOL_NAMES = [
  "search_directory_contacts",
  "get_directory_contact",
  "list_directory_departments",
  "resolve_directory_recipients",
  "get_directory_status",
  "refresh_directory",
];

function directoryDeps(overrides: Partial<WemailAgentToolDeps> = {}) {
  const directoryService = {
    searchContacts: async () => ({ contacts: [{
      id: "u1",
      accountId: "acct-1",
      name: "张三",
      email: "zhangsan@corp.example",
      aliases: [],
      departmentPath: "支付平台部",
      mobile: "redacted-by-search-tool",
    }], total: 1, remoteAvailable: true }),
    getContact: async () => null,
    listDepartments: async () => [{ id: "department" }],
    resolveRecipients: async () => [{
      input: "张三",
      status: "exact",
      contact: { id: "u1", accountId: "acct-1", name: "张三", email: "zhangsan@corp.example", aliases: [] },
    }],
    getStatus: async () => ({ accountId: "acct-1", state: "completed", processedDepartments: 1, processedContacts: 1, updatedAt: "now" }),
    refresh: async () => ({ accountId: "acct-1", state: "completed", processedDepartments: 1, processedContacts: 1, updatedAt: "now" }),
  };
  return {
    getActiveAccountId: () => "acct-1",
    directoryService,
    ...overrides,
  } as unknown as WemailAgentToolDeps;
}

test("edition-enabled directory capabilities are registered as read-only agent tools", async () => {
  const deps = directoryDeps({ directoryToolsEnabled: true });
  const tools = createWemailAgentTools(deps);
  const names = new Set(tools.map((tool) => tool.name));
  for (const name of DIRECTORY_TOOL_NAMES) {
    assert.ok(names.has(name), `${name} registered`);
    assert.equal(WEMAIL_AGENT_CAPABILITIES.find((item) => item.tool === name)?.risk, "read");
  }
  const search = tools.find((tool) => tool.name === "search_directory_contacts")!;
  const result = await search.handler({ query: "张三" }, {});
  assert.deepEqual(result, {
    ok: true,
    contacts: [{
      id: "u1",
      accountId: "acct-1",
      name: "张三",
      email: "zhangsan@corp.example",
      aliases: [],
      departmentPath: "支付平台部",
    }],
  });
  assert.deepEqual(await tools.find((tool) => tool.name === "get_directory_contact")!.handler({ idOrEmail: "missing" }, {}), {
    ok: false, error: "contact-not-found",
  });
  assert.deepEqual(await tools.find((tool) => tool.name === "list_directory_departments")!.handler({}, {}), {
    ok: true, departments: [{ id: "department" }],
  });
  const resolved = await tools.find((tool) => tool.name === "resolve_directory_recipients")!.handler({ inputs: ["张三"] }, {});
  assert.equal((resolved as { resolutions: Array<{ status: string }> }).resolutions[0]?.status, "exact");
  const status = await tools.find((tool) => tool.name === "get_directory_status")!.handler({}, {});
  assert.equal((status as { status: { state: string } }).status.state, "completed");
});

test("open edition registers no directory tools but keeps the tool mechanism", () => {
  const tools = createWemailAgentTools(directoryDeps());
  const names = new Set(tools.map((tool) => tool.name));
  for (const name of DIRECTORY_TOOL_NAMES) {
    assert.ok(!names.has(name), `${name} must be absent in the open edition`);
  }
  // The mechanism layer stays open: generic tools and the capability manifest
  // still exist, they are simply not registered into the runtime.
  assert.ok(names.has("list_smart_tags"));
  assert.equal(
    WEMAIL_AGENT_CAPABILITIES.filter((item) => item.domain === "directory").length,
    6,
  );
});
