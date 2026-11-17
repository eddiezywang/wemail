// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { describe, expect, it } from "vitest";
import { parseSearchQuery } from "~/lib/search-parser";

describe("parseSearchQuery", () => {
  it("parses a simple free-text query", () => {
    const result = parseSearchQuery("hello world");
    expect(result.query).toBe("hello world");
  });

  it("parses from: operator", () => {
    const result = parseSearchQuery("from:alice@example.com");
    expect(result.from).toBe("alice@example.com");
    expect(result.query).toBe("");
  });

  it("parses to: operator", () => {
    const result = parseSearchQuery("to:bob@example.com meeting");
    expect(result.to).toBe("bob@example.com");
    expect(result.query).toBe("meeting");
  });

  it("parses subject: operator", () => {
    const result = parseSearchQuery('subject:"Re: Hello"');
    expect(result.subject).toBe("Re: Hello");
  });

  it("parses in: operator as folder", () => {
    const result = parseSearchQuery("in:inbox");
    expect(result.folder).toBe("inbox");
  });

  it("parses is:unread operator", () => {
    const result = parseSearchQuery("is:unread");
    expect(result.is_read).toBe(false);
  });

  it("parses is:read operator", () => {
    const result = parseSearchQuery("is:read");
    expect(result.is_read).toBe(true);
  });

  it("parses is:starred operator", () => {
    const result = parseSearchQuery("is:starred");
    expect(result.is_starred).toBe(true);
  });

  it("parses has:attachment operator", () => {
    const result = parseSearchQuery("has:attachment");
    expect(result.has_attachment).toBe(true);
  });

  it("parses before: date operator", () => {
    const result = parseSearchQuery("before:2025-01-01");
    expect(result.date_end).toBeDefined();
  });

  it("parses after: date operator", () => {
    const result = parseSearchQuery("after:2025-06-15");
    expect(result.date_start).toBeDefined();
  });

  it("combines multiple operators with free text", () => {
    const result = parseSearchQuery("from:alice is:unread project update");
    expect(result.from).toBe("alice");
    expect(result.is_read).toBe(false);
    expect(result.query).toBe("project update");
  });

  it("handles quoted values in operators", () => {
    const result = parseSearchQuery('from:"John Doe" subject:"meeting notes"');
    expect(result.from).toBe("John Doe");
    expect(result.subject).toBe("meeting notes");
  });

  it("returns empty query when only operators are provided", () => {
    const result = parseSearchQuery("is:unread in:inbox");
    expect(result.is_read).toBe(false);
    expect(result.folder).toBe("inbox");
    expect(result.query).toBe("");
  });

  it("handles case-insensitive operators", () => {
    const result = parseSearchQuery("FROM:alice IN:inbox");
    expect(result.from).toBe("alice");
    expect(result.folder).toBe("inbox");
  });

  it("handles empty input", () => {
    const result = parseSearchQuery("");
    expect(result.query).toBe("");
    expect(result.from).toBeUndefined();
  });
});
