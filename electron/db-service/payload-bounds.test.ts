import { describe, expect, test } from "vitest";
import { clampDeadline, payloadWithinBounds } from "./payload-bounds.js";

describe("database payload bounds", () => {
  test("accepts a shared repair cursor in consecutive checkpoints", () => {
    const repair = { version: 1, uid: 42, completed: false };
    const previous = { uid: 100, repair };
    const next = { ...previous, uid: 101 };
    expect(payloadWithinBounds({ checkpoint: { previous, next } }, 8192, 100)).toBe(true);
  });

  test("rejects cycles and oversized expanded payloads", () => {
    const cycle: { self?: unknown } = {};
    cycle.self = cycle;
    expect(payloadWithinBounds(cycle, 8192, 100)).toBe(false);
    const shared = { value: "x".repeat(10) };
    expect(payloadWithinBounds([shared, shared], 30, 100)).toBe(false);
    expect(payloadWithinBounds([shared, shared], 8192, 4)).toBe(false);
  });

  test("bounds a deadline without rejecting clock skew or extending shorter deadlines", () => {
    expect(clampDeadline(61_005, 1_000, 60_000)).toBe(61_000);
    expect(clampDeadline(20_000, 1_000, 60_000)).toBe(20_000);
    expect(clampDeadline(500, 1_000, 60_000)).toBe(500);
  });
});
