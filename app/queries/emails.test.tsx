import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import api from "~/services/api";
import type { Email } from "~/types";
import { queryKeys } from "./keys";
import { releaseAutoRead, requestAutoRead, useEmail, useEmails, useUpdateEmail } from "./emails";

function makeEmail(id: string, overrides: Partial<Email> = {}): Email {
  return {
    id,
    subject: `Subject ${id}`,
    sender: "Alice",
    recipient: "bob@example.com",
    date: "2026-07-04T08:00:00.000Z",
    read: false,
    starred: false,
    snippet: `Snippet ${id}`,
    ...overrides,
  };
}

function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

function wrapper(queryClient: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useUpdateEmail", () => {
  it("optimistically patches emails stored in infinite list caches", async () => {
    const queryClient = createQueryClient();
    const listKey = queryKeys.emails.list("acct-1", {
      folder: "INBOX",
      limit: "100",
      threaded: "true",
    });
    queryClient.setQueryData(listKey, {
      pages: [
        {
          emails: [
            makeEmail("msg-1", { read: false }),
            makeEmail("msg-2", { read: false }),
          ],
          totalCount: 2,
        },
      ],
      pageParams: [undefined],
    });
    vi.spyOn(api, "updateEmail").mockResolvedValue({ ok: true } as never);

    const { result } = renderHook(() => useUpdateEmail(), {
      wrapper: wrapper(queryClient),
    });

    await act(async () => {
      await result.current.mutateAsync({
        mailboxId: "acct-1",
        id: "msg-1",
        data: { read: true },
      });
    });

    const cached = queryClient.getQueryData<{
      pages: Array<{ emails: Email[]; totalCount: number }>;
      pageParams: unknown[];
    }>(listKey);
    expect(cached?.pages[0]?.emails[0]?.read).toBe(true);
    expect(cached?.pages[0]?.emails[1]?.read).toBe(false);
  });

  it("keeps a read-only update local without refetching mail queries", async () => {
    const queryClient = createQueryClient();
    const detailKey = queryKeys.emails.detail("acct-1", "msg-1");
    const listKey = queryKeys.emails.list("acct-1", { folder: "INBOX" });
    queryClient.setQueryData(detailKey, makeEmail("msg-1", { body: "full body" }));
    queryClient.setQueryData(listKey, {
      pages: [{ emails: [makeEmail("msg-1")], totalCount: 1, unreadCount: 1 }],
      pageParams: [undefined],
    });
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");
    vi.spyOn(api, "updateEmail").mockResolvedValue({ ok: true } as never);
    const { result } = renderHook(() => useUpdateEmail(), {
      wrapper: wrapper(queryClient),
    });

    await act(async () => {
      await result.current.mutateAsync({
        mailboxId: "acct-1",
        id: "msg-1",
        data: { read: true },
      });
    });

    expect(
      invalidateQueries.mock.calls.filter(
        ([filters]) =>
          Array.isArray(filters.queryKey) &&
          (filters.queryKey[0] === "emails" || filters.queryKey[0] === "folders"),
      ),
    ).toHaveLength(0);
    expect(
      queryClient.getQueryData<{
        pages: Array<{ emails: Email[]; totalCount: number; unreadCount: number }>;
      }>(listKey)?.pages[0],
    ).toMatchObject({
      unreadCount: 0,
      emails: [expect.objectContaining({ id: "msg-1", read: true })],
    });
    expect(queryClient.getQueryData<Email>(detailKey)).toMatchObject({
      id: "msg-1",
      read: true,
      body: "full body",
    });
  });

  it("optimistically patches keyword and semantic search result caches", async () => {
    const queryClient = createQueryClient();
    const keywordKey = queryKeys.search.results("acct-1", "invoice", 1);
    const semanticKey = ["semantic-search", "acct-1", "invoice"] as const;
    queryClient.setQueryData(keywordKey, {
      results: [makeEmail("msg-1", { read: false })],
      totalCount: 1,
    });
    queryClient.setQueryData(semanticKey, {
      ok: true,
      results: [{
        email: makeEmail("msg-1", { read: false }),
        score: 0.9,
      }],
    });
    vi.spyOn(api, "updateEmail").mockResolvedValue({ ok: true } as never);
    const { result } = renderHook(() => useUpdateEmail(), {
      wrapper: wrapper(queryClient),
    });

    await act(async () => {
      await result.current.mutateAsync({
        mailboxId: "acct-1",
        id: "msg-1",
        data: { read: true },
      });
    });

    expect(queryClient.getQueryData<{ results: Email[] }>(keywordKey))
      .toMatchObject({ results: [expect.objectContaining({ read: true })] });
    expect(queryClient.getQueryData<{
      results: Array<{ email: Email }>;
    }>(semanticKey)).toMatchObject({
      results: [{ email: expect.objectContaining({ read: true }) }],
    });
  });
});

describe("useEmails", () => {
  it("separates All Mail caches by olderThan", () => {
    const sevenDays = queryKeys.emails.list("acct-1", {
      limit: "50",
      allMail: "1",
      olderThan: "7d",
    });
    const thirtyDays = queryKeys.emails.list("acct-1", {
      limit: "50",
      allMail: "1",
      olderThan: "30d",
    });

    expect(sevenDays).not.toEqual(thirtyDays);
  });

  it("preserves exact server totals independently from loaded rows", async () => {
    const queryClient = createQueryClient();
    vi.spyOn(api, "listEmails").mockResolvedValue({
      emails: [makeEmail("msg-1")],
      totalCount: 3003,
      unreadCount: 2974,
    } as never);

    const { result } = renderHook(
      () => useEmails("acct-1", { folder: "inbox" }),
      { wrapper: wrapper(queryClient) },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toMatchObject({
      emails: [expect.objectContaining({ id: "msg-1" })],
      totalCount: 3003,
      unreadCount: 2974,
    });
  });

  it("uses the server continuation cursor for category pagination", async () => {
    const queryClient = createQueryClient();
    const listEmails = vi.spyOn(api, "listEmails")
      .mockResolvedValueOnce({
        emails: [makeEmail("msg-2")],
        totalCount: 2,
        unreadCount: 2,
        nextCursor: "category-cursor",
      } as never)
      .mockResolvedValueOnce({
        emails: [makeEmail("msg-1")],
        totalCount: 2,
        unreadCount: 2,
      } as never);

    const { result } = renderHook(
      () => useEmails("acct-1", { folder: "inbox", category: "marketing" }),
      { wrapper: wrapper(queryClient) },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    let nextPageResult: Awaited<ReturnType<typeof result.current.fetchNextPage>> | undefined;
    await act(async () => {
      nextPageResult = await result.current.fetchNextPage();
    });

    expect(listEmails).toHaveBeenNthCalledWith(
      2,
      "acct-1",
      expect.objectContaining({
        category: "marketing",
        cursor: "category-cursor",
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(nextPageResult?.data?.emails.map((email) => email.id)).toEqual([
      "msg-2",
      "msg-1",
    ]);
  });
});

describe("useEmail body recovery", () => {
  it("passively ensures a missing body only once", async () => {
    const queryClient = createQueryClient();
    vi.spyOn(api, "getEmail").mockResolvedValue(
      makeEmail("msg-1", {
        body: null,
        bodyPending: true,
        bodyState: "missing",
      }),
    );
    const ensure = vi.spyOn(api, "ensureEmailBody").mockResolvedValue({
      status: "queued",
      jobId: 1,
    });
    const { result } = renderHook(() => useEmail("acct-1", "msg-1"), {
      wrapper: wrapper(queryClient),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    await waitFor(() => expect(ensure).toHaveBeenCalledTimes(1));
    await result.current.refetch();
    expect(ensure).toHaveBeenCalledTimes(1);
  });

  it("does not passively revive a failed body and uses explicit retry", async () => {
    const queryClient = createQueryClient();
    vi.spyOn(api, "getEmail").mockResolvedValue(
      makeEmail("msg-1", {
        body: null,
        bodyPending: true,
        bodyState: "failed",
        bodyErrorCode: "imap.login:ECONNRESET",
        bodyRetryable: true,
      }),
    );
    const ensure = vi.spyOn(api, "ensureEmailBody").mockResolvedValue({
      status: "failed",
      jobId: 1,
    });
    const retry = vi.spyOn(api, "retryEmailBody").mockResolvedValue({
      status: "queued",
      jobId: 1,
    });
    const { result } = renderHook(() => useEmail("acct-1", "msg-1"), {
      wrapper: wrapper(queryClient),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.bodyPollingExhausted).toBe(true);
    expect(ensure).not.toHaveBeenCalled();
    await act(async () => {
      await result.current.retryBody();
    });
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("automatically loads an oversized body when its detail opens", async () => {
    const queryClient = createQueryClient();
    vi.spyOn(api, "getEmail").mockResolvedValue(
      makeEmail("msg-1", {
        body: null,
        bodyPending: false,
        bodyState: "failed",
        bodyErrorCode: "mail-body-too-large",
        bodyRetryable: false,
      }),
    );
    const ensure = vi.spyOn(api, "ensureEmailBody").mockResolvedValue({
      status: "failed",
      jobId: 1,
    });
    const retry = vi.spyOn(api, "retryEmailBody").mockResolvedValue({
      status: "queued",
      jobId: 1,
    });

    const { result } = renderHook(() => useEmail("acct-1", "msg-1"), {
      wrapper: wrapper(queryClient),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    await waitFor(() => expect(retry).toHaveBeenCalledWith("acct-1", "msg-1", true));
    expect(ensure).not.toHaveBeenCalled();
  });

  it("does not ensure while only a list-summary placeholder is cached", async () => {
    const queryClient = createQueryClient();
    // Click seeds a list-summary placeholder: no body and bodyPending true,
    // but crucially NO bodyState (getEmail always sets one).
    queryClient.setQueryData(
      queryKeys.emails.detail("acct-1", "msg-1"),
      { ...makeEmail("msg-1"), bodyPending: true } as Email,
      { updatedAt: 0 },
    );
    vi.spyOn(api, "getEmail").mockResolvedValue(
      makeEmail("msg-1", { body: "full body", bodyState: "ready" }),
    );
    const ensure = vi.spyOn(api, "ensureEmailBody").mockResolvedValue({
      status: "queued",
      jobId: 1,
    });
    const { result } = renderHook(() => useEmail("acct-1", "msg-1"), {
      wrapper: wrapper(queryClient),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    // The placeholder (bodyState undefined) must not trigger an ensure, and
    // the resolved ready body must not either.
    expect(ensure).not.toHaveBeenCalled();
  });
});

describe("auto-read cross-component dedup (requestAutoRead/releaseAutoRead)", () => {
  it("lets only the first caller claim the mark-read for an email", () => {
    // Simulates the open of an unread email: the detail panel (EmailPanel)
    // and the list (_workbench) both call requestAutoRead in the same commit
    // flush. Only the first should fire the mutation.
    expect(requestAutoRead("acct-1", "msg-1")).toBe(true);
    expect(requestAutoRead("acct-1", "msg-1")).toBe(false);
    // A different email is independent.
    expect(requestAutoRead("acct-1", "msg-2")).toBe(true);
  });

  it("re-allows claiming after the in-flight mutation settles", () => {
    expect(requestAutoRead("acct-1", "msg-3")).toBe(true);
    releaseAutoRead("acct-1", "msg-3");
    expect(requestAutoRead("acct-1", "msg-3")).toBe(true);
    releaseAutoRead("acct-1", "msg-3");
  });

  it("releaseAutoRead is safe to call for an unclaimed email", () => {
    expect(() => releaseAutoRead("acct-1", "never-claimed")).not.toThrow();
  });
});
