import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { MailAttachmentCache } from "./MailAttachmentCache.js";
import { mailAttachmentCacheKey } from "../../../shared/wemail/mail.js";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "wemail-attachment-cache-"));
}

test("MailAttachmentCache reuses disk bytes across instances", async () => {
  const rootDir = tempDir();
  let loads = 0;
  const first = new MailAttachmentCache({ rootDir });

  const cold = await first.getOrLoad("mail-1\0part-1", async () => {
    loads += 1;
    return Buffer.from("PNGDATA");
  });
  const second = new MailAttachmentCache({ rootDir });
  const warm = await second.getOrLoad("mail-1\0part-1", async () => {
    loads += 1;
    return Buffer.from("SHOULD-NOT-LOAD");
  });

  assert.equal(cold.source, "network");
  assert.equal(warm.source, "disk");
  assert.equal(warm.bytes.toString(), "PNGDATA");
  assert.equal(loads, 1);
  assert.match(warm.etag, /^"sha256-[a-f0-9]{64}"$/);
});

test("MailAttachmentCache coalesces concurrent cold loads", async () => {
  const cache = new MailAttachmentCache({ rootDir: tempDir() });
  let loads = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const loader = async () => {
    loads += 1;
    await gate;
    return Buffer.from("ONE-FETCH");
  };

  const first = cache.getOrLoad("mail-1\0part-1", loader);
  const second = cache.getOrLoad("mail-1\0part-1", loader);
  release();
  const [a, b] = await Promise.all([first, second]);

  assert.equal(loads, 1);
  assert.equal(a.bytes.toString(), "ONE-FETCH");
  assert.equal(b.bytes.toString(), "ONE-FETCH");
});

test("MailAttachmentCache aborts only when the last shared waiter leaves", async () => {
  const cache = new MailAttachmentCache();
  const firstController = new AbortController();
  const secondController = new AbortController();
  let release!: () => void;
  let loaderSignal: AbortSignal | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const loader = async (signal?: AbortSignal) => {
    loaderSignal = signal;
    await gate;
    if (signal?.aborted) throw new Error("loader aborted");
    return Buffer.from("SHARED");
  };

  const first = cache.getOrLoad("mail-1\0part-1", loader, firstController.signal);
  const second = cache.getOrLoad("mail-1\0part-1", loader, secondController.signal);
  firstController.abort();

  await assert.rejects(first, (error: Error) => error.name === "AbortError");
  assert.equal(loaderSignal?.aborted, false);
  release();
  const result = await second;
  assert.equal(result.bytes.toString(), "SHARED");
});

test("MailAttachmentCache clears failed in-flight loads", async () => {
  const cache = new MailAttachmentCache({ rootDir: tempDir() });
  let loads = 0;

  await assert.rejects(
    cache.getOrLoad("mail-1\0part-1", async () => {
      loads += 1;
      throw new Error("offline");
    }),
    /offline/,
  );
  const recovered = await cache.getOrLoad("mail-1\0part-1", async () => {
    loads += 1;
    return Buffer.from("RECOVERED");
  });

  assert.equal(loads, 2);
  assert.equal(recovered.bytes.toString(), "RECOVERED");
});

test("MailAttachmentCache does not persist items above the disk item limit", async () => {
  const rootDir = tempDir();
  const first = new MailAttachmentCache({
    rootDir,
    memoryItemMaxBytes: 1,
    diskItemMaxBytes: 4,
  });
  await first.getOrLoad("mail-1\0part-1", async () => Buffer.from("TOO-LARGE"));

  let loads = 0;
  const second = new MailAttachmentCache({
    rootDir,
    memoryItemMaxBytes: 1,
    diskItemMaxBytes: 4,
  });
  const result = await second.getOrLoad("mail-1\0part-1", async () => {
    loads += 1;
    return Buffer.from("RELOADED");
  });

  assert.equal(loads, 1);
  assert.equal(result.source, "network");
});

test("MailAttachmentCache evicts the oldest disk item when over budget", async () => {
  const rootDir = tempDir();
  const cache = new MailAttachmentCache({
    rootDir,
    memoryMaxBytes: 0,
    memoryItemMaxBytes: 0,
    diskMaxBytes: 8,
    diskItemMaxBytes: 8,
  });

  await cache.getOrLoad("mail-1\0part-1", async () => Buffer.from("AAAAA"));
  await new Promise((resolve) => setTimeout(resolve, 5));
  await cache.getOrLoad("mail-2\0part-1", async () => Buffer.from("BBBBB"));

  let firstReloads = 0;
  const fresh = new MailAttachmentCache({
    rootDir,
    memoryMaxBytes: 0,
    memoryItemMaxBytes: 0,
    diskMaxBytes: 8,
    diskItemMaxBytes: 8,
  });
  await fresh.getOrLoad("mail-1\0part-1", async () => {
    firstReloads += 1;
    return Buffer.from("CCCCC");
  });

  assert.equal(firstReloads, 1);
});

test("MailAttachmentCache.seed writes the layout getDiskPath and getOrLoad read", async () => {
  const rootDir = tempDir();
  // Write-only instance (as mail-core uses): no in-memory cache, no eviction.
  const writer = new MailAttachmentCache({ rootDir, memoryMaxBytes: 0 });
  const key = mailAttachmentCacheKey("acct-1", "msg-1", "att-1");
  await writer.seed(key, Buffer.from("INLINE-PNG-BYTES"));

  // A fresh instance (the HTTP route) finds it via the disk fast-path...
  const reader = new MailAttachmentCache({ rootDir });
  const diskPath = await reader.getDiskPath(key);
  assert.ok(diskPath, "getDiskPath should find the seeded entry");
  // ...and getOrLoad's readDisk re-hashes and accepts it without invoking the loader.
  let loads = 0;
  const result = await reader.getOrLoad(key, async () => {
    loads += 1;
    return Buffer.from("SHOULD-NOT-LOAD");
  });
  assert.equal(loads, 0);
  assert.equal(result.source, "disk");
  assert.equal(result.bytes.toString(), "INLINE-PNG-BYTES");
});

test("MailAttachmentCache.seed accepts Uint8Array and is a no-op over the item limit", async () => {
  const rootDir = tempDir();
  const writer = new MailAttachmentCache({
    rootDir,
    memoryMaxBytes: 0,
    diskItemMaxBytes: 4,
  });
  const key = mailAttachmentCacheKey("acct-1", "msg-1", "att-1");
  // Uint8Array is what survives structured clone; here it also exceeds the limit.
  await writer.seed(key, new Uint8Array([1, 2, 3, 4, 5, 6]));
  const reader = new MailAttachmentCache({ rootDir });
  assert.equal(await reader.getDiskPath(key), null);
});
