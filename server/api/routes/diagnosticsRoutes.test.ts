import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAppLogger } from "../../wemail/telemetry/AppLogger.js";
import { createDiagnosticsApp } from "./diagnosticsRoutes.js";

test("diagnostics logging routes query and change debug mode", async () => {
  const logger = createAppLogger({ baseDir: "/unused", writer: () => {} });
  const changes: boolean[] = [];
  const app = createDiagnosticsApp(logger, {
    onDebugModeChanged: ({ debugEnabled }) => changes.push(debugEnabled),
  });

  const initial = await app.request("/logging");
  assert.equal((await initial.json() as { debugEnabled: boolean }).debugEnabled, false);

  const enabled = await app.request("/logging", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ debugEnabled: true }),
  });
  const enabledBody = await enabled.json() as {
    debugEnabled: boolean;
    expiresAt: string | null;
  };
  assert.equal(enabled.status, 200);
  assert.equal(enabledBody.debugEnabled, true);
  assert.ok(enabledBody.expiresAt);
  assert.deepEqual(changes, [true]);

  const disabled = await app.request("/logging", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ debugEnabled: false }),
  });
  assert.equal(disabled.status, 200);
  assert.deepEqual(changes, [true, false]);

  const invalid = await app.request("/logging", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ debugEnabled: "yes" }),
  });
  assert.equal(invalid.status, 400);
});

test("diagnostics export creates a local redacted package without uploading", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-diagnostics-route-"));
  try {
    const logger = createAppLogger({ baseDir: directory });
    logger.info("agent.private", {
      prompt: "summarize this private mailbox",
      file: "C:\\Users\\Alice\\secret.txt",
      runId: "run-1",
    });
    const app = createDiagnosticsApp(logger);
    const response = await app.request("/export", { method: "POST" });
	const body = await response.json() as {
      ok: boolean;
      uploaded: boolean;
	  package: Record<string, unknown> & { expiresAt: string };
    };
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.uploaded, false);
    assert.equal("filePath" in body.package, false);
    assert.equal(body.package.expiresAt.length > 0, true);
    const packageDirectory = path.join(directory, "diagnostic-packages");
	const [exportedName] = fs.readdirSync(packageDirectory).filter((name) => name.endsWith(".json"));
	assert.ok(exportedName);
	const exported = fs.readFileSync(path.join(packageDirectory, exportedName), "utf8");
    assert.doesNotMatch(exported, /private mailbox|Alice|secret\.txt/);
    assert.match(exported, /\[REDACTED\]/);
    assert.match(exported, /\[REDACTED_PATH\]/);
    assert.equal(body.package.expiresAt, JSON.parse(exported).expiresAt);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
