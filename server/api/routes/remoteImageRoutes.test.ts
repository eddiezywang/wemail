import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { Hono } from "hono";
import { buildRemoteImageRoutes } from "./remoteImageRoutes.js";

test("serves validated remote images with non-sniffable inline headers", async () => {
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const etag = `"sha256-${createHash("sha256").update(bytes).digest("hex")}"`;
  const app = new Hono();
  app.route("/api/mail", buildRemoteImageRoutes({
    fetchImage: async () => ({ bytes, mediaType: "image/png", etag }),
  }));

  const response = await app.request(
    "/api/mail/remote-images?url=https%3A%2F%2Fimages.example.com%2Fa.png",
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/png");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("content-disposition"), "inline");
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
});

test("requires an explicit remote image URL", async () => {
  const app = new Hono();
  app.route("/api/mail", buildRemoteImageRoutes({
    fetchImage: async () => assert.fail("gateway must not be called"),
  }));

  const response = await app.request("/api/mail/remote-images");

  assert.equal(response.status, 400);
  assert.equal((await response.json() as { code: string }).code, "REMOTE_IMAGE_URL_REQUIRED");
});
