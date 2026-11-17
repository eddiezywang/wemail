import assert from "node:assert/strict";
import test from "node:test";
import { McpAttachmentUploadStore } from "./McpAttachmentUploadStore.js";

test("attachment uploads are session/account bound, reusable, and expire", () => {
  let now = new Date("2026-07-22T00:00:00.000Z");
  const store = new McpAttachmentUploadStore({ now: () => now, ttlMs: 1000 });
  const uploaded = store.upload({
    sessionHash: "session-a",
    accountId: "account-a",
    filename: "note.txt",
    mimeType: "text/plain",
    size: 4,
    dataBase64: "bm90ZQ==",
  });
  const first = store.resolve(uploaded.uploadRef, { sessionHash: "session-a", accountId: "account-a" });
  const second = store.resolve(uploaded.uploadRef, { sessionHash: "session-a", accountId: "account-a" });
  assert.deepEqual(first, second);
  assert.throws(
    () => store.resolve(uploaded.uploadRef, { sessionHash: "session-b", accountId: "account-a" }),
    (error: any) => error.code === "attachment_not_found",
  );
  assert.throws(
    () => store.resolve(uploaded.uploadRef, { sessionHash: "session-a", accountId: "account-b" }),
    (error: any) => error.code === "attachment_not_found",
  );
  now = new Date("2026-07-22T00:00:01.000Z");
  assert.equal(store.cleanupExpired(), 1);
  assert.throws(
    () => store.resolve(uploaded.uploadRef, { sessionHash: "session-a", accountId: "account-a" }),
    (error: any) => error.code === "attachment_not_found",
  );
});

test("attachment upload capacity is bounded without evicting live references", () => {
  const store = new McpAttachmentUploadStore({
    maxUploadsPerSession: 2,
    maxAttachmentBytes: 4,
    maxBytesPerSession: 4,
    maxBytesGlobal: 6,
  });
  const upload = (sessionHash: string, size: number, dataBase64: string) => store.upload({
    sessionHash,
    accountId: "account-a",
    filename: `${sessionHash}.bin`,
    mimeType: "application/octet-stream",
    size,
    dataBase64,
  });
  const first = upload("session-a", 2, "YWI=");
  upload("session-a", 2, "Y2Q=");
  assert.throws(() => upload("session-a", 1, "ZQ=="), (error: any) => error.code === "rate_limited");
  upload("session-b", 2, "ZWY=");
  assert.throws(() => upload("session-c", 1, "Zw=="), (error: any) => error.code === "rate_limited");
  assert.equal(store.resolve(first.uploadRef, { sessionHash: "session-a", accountId: "account-a" }).size, 2);
  assert.equal(store.purgeSession("session-a"), 2);
  assert.equal(store.size, 1);
});
