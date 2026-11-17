import assert from "node:assert/strict";
import test from "node:test";
import { resolveRemoteLocatorWithRetry } from "./MailCoreRemoteLocatorResolver.js";

test("remote locator resolution retries until the moved message becomes visible", async () => {
  let attempts = 0;
  const waited: number[] = [];
  const result = await resolveRemoteLocatorWithRetry(
    {
      resolveMessageLocator: async (folder, messageId) => {
        attempts += 1;
        assert.equal(folder, "Archive");
        assert.equal(messageId, "<message-42@example.com>");
        return attempts === 3 ? { uid: 107, uidValidity: 23 } : null;
      },
    },
    "Archive",
    "<message-42@example.com>",
    [0, 250, 1_000],
    async (delayMs) => {
      waited.push(delayMs);
    },
  );

  assert.deepEqual(result, { uid: 107, uidValidity: 23 });
  assert.equal(attempts, 3);
  assert.deepEqual(waited, [250, 1_000]);
});

test("remote locator resolution returns null after its bounded attempts", async () => {
  let attempts = 0;
  const result = await resolveRemoteLocatorWithRetry(
    {
      resolveMessageLocator: async () => {
        attempts += 1;
        return null;
      },
    },
    "Trash",
    "message-42",
    [0, 0, 0],
  );

  assert.equal(result, null);
  assert.equal(attempts, 3);
});
