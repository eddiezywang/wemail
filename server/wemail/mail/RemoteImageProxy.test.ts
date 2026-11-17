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

test("times out when DNS resolution does not complete", async () => {
  let requested = false;
  const proxy = new RemoteImageProxy({
    timeoutMs: 10,
    resolveHostname: () => new Promise<string[]>(() => {}),
    fetcher: (async () => { requested = true; return new Response(); }) as typeof fetch,
  });
  await assert.rejects(
    () => proxy.fetchImage("https://images.example.com/a.png"),
    (error: unknown) => error instanceof RemoteImageError && error.code === "REMOTE_IMAGE_TIMEOUT",
  );
  assert.equal(requested, false);
});

test("rejects invalid resolver output even for a trusted suffix", async () => {
  let requested = false;
  const proxy = new RemoteImageProxy({
    trustedHostSuffixes: ["images.example.com"],
    resolveHostname: async () => ["not-an-ip"],
    fetcher: (async () => { requested = true; return new Response(); }) as typeof fetch,
  });
  await assert.rejects(
    () => proxy.fetchImage("https://images.example.com/a.png"),
    (error: unknown) => error instanceof RemoteImageError && error.code === "REMOTE_IMAGE_ADDRESS_BLOCKED",
  );
  assert.equal(requested, false);
});

test("blocks alternate IPv6 loopback and mapped IPv4 representations", async () => {
  for (const resolved of ["0:0:0:0:0:0:0:1", "::ffff:7f00:1", "::ffff:127.0.0.1", "64:ff9b::7f00:1", "2002:7f00:1::1"]) {
    let requested = false;
    const proxy = new RemoteImageProxy({
      resolveHostname: async () => [resolved],
      fetcher: (async () => { requested = true; return new Response(); }) as typeof fetch,
    });
    await assert.rejects(
      () => proxy.fetchImage("https://images.example.com/a.png"),
      (error: unknown) => error instanceof RemoteImageError && error.code === "REMOTE_IMAGE_ADDRESS_BLOCKED",
    );
    assert.equal(requested, false);
  }
});

test("blocks the 198.18/15 benchmark and fake-IP range by default", async () => {
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
    (error: unknown) => error instanceof RemoteImageError && error.code === "REMOTE_IMAGE_ADDRESS_BLOCKED",
  );
  assert.equal(requested, false);
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

test("reports malformed upstream redirect locations as redirect errors", async () => {
  const proxy = new RemoteImageProxy({
    resolveHostname: async () => ["93.184.216.34"],
    fetcher: (async () => new Response(null, {
      status: 302,
      headers: { Location: "http://[invalid" },
    })) as typeof fetch,
  });
  await assert.rejects(
    () => proxy.fetchImage("https://public.example.com/image.png"),
    (error: unknown) => error instanceof RemoteImageError && error.code === "REMOTE_IMAGE_REDIRECT_INVALID" && error.status === 502,
  );
});

test("uses the validated address for the actual connection", async () => {
  const http = await import("node:http");
  const png = await sharp({ create: { width: 1, height: 1, channels: 4, background: "#123456" } }).png().toBuffer();
  const server = http.createServer((_req, res) => { res.writeHead(200, { "Content-Type": "image/png" }); res.end(png); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const proxy = new RemoteImageProxy({
      trustedHostSuffixes: ["pinned.invalid"],
      resolveHostname: async () => ["127.0.0.1"],
    });
    const result = await proxy.fetchImage(`http://pinned.invalid:${address.port}/image.png`);
    assert.equal(result.mediaType, "image/png");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("handles a bodyless upstream response without an uncaught exception", async () => {
  const http = await import("node:http");
  const server = http.createServer((_req, res) => { res.writeHead(204); res.end(); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const proxy = new RemoteImageProxy({
      trustedHostSuffixes: ["pinned.invalid"],
      resolveHostname: async () => ["127.0.0.1"],
    });
    await assert.rejects(
      () => proxy.fetchImage(`http://pinned.invalid:${address.port}/empty`),
      (error: unknown) => error instanceof RemoteImageError && error.code === "REMOTE_IMAGE_EMPTY",
    );
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
