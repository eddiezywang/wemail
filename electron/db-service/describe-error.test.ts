import { describe, expect, test } from "vitest";
import { describeError } from "./describe-error.js";

describe("describeError", () => {
  test("extracts Error message", () => {
    expect(describeError(new Error("boom"))).toBe("boom");
  });

  test("falls back to Error name when message is empty", () => {
    const error = new Error("");
    error.name = "BootstrapError";
    expect(describeError(error)).toBe("BootstrapError");
  });

  test("extracts plain object message", () => {
    expect(describeError({ message: "worker exploded" })).toBe("worker exploded");
  });

  test("falls back to code for plain objects without message", () => {
    expect(describeError({ code: "ERR_NATIVE_BINDING" })).toBe("ERR_NATIVE_BINDING");
  });

  test("JSON fallback for opaque objects", () => {
    expect(describeError({ detail: "x" })).toBe(JSON.stringify({ detail: "x" }));
  });

  test("strings pass through", () => {
    expect(describeError("raw string")).toBe("raw string");
  });

  test("primitives stringify", () => {
    expect(describeError(42)).toBe("42");
    expect(describeError(undefined)).toBe("undefined");
    expect(describeError(null)).toBe("null");
  });

  test("never yields [object Object]", () => {
    expect(describeError({})).not.toBe("[object Object]");
    expect(describeError({ nested: { deep: true } })).not.toBe("[object Object]");
  });
});
