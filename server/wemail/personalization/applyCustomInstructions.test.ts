import assert from "node:assert/strict";
import { test } from "node:test";
import { applyCustomInstructions } from "./applyCustomInstructions.js";

test("returns base prompt when customInstructions is null", () => {
  assert.equal(applyCustomInstructions("base", null), "base");
});

test("returns base prompt when customInstructions is undefined", () => {
  assert.equal(applyCustomInstructions("base", undefined), "base");
});

test("returns base prompt when customInstructions is empty string", () => {
  assert.equal(applyCustomInstructions("base", ""), "base");
});

test("returns base prompt when customInstructions is whitespace only", () => {
  assert.equal(applyCustomInstructions("base", "   \n\t  "), "base");
});

test("appends customInstructions section when provided", () => {
  const result = applyCustomInstructions("base prompt", "Use bullet points");
  assert.ok(result.startsWith("base prompt\n\n"));
  assert.ok(result.includes("## User custom instructions"));
  assert.ok(result.endsWith("Use bullet points"));
});

test("trims customInstructions before appending", () => {
  const result = applyCustomInstructions("base", "  hello  \n");
  assert.ok(result.endsWith("hello"));
});

test("non-string customInstructions returns base", () => {
  // @ts-expect-error — verifying runtime resilience
  assert.equal(applyCustomInstructions("base", 42), "base");
  // @ts-expect-error — verifying runtime resilience
  assert.equal(applyCustomInstructions("base", { foo: "bar" }), "base");
});
