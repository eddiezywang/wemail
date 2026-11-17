import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import { MailAttachmentCache } from "../../wemail/mail/MailAttachmentCache.js";
import { buildMailAttachmentRoutes } from "./mailAttachmentRoutes.js";

const descriptor = {
  accountId: "acct-1",
  messageId: "mail-1",
  attachmentId: "attachment-public-1",
  remoteEmailId: "acct-1:INBOX:9:42",
  partPath: "2.1",
  filename: "chart.png",
  mediaType: "image/png/octet-stream",
  disposition: "inline" as const,
  byteSize: 12,
};

function pngBytes(): Buffer {
  return Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x00,
  ]);
}

test("attachment route resolves the canonical part path and caches PNG bytes", async () => {
  let fetches = 0;
  const inputs: unknown[] = [];
  const app = new Hono();
  app.route("/api/mail", buildMailAttachmentRoutes({
    repository: {
      getAttachmentFetchDescriptor: () => descriptor,
    },
    cache: new MailAttachmentCache(),
    gateway: {
      fetchAttachment: async (input) => {
        fetches += 1;
        inputs.push(input);
        return { bytes: pngBytes(), mediaType: "application/octet-stream" };
      },
    },
    getCurrentAccountId: () => "acct-1",
  }));

  const url = "/api/mail/messages/mail-1/attachments/attachment-public-1";
  const first = await app.request(url);
  const second = await app.request(url);

  assert.equal(first.status, 200);
  assert.equal(first.headers.get("content-type"), "image/png");
  assert.match(first.headers.get("content-disposition") ?? "", /^inline;/);
  assert.equal((await first.arrayBuffer()).byteLength, pngBytes().byteLength);
  assert.equal(second.status, 200);
  assert.equal(fetches, 1);
  // The gateway call now carries the canonical source marker (from the
  // descriptor disposition) and the cache's abort signal alongside the
  // address triple.
  assert.equal(inputs.length, 1);
  const fetchInput = inputs[0] as {
    accountId: string;
    remoteEmailId: string;
    partPath: string;
    source: string;
    signal: AbortSignal;
  };
  assert.deepEqual(
    {
      accountId: fetchInput.accountId,
      remoteEmailId: fetchInput.remoteEmailId,
      partPath: fetchInput.partPath,
      source: fetchInput.source,
    },
    {
      accountId: "acct-1",
      remoteEmailId: "acct-1:INBOX:9:42",
      partPath: "2.1",
      source: "inline",
    },
  );
  assert.ok(fetchInput.signal instanceof AbortSignal);
  assert.equal(fetchInput.signal.aborted, false);
});

test("attachment route honors ETag without re-fetching bytes", async () => {
  let fetches = 0;
  const app = new Hono();
  app.route("/api/mail", buildMailAttachmentRoutes({
    repository: { getAttachmentFetchDescriptor: () => descriptor },
    cache: new MailAttachmentCache(),
    gateway: {
      fetchAttachment: async () => {
        fetches += 1;
        return { bytes: pngBytes(), mediaType: "image/png" };
      },
    },
    getCurrentAccountId: () => "acct-1",
  }));

  const url = "/api/mail/messages/mail-1/attachments/attachment-public-1";
  const first = await app.request(url);
  const etag = first.headers.get("etag");
  assert.ok(etag);
  const cached = await app.request(url, { headers: { "If-None-Match": etag } });

  assert.equal(cached.status, 304);
  assert.equal(fetches, 1);
});

test("attachment route does not expose another account's attachment", async () => {
  let fetched = false;
  const app = new Hono();
  app.route("/api/mail", buildMailAttachmentRoutes({
    repository: { getAttachmentFetchDescriptor: () => descriptor },
    cache: new MailAttachmentCache(),
    gateway: {
      fetchAttachment: async () => {
        fetched = true;
        return { bytes: pngBytes(), mediaType: "image/png" };
      },
    },
    getCurrentAccountId: () => "acct-2",
  }));

  const response = await app.request(
    "/api/mail/messages/mail-1/attachments/attachment-public-1",
  );
  assert.equal(response.status, 404);
  assert.equal(fetched, false);
});
