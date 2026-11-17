import assert from "node:assert/strict";
import test from "node:test";
import { createLocalApiApp } from "./app.js";

test("local API allows only the configured browser origin", async () => {
  const app = createLocalApiApp({ rendererOrigin: () => "http://127.0.0.1:41234" });
  const trusted = await app.request("/api/system/health", { headers: { Origin: "http://127.0.0.1:41234" } });
  assert.notEqual(trusted.status, 403);
  assert.equal(trusted.headers.get("access-control-allow-origin"), "http://127.0.0.1:41234");
  const preflight = await app.request("/api/system/health", {
    method: "OPTIONS",
    headers: { Origin: "http://127.0.0.1:41234", "Access-Control-Request-Method": "POST" },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), "http://127.0.0.1:41234");
  for (const origin of ["http://127.0.0.1:41235", "http://localhost:41234", "https://example.com", "null"]) {
    const response = await app.request("/api/system/health", { headers: { Origin: origin } });
    assert.equal(response.status, 403);
    assert.equal(response.headers.get("access-control-allow-origin"), null);
  }
  const localProcess = await app.request("/api/system/health");
  assert.notEqual(localProcess.status, 403);
});

test("local API rejects unrecognised Host headers", async () => {
  const app = createLocalApiApp({
    rendererOrigin: () => "http://127.0.0.1:5173",
    listenerAuthority: () => "127.0.0.1:41234",
  });
  for (const host of ["127.0.0.1:41234", "127.0.0.1:5173"]) {
    const response = await app.request("/api/system/health", { headers: { Host: host } });
    assert.notEqual(response.status, 403);
  }
  for (const host of ["evil.example:41234", "127.0.0.1:9999", "localhost:41234"]) {
    const response = await app.request("/api/system/health", { headers: { Host: host } });
    assert.equal(response.status, 403);
  }
});
