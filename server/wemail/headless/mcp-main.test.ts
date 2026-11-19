import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { startHeadlessMcp, type HeadlessMcpHandle } from "./mcp-main.js";

const FIXTURE_ACCOUNT = {
  id: "acct-headless-test",
  emailAddress: "headless@example.test",
  imap: { host: "imap.example.test", port: 993, secure: true, username: "headless@example.test" },
  smtp: { host: "smtp.example.test", port: 465, secure: true, username: "headless@example.test" },
};

describe("headless mcp-main", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-headless-"));
  let handle: HeadlessMcpHandle;
  let bearer: string | undefined;
  let session: string | undefined;
  let rpcId = 0;

  async function rpc(method: string, params: Record<string, unknown>, withAuth = true): Promise<any> {
    const isNotification = method.startsWith("notifications/");
    const id = isNotification ? null : (rpcId += 1);
    const response = await fetch(handle.endpoint!, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(withAuth && bearer ? { authorization: `Bearer ${bearer}` } : {}),
        ...(session ? { "mcp-session-id": session } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", ...(id !== null ? { id } : {}), method, params }),
    });
    const echoedSession = response.headers.get("mcp-session-id");
    if (echoedSession) session = echoedSession;
    const text = await response.text();
    const bodies = text.startsWith("{")
      ? [JSON.parse(text)]
      : text.split("\n").filter((line) => line.startsWith("data:"))
        .map((line) => { try { return JSON.parse(line.slice(5).trim()); } catch { return null; } })
        .filter(Boolean);
    const body = id === null
      ? null
      : bodies.find((candidate: any) => candidate?.id === id) ?? bodies.at(-1) ?? null;
    return { status: response.status, body };
  }

  before(async () => {
    handle = await startHeadlessMcp({ dataDir, port: 30000 + Math.floor(Math.random() * 20000) });
    const now = new Date().toISOString();
    await handle.composition.accountService.saveAccount({
      config: { ...FIXTURE_ACCOUNT, createdAt: now, updatedAt: now },
      secrets: { imapPassword: "imap-pw", smtpPassword: "smtp-pw" },
    });
    bearer = handle.composition.mcp.tokens.create(FIXTURE_ACCOUNT.id).token;
  });

  after(async () => {
    await handle.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("boots a listening MCP endpoint on the shared data dir", () => {
    assert.ok(handle.endpoint, "endpoint should be set when listening");
    assert.ok(fs.existsSync(path.join(dataDir, "wemail.sqlite")), "canonical db should be created");
    assert.ok(fs.existsSync(path.join(dataDir, "secrets")), "file secret store dir should be created");
  });

  it("serves MCP initialize and tools/list without electron", async () => {
    const init = await rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "headless-smoke", version: "0.0.0" },
    });
    assert.equal(init.status, 200);
    assert.equal(init.body.result.serverInfo.name, "wemail-mail-mcp");
    await rpc("notifications/initialized", {});
    const tools = await rpc("tools/list", {});
    assert.equal(tools.status, 200);
    const names = tools.body.result.tools.map((tool: { name: string }) => tool.name);
    assert.ok(names.includes("list_mail_accounts"));
    assert.ok(names.includes("prepare_mail_send"));
  });

  it("rejects unauthenticated calls with 401", async () => {
    const result = await rpc("tools/list", {}, false);
    assert.equal(result.status, 401);
  });
});
