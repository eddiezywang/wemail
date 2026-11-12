import assert from "node:assert/strict";
import test from "node:test";
import { startLocalApiServer } from "./app.js";

/** SECURITY.md promises the local API is reachable only on loopback. A bare
 *  `serve({ port })` would instead listen on :: / 0.0.0.0, so pin the
 *  hostname and assert the actual bound address. */
test("desktop local API binds to loopback only", async () => {
  const server = await startLocalApiServer({ port: 0 });
  try {
    assert.equal(server.address, "127.0.0.1");
    const response = await fetch(
      `http://127.0.0.1:${server.port}/api/system/health`,
    );
    assert.equal(response.status, 200);
  } finally {
    // @hono/node-server may re-enter close from its own 'close' listener on
    // an ephemeral-port test server; the binding assertions above already
    // settled, so only best-effort teardown is needed here.
    await server.close().catch(() => undefined);
  }
});
