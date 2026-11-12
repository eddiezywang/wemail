import assert from "node:assert/strict";
import { test } from "node:test";
import {
  WEMAIL_MCP_PROTOCOL_VERSIONS,
  WEMAIL_MCP_SERVER_NAME,
} from "../../../../shared/wemail/mcp.js";
import { MCP_PROTOCOL_FIXTURES } from "./McpProtocolFixtures.js";

test("initialize fixture negotiates a pinned supported protocol", () => {
  assert.ok(
    WEMAIL_MCP_PROTOCOL_VERSIONS.includes(
      MCP_PROTOCOL_FIXTURES.initializeRequest.params.protocolVersion,
    ),
  );
  assert.equal(
    MCP_PROTOCOL_FIXTURES.initializeResponse.result.serverInfo.name,
    WEMAIL_MCP_SERVER_NAME,
  );
  assert.deepEqual(
    MCP_PROTOCOL_FIXTURES.initializeResponse.result.capabilities,
    { tools: { listChanged: true } },
  );
});
test("recorded success fixture contains structured content", () => {
  assert.deepEqual(
    MCP_PROTOCOL_FIXTURES.structuredToolSuccess.result.structuredContent,
    { accounts: [] },
  );
});

test("recorded expected failures are sanitized and protocol-correct", () => {
  assert.equal(MCP_PROTOCOL_FIXTURES.unknownMethodError.error.code, -32601);
  assert.equal(
    MCP_PROTOCOL_FIXTURES.unsupportedCapability.response.error.code,
    -32601,
  );
  assert.equal(MCP_PROTOCOL_FIXTURES.authenticationFailure.status, 401);
  const serialized = JSON.stringify(MCP_PROTOCOL_FIXTURES);
  assert.doesNotMatch(serialized, /authorization|password|bearer [a-z0-9]/i);
});

test("session deletion fixture is explicit and scoped", () => {
  assert.equal(MCP_PROTOCOL_FIXTURES.sessionDelete.method, "DELETE");
  assert.equal(MCP_PROTOCOL_FIXTURES.sessionDelete.path, "/mcp");
  assert.equal(MCP_PROTOCOL_FIXTURES.sessionDelete.expectedStatus, 200);
});
