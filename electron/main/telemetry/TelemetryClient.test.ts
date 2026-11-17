import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import {
  loadTelemetryRuntimeConfig,
  TelemetryClient,
  stackFingerprint,
} from "./TelemetryClient.js";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "wemail-telemetry-"));
}

test("client double-writes identical bodies with auth only on secondary", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const client = new TelemetryClient({
    userDataDir: tempDir(),
    appVersion: "1.2.3",
    username: "eddiewang",
    primaryUrl: "http://primary.test/events",
    secondaryUrl: "http://secondary.test/events",
    secondaryToken: "secret-token",
    fetchImpl: (async (url, init) => {
      requests.push({ url: String(url), init });
      return new Response(null, { status: 204 });
    }) as typeof fetch,
  });

  client.track("wemail_app_started", { source: "main" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(requests.length, 2);
  assert.equal(requests[0]?.init?.body, requests[1]?.init?.body);
  assert.equal((requests[0]?.init?.headers as Record<string, string>).Authorization, undefined);
  assert.equal(
    (requests[1]?.init?.headers as Record<string, string>).Authorization,
    "Bearer secret-token",
  );
});

test("default timeout allows the telemetry gateway to respond after 300ms", async () => {
  let completed = false;
  const client = new TelemetryClient({
    userDataDir: tempDir(),
    appVersion: "1.2.3",
    username: "eddiewang",
    primaryUrl: "http://primary.test/events",
    secondaryUrl: "",
    fetchImpl: (async (_url, init) => {
      await new Promise((resolve) => setTimeout(resolve, 350));
      if (init?.signal?.aborted) throw new Error("aborted");
      completed = true;
      return new Response(null, { status: 204 });
    }) as typeof fetch,
  });

  client.track("wemail_app_started", { source: "main" });
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(completed, true);
});

test("runtime config falls back to the development build directory", () => {
  const cwd = process.cwd();
  const dir = tempDir();
  fs.mkdirSync(path.join(dir, "build"));
  fs.writeFileSync(
    path.join(dir, "build", "telemetry-config.json"),
    JSON.stringify({
      primaryUrl: "http://primary.dev/events",
      secondaryUrl: "http://secondary.dev/events",
      secondaryToken: "dev-token",
    }),
  );
  try {
    process.chdir(dir);
    assert.deepEqual(
      loadTelemetryRuntimeConfig(
        path.join(dir, "missing-app"),
        path.join(dir, "missing-resources"),
        {},
      ),
      {
        primaryUrl: "http://primary.dev/events",
        secondaryUrl: "http://secondary.dev/events",
        secondaryToken: "dev-token",
      },
    );
  } finally {
    process.chdir(cwd);
  }
});

test("disabled client sends no events", async () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, "telemetry-settings.json"), '{"enabled":false}');
  let calls = 0;
  const client = new TelemetryClient({
    userDataDir: dir,
    appVersion: "1.0.0",
    fetchImpl: (async () => {
      calls += 1;
      return new Response(null, { status: 204 });
    }) as typeof fetch,
  });
  client.track("wemail_app_started", { source: "main" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls, 0);
});

test("dirty session is reported once on next start", async () => {
  const dir = tempDir();
  fs.writeFileSync(
    path.join(dir, "telemetry-session.json"),
    JSON.stringify({
      sessionId: "old",
      startedAt: "2026-07-24T00:00:00.000Z",
      lastPhase: "ready",
      cleanExit: false,
    }),
  );
  const bodies: string[] = [];
  const client = new TelemetryClient({
    userDataDir: dir,
    appVersion: "1.0.0",
    primaryUrl: "http://primary.test/events",
    now: () => new Date("2026-07-24T00:15:00.000Z"),
    fetchImpl: (async (_url, init) => {
      bodies.push(String(init?.body));
      return new Response(null, { status: 204 });
    }) as typeof fetch,
  });
  client.startSession();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.match(bodies[0] ?? "", /wemail_app_abnormal_exit_detected/);
  client.markCleanExit();
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "telemetry-session.json"), "utf8")).cleanExit, true);
});

test("stack fingerprint does not expose paths", () => {
  const error = new Error("failure");
  error.stack = "Error: failure\n at run (C:\\Users\\alice\\secret.ts:10:2)";
  assert.match(stackFingerprint(error) ?? "", /^[0-9a-f]{32}$/);
});
