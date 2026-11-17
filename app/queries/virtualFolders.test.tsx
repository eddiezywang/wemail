import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VirtualFolders } from "shared/folders";
import api from "~/services/api";
import { useVirtualEmails } from "./virtualFolders";

// One stable client per test — re-creating the client on every wrapper render
// swaps the provider value, re-creates query observers, and leaks fetches
// from earlier tests' caches into the current spy.
let client: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

afterEach(() => {
  client.clear();
  vi.restoreAllMocks();
});

describe("useVirtualEmails", () => {
  it("keeps local-only virtual folders local without issuing a server fetch", () => {
    client = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });
    const listSpy = vi
      .spyOn(api, "listEmails")
      .mockResolvedValue({ emails: [], totalCount: 0, unreadCount: 0 } as never);

    const { result } = renderHook(
      () => useVirtualEmails("acct-1", VirtualFolders.SCHEDULED),
      { wrapper },
    );

    expect(result.current.data).toBeUndefined();
    expect(listSpy).not.toHaveBeenCalled();
  });

  it("uses server-backed exact metadata for All Mail", async () => {
    client = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });
    const listSpy = vi.spyOn(api, "listEmails").mockResolvedValue({
      emails: [],
      totalCount: 6173,
      unreadCount: 6144,
    } as never);

    const { result } = renderHook(
      () => useVirtualEmails("acct-1", VirtualFolders.ALL_MAIL),
      { wrapper },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({
      emails: [],
      totalCount: 6173,
      unreadCount: 6144,
      hasMore: false,
      nextCursor: undefined,
    });
    expect(listSpy).toHaveBeenCalledWith(
      "acct-1",
      expect.objectContaining({ allMail: "1" }),
      expect.anything(),
    );
  });

  it("forwards the active time filter to All Mail", async () => {
    client = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });
    const listSpy = vi.spyOn(api, "listEmails").mockResolvedValue({
      emails: [],
      totalCount: 0,
      unreadCount: 0,
    } as never);

    const { result } = renderHook(
      () =>
        useVirtualEmails("acct-1", VirtualFolders.ALL_MAIL, {
          olderThan: "30d",
        }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(listSpy).toHaveBeenCalledWith(
      "acct-1",
      expect.objectContaining({
        allMail: "1",
        olderThan: "30d",
      }),
      expect.anything(),
    );
  });

  it("forwards all supported filters to All Mail", async () => {
    client = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });
    const listSpy = vi.spyOn(api, "listEmails").mockResolvedValue({
      emails: [],
      totalCount: 0,
      unreadCount: 0,
    } as never);

    const { result } = renderHook(
      () =>
        useVirtualEmails("acct-1", VirtualFolders.ALL_MAIL, {
          unread: "1",
          toMe: "1",
          ccMe: "1",
          hasAttachment: "1",
          olderThan: "180d",
          category: "important",
          tag: "finance",
        }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(listSpy).toHaveBeenCalledWith(
      "acct-1",
      expect.objectContaining({
        allMail: "1",
        unread: "1",
        toMe: "1",
        ccMe: "1",
        hasAttachment: "1",
        olderThan: "180d",
        category: "important",
        tag: "finance",
      }),
      expect.anything(),
    );
  });
});
