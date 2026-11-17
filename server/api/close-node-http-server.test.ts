import assert from "node:assert/strict";
import http from "node:http";
import { describe, it } from "node:test";
import { closeNodeHttpServer } from "./close-node-http-server.js";

describe("closeNodeHttpServer", () => {
  it("closes an active SSE connection instead of waiting for its client", async () => {
    const server = http.createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("event: ping\ndata: {}\n\n");
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("test server did not bind a TCP port");
    }

    const request = http.get(`http://127.0.0.1:${address.port}`);
    request.on("error", () => undefined);
    await new Promise<void>((resolve) => {
      request.once("response", (response) => {
        response.once("data", () => resolve());
        response.on("error", () => undefined);
      });
    });

    await closeNodeHttpServer(server);

    assert.equal(server.listening, false);
    request.destroy();
  });
});
