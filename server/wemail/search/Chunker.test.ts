import assert from "node:assert/strict";
import { test } from "node:test";
import { chunkEmail, extractLexicalTerms } from "./Chunker.js";

test("chunkEmail returns empty array for empty body", () => {
  const chunks = chunkEmail({ emailId: "e1", bodyText: "" });
  assert.equal(chunks.length, 0);
});

test("chunkEmail returns single chunk for short text", () => {
  const chunks = chunkEmail({
    emailId: "e1",
    bodyText: "Hello world, this is a short email.",
  });
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0]!.chunkId, "e1::chunk-0");
  assert.ok(chunks[0]!.text.includes("Hello world"));
});

test("chunkEmail prepends subject to every chunk", () => {
  const chunks = chunkEmail({
    emailId: "e1",
    bodyText: "Body content here.",
    subject: "Important Update",
  });
  assert.equal(chunks.length, 1);
  assert.ok(chunks[0]!.text.startsWith("Subject: Important Update"));
  assert.ok(chunks[0]!.text.includes("Body content here"));
});

test("chunkEmail splits long text into multiple chunks with overlap", () => {
  const longText = "A".repeat(2000);
  const chunks = chunkEmail({ emailId: "e1", bodyText: longText });
  assert.ok(chunks.length > 1, "Expected multiple chunks for long text");
  // Each chunk should have the email id prefix
  for (const chunk of chunks) {
    assert.ok(chunk.chunkId.startsWith("e1::chunk-"));
  }
});

test("chunkEmail folds short tail into previous chunk", () => {
  // Create text that results in a very short last chunk
  const text = "A".repeat(850);
  const chunks = chunkEmail({ emailId: "e1", bodyText: text });
  // The last chunk should not be a degenerate single-sentence chunk
  if (chunks.length > 1) {
    const lastChunk = chunks[chunks.length - 1]!;
    assert.ok(
      lastChunk.text.length > 100 || chunks.length === 1,
      "Short tails should be folded into previous chunks",
    );
  }
});

test("chunkEmail produces stable chunk IDs", () => {
  const text = "Hello world, this is a test email with some content.";
  const chunks1 = chunkEmail({ emailId: "e1", bodyText: text });
  const chunks2 = chunkEmail({ emailId: "e1", bodyText: text });
  assert.deepEqual(
    chunks1.map((c) => c.chunkId),
    chunks2.map((c) => c.chunkId),
  );
});

test("extractLexicalTerms normalizes to lowercase", () => {
  const terms = extractLexicalTerms("Hello WORLD");
  assert.ok(terms.includes("hello"));
  assert.ok(terms.includes("world"));
});

test("extractLexicalTerms strips punctuation", () => {
  const terms = extractLexicalTerms("Hello, world! How are you?");
  assert.ok(terms.includes("hello"));
  assert.ok(terms.includes("world"));
});

test("extractLexicalTerms deduplicates", () => {
  const terms = extractLexicalTerms("hello hello world world");
  const unique = [...new Set(terms)];
  assert.deepEqual(terms, unique);
});

test("extractLexicalTerms filters out single-character terms", () => {
  const terms = extractLexicalTerms("I a the big");
  assert.ok(!terms.includes("i"));
  assert.ok(!terms.includes("a"));
  assert.ok(terms.includes("the"));
  assert.ok(terms.includes("big"));
});

test("extractLexicalTerms handles empty input", () => {
  const terms = extractLexicalTerms("");
  assert.equal(terms.length, 0);
});
