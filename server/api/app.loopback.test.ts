import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { startLocalApiServer } from "./app.js";

/** SECURITY.md promises the local API is reachable only on loopback. A bare
 *  `serve({ port })` would instead listen on :: / 0.0.0.0, so pin the
 *  hostname and assert the actual bound address. */
test("desktop local API binds to loopback only", async () => {
  const server = await startLocalApiServer({ port: 0 });
  try {
    assert.equal(server.address, "127.0.0.1");
    const requestStatus = (headers: Record<string, string> = {}) => new Promise<number | undefined>((resolve, reject) => {
      const request = http.get({ hostname: "127.0.0.1", port: server.port, path: "/api/system/health",
        headers, agent: false }, (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode));
      });
      request.on("error", reject);
    });
    assert.equal(await requestStatus(), 200);
    assert.equal(await requestStatus({ Host: `attacker.example:${server.port}` }), 403);
    server.setRendererOrigin("http://127.0.0.1:5173");
    assert.equal(await requestStatus({ Origin: "http://127.0.0.1:5173" }), 200);
  } finally {
    // @hono/node-server may re-enter close from its own 'close' listener on
    // an ephemeral-port test server; the binding assertions above already
    // settled, so only best-effort teardown is needed here.
    await server.close().catch(() => undefined);
  }
});
