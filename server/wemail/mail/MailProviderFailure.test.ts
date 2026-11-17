import assert from "node:assert/strict";
import test from "node:test";
import { classifyMailProviderFailure, mailProviderRetryAfterMs } from "./MailProviderFailure.js";

test("metadata timeouts recycle connections and provider retry deadlines remain explicit", () => {
  assert.equal(classifyMailProviderFailure(new Error("mail-provider-metadata-timeout")), "connection");
  assert.equal(mailProviderRetryAfterMs({ retryAfterMs: 120_000 }), 120_000);
  assert.equal(mailProviderRetryAfterMs({ cause: { retryAfter: 120 } }), 120_000);
  assert.equal(mailProviderRetryAfterMs({ retryAfterMs: -1 }), undefined);
  assert.equal(mailProviderRetryAfterMs({ retryAfterMs: Infinity }), undefined);
});
