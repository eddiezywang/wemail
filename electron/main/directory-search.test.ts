import { describe, expect, it, vi } from "vitest";
import { createDesktopDirectorySearch } from "./directory-search.js";

describe("desktop directory search", () => {
  it("searches the active account without using renderer HTTP connections", async () => {
    const searchContacts = vi.fn().mockResolvedValue({
      contacts: [{ id: "evan", accountId: "acct-1", name: "Evan", email: "evan@example.com", aliases: [] }],
      total: 1,
      remoteAvailable: true,
    });
    const search = createDesktopDirectorySearch(() => ({
      composition: {
        accountService: { getCurrentAccount: () => ({ id: "acct-1" }) },
        directoryService: { searchContacts },
      },
    }));

    await expect(search({
      query: "evan",
      departmentId: "root",
      includeDescendants: true,
      limit: 8,
    })).resolves.toEqual({
      ok: true,
      contacts: [{ id: "evan", accountId: "acct-1", name: "Evan", email: "evan@example.com", aliases: [] }],
      total: 1,
      remoteAvailable: true,
    });
    expect(searchContacts).toHaveBeenCalledWith("acct-1", "evan", {
      departmentId: "root",
      includeDescendants: true,
      limit: 8,
      offset: undefined,
    });
  });

  it("rejects searches before an account is active", async () => {
    const search = createDesktopDirectorySearch(() => null);
    await expect(search({ query: "evan" })).rejects.toThrow("account-required");
  });
});
