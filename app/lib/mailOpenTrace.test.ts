import { afterEach, expect, test, vi } from "vitest";
import { beginMailOpenTrace, markMailOpenStage } from "./mailOpenTrace";

afterEach(() => {
  performance.clearMarks();
  performance.clearMeasures();
  vi.restoreAllMocks();
});

test("the detail hook reuses the click trace and a new click replaces an abandoned open", () => {
  const first = beginMailOpenTrace("revisited-message", true);
  expect(beginMailOpenTrace("revisited-message")).toBe(first);
  const second = beginMailOpenTrace("revisited-message", true);
  expect(second).not.toBe(first);
  markMailOpenStage("revisited-message", "metadata-ready", first);
  expect(performance.getEntriesByName("wemail.mail-open")).toHaveLength(0);
  markMailOpenStage("revisited-message", "metadata-ready", second);
  expect(performance.getEntriesByName("wemail.mail-open")).toHaveLength(1);
});

test("paint completes a trace once and logs correlation without message identifiers", () => {
  const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
  const traceId = beginMailOpenTrace("private-message-id", true);
  markMailOpenStage("private-message-id", "body-paint", traceId);
  markMailOpenStage("private-message-id", "body-paint", traceId);
  expect(debug).toHaveBeenCalledTimes(1);
  expect(debug.mock.calls[0][0]).toContain(traceId);
  expect(debug.mock.calls[0][0]).not.toContain("private-message-id");
  expect(beginMailOpenTrace("private-message-id")).not.toBe(traceId);
});
