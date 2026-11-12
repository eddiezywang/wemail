import { expect, test } from "vitest";
import { isMailBodyCached } from "./mail.js";

test("an omitted body cache marker does not make metadata-only mail hydrated", () => {
  expect(isMailBodyCached({ bodyText: "" })).toBe(false);
  expect(isMailBodyCached({ bodyText: "", bodyCachedUntil: null })).toBe(false);
  expect(isMailBodyCached({ bodyText: "body" })).toBe(true);
  expect(isMailBodyCached({ bodyText: "", bodyCachedUntil: "2026-11-04T00:00:00Z" })).toBe(true);
});
