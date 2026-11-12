import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import {
  RemoteImageError,
  RemoteImageProxy,
} from "./RemoteImageProxy.js";

test("validates, returns, and caches supported raster images", async () => {
  const png = await sharp({
    create: {
      width: 16,
      height: 16,
      channels: 4,
      background: { r: 42, g: 98, b: 201, alpha: 1 },
    },
  }).png().toBuffer();
  let fetchCount = 0;
  const proxy = new RemoteImageProxy({
    resolveHostname: async () => ["93.184.216.34"],
    fetcher: (async () => {
      fetchCount += 1;
      return new Response(new Uint8Array(png), {
        headers: { "Content-Type": "text/html" },
      });
    }) as typeof fetch,
  });

  const first = await proxy.fetchImage("https://images.example.com/banner");
  const second = await proxy.fetchImage("https://images.example.com/banner");

  assert.equal(first.mediaType, "image/png");
  assert.equal(first.etag, second.etag);
  assert.equal(fetchCount, 1);
});

test("rejects non-image bodies even when the upstream claims they are images", async () => {
  const proxy = new RemoteImageProxy({
    resolveHostname: async () => ["93.184.216.34"],
    fetcher: (async () => new Response("<html>not an image</html>", {
      headers: { "Content-Type": "image/png" },
    })) as typeof fetch,
  });

  await assert.rejects(
    () => proxy.fetchImage("https://images.example.com/not-image"),
    (error: unknown) => error instanceof RemoteImageError && error.code === "REMOTE_IMAGE_INVALID",
  );
});

test("blocks loopback targets before issuing a request", async () => {
  let requested = false;
  const proxy = new RemoteImageProxy({
    fetcher: (async () => {
      requested = true;
      return new Response();
    }) as typeof fetch,
  });

  await assert.rejects(
    () => proxy.fetchImage("http://127.0.0.1/private.png"),
    (error: unknown) => error instanceof RemoteImageError && error.code === "REMOTE_IMAGE_ADDRESS_BLOCKED",
  );
  assert.equal(requested, false);
});

test("allows the 198.18/15 fake-ip range used by proxy TUN stacks", async () => {
  let requested = false;
  const proxy = new RemoteImageProxy({
    resolveHostname: async () => ["198.18.0.8"],
    fetcher: (async () => {
      requested = true;
      return new Response("x", { status: 200 });
    }) as typeof fetch,
  });

  await assert.rejects(
    () => proxy.fetchImage("https://images.example.com/banner"),
    (error: unknown) => error instanceof RemoteImageError && error.code === "REMOTE_IMAGE_INVALID",
  );
  assert.equal(requested, true);
});

test("revalidates redirect targets and blocks redirects into private networks", async () => {
  const proxy = new RemoteImageProxy({
    resolveHostname: async (hostname) => hostname === "public.example.com"
      ? ["93.184.216.34"]
      : ["192.0.2.8"],
    fetcher: (async () => new Response(null, {
      status: 302,
      headers: { Location: "http://internal.example.com/secret.png" },
    })) as typeof fetch,
  });

  await assert.rejects(
    () => proxy.fetchImage("https://public.example.com/image.png"),
    (error: unknown) => error instanceof RemoteImageError && error.code === "REMOTE_IMAGE_ADDRESS_BLOCKED",
  );
});
