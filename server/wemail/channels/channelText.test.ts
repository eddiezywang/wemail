import assert from "node:assert/strict";
import test from "node:test";
import {
  sanitizePresentation,
  truncateToBytes,
  truncateToChars,
} from "./channelText.js";

test("sanitizePresentation: redacts api keys, tokens, secrets", () => {
  const out = sanitizePresentation("use api_key=sk-abc123 to auth");
  assert.match(out, /api_key=\[已隐藏\]/);
  assert(!out.includes("sk-abc123"));
});

test("sanitizePresentation: redacts token and secret assignments", () => {
  const out = sanitizePresentation("token: abc123 secret=xyz");
  // the separator is normalized to "=" in the redaction
  assert.match(out, /token=\[已隐藏\]/);
  assert.match(out, /secret=\[已隐藏\]/);
  assert(!out.includes("abc123"));
  assert(!out.includes("xyz"));
});

test("sanitizePresentation: hides Windows local paths", () => {
  const out = sanitizePresentation("saved to C:\\Users\\eddie\\file.txt");
  assert.match(out, /\[本地路径已隐藏\]/);
  assert(!out.includes("C:\\Users"));
});

test("sanitizePresentation: caps length at 32000 chars", () => {
  const out = sanitizePresentation("x".repeat(40_000));
  assert.equal(out.length, 32_000);
});

test("sanitizePresentation: leaves ordinary text untouched", () => {
  assert.equal(
    sanitizePresentation("邮件已发送，共 3 封。"),
    "邮件已发送，共 3 封。",
  );
});

test("truncateToBytes: returns text unchanged when within budget", () => {
  assert.equal(truncateToBytes("abc", 100), "abc");
});

test("truncateToBytes: cuts on a code-point boundary (emoji not split)", () => {
  // "🚀" is 4 UTF-8 bytes; budget of 4 must keep the whole emoji, 3 must drop it.
  assert.equal(truncateToBytes("🚀", 4), "🚀");
  assert.equal(truncateToBytes("🚀", 3), "");
  // a single huge delta must not jump past the cap
  const huge = "x".repeat(50_000);
  const out = truncateToBytes(huge, 1_000);
  assert.ok(Buffer.byteLength(out, "utf8") <= 1_000);
});

test("truncateToChars: caps code-point count, emoji counts as one", () => {
  assert.equal(truncateToChars("abc🚀def", 4), "abc🚀");
  assert.equal(truncateToChars("🚀🚀🚀", 2), "🚀🚀");
  assert.equal(truncateToChars("abc", 0), "");
});
