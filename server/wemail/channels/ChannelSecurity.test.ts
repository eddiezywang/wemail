import assert from "node:assert/strict";
import test from "node:test";
import {
  ChannelSenderRateLimiter,
  constantTimeSecretMatches,
  isLoopbackLangBotUrl,
  validateLangBotEnablement,
} from "./ChannelSecurity.js";

test("constant-time webhook comparison rejects missing and mismatched secrets", () => {
  assert.equal(constantTimeSecretMatches("secret", "secret"), true);
  assert.equal(constantTimeSecretMatches("secret", "different"), false);
  assert.equal(constantTimeSecretMatches(undefined, undefined), false);
});

test("connection enablement permits loopback and requires encrypted TLS remotely", () => {
  assert.equal(isLoopbackLangBotUrl("http://127.0.0.1:5300"), true);
  validateLangBotEnablement({
    baseUrl: "http://localhost:5300",
    trustMode: "loopback",
    secrets: { isEncryptionAvailable: () => false },
  });
  assert.throws(
    () =>
      validateLangBotEnablement({
        baseUrl: "http://langbot.example.com",
        trustMode: "remote",
        secrets: { isEncryptionAvailable: () => true },
      }),
    /langbot-remote-tls-required/,
  );
  assert.throws(
    () =>
      validateLangBotEnablement({
        baseUrl: "https://langbot.example.com",
        trustMode: "remote",
        secrets: { isEncryptionAvailable: () => false },
      }),
    /langbot-encrypted-secret-store-required/,
  );
});

test("sender rate limits are isolated by composite key", () => {
  let now = 0;
  const limiter = new ChannelSenderRateLimiter(2, 1000, () => now);
  assert.equal(limiter.consume("connection:bot:sender-a"), true);
  assert.equal(limiter.consume("connection:bot:sender-a"), true);
  assert.equal(limiter.consume("connection:bot:sender-a"), false);
  assert.equal(limiter.consume("connection:bot:sender-b"), true);
  now = 1001;
  assert.equal(limiter.consume("connection:bot:sender-a"), true);
});
