import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMailEvents } from "./useMailEvents";
import { MAIL_AUTH_REQUIRED_EVENT } from "~/lib/mailCredentialEvents";
import { markAllMailRead } from "~/lib/markAllMailRead";
import api from "~/services/api";
import type { MailDatabaseChangeEvent } from "../../shared/wemail/mailDatabaseProtocol";

const currentAccountMock = vi.fn();
const { toastMock } = vi.hoisted(() => ({
  toastMock: vi.fn(),
}));

vi.mock("~/queries/currentAccount", () => ({
  useCurrentAccount: () => currentAccountMock(),
}));

vi.mock("sonner", () => ({
  toast: toastMock,
}));

function Probe() {
  useMailEvents();
  return null;
}

describe("useMailEvents", () => {
  it("does not refetch mail lists and counters for each message during bulk read", async () => {
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    let emit!: (event: MailDatabaseChangeEvent) => void;
    window.wemailDesktop = { mailDatabase: { onChanged(callback: (event: MailDatabaseChangeEvent) => void) { emit = callback; return () => {}; } } } as unknown as typeof window.wemailDesktop;
    let finish!: (value: Awaited<ReturnType<typeof api.listEmails>>) => void;
    const list = vi.spyOn(api, "listEmails").mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    render(<QueryClientProvider client={client}><Probe /></QueryClientProvider>);
    const running = markAllMailRead("acct-1", { folder: "INBOX" }, vi.fn());
    const changes = [
      { entityType: "message", entityPublicId: "mail", operation: "update" },
      { entityType: "folder", entityPublicId: "INBOX", operation: "update" },
      { entityType: "category", entityPublicId: "invoice", operation: "update" },
    ];
    try {
      act(() => emit({ commitVersion: 1, changes } as MailDatabaseChangeEvent));
      for (const key of ["emails", "folders", "list-categories"]) {
        expect(invalidate).not.toHaveBeenCalledWith(expect.objectContaining({ queryKey: [key, "acct-1"] }));
      }
      finish({ emails: [], hasMore: false, totalCount: 0, unreadCount: 0 });
      await running;
      act(() => emit({ commitVersion: 2, changes } as MailDatabaseChangeEvent));
      expect(invalidate).toHaveBeenCalledWith(expect.objectContaining({ queryKey: ["emails", "acct-1"] }));
    } finally {
      finish({ emails: [], hasMore: false, totalCount: 0, unreadCount: 0 });
      await running;
      list.mockRestore();
    }
  });
  const originalDesktop = window.wemailDesktop;
  const originalEventSource = globalThis.EventSource;

  beforeEach(() => {
    window.wemailDesktop = originalDesktop;
    currentAccountMock.mockReturnValue({
      data: { account: { id: "acct-1", emailAddress: "user@example.com" } },
    });
    toastMock.mockReset();
  });

  afterEach(() => {
    window.wemailDesktop = originalDesktop;
    currentAccountMock.mockReset();
    vi.useRealTimers();
    if (originalEventSource) {
      vi.stubGlobal("EventSource", originalEventSource);
    } else {
      vi.unstubAllGlobals();
    }
  });

  it("invalidates email, folder, and category queries when desktop mail changes", async () => {
    const queryClient = new QueryClient();
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");
    let emit: ((payload: { accountId: string; insertedIds: string[] }) => void) | null = null;

    window.wemailDesktop = {
      onMailChanged: (
        callback: (payload: { accountId: string; insertedIds: string[] }) => void,
      ) => {
        emit = callback;
        return () => {
          emit = null;
        };
      },
    };

    render(
      <QueryClientProvider client={queryClient}>
        <Probe />
      </QueryClientProvider>,
    );

    act(() => {
      emit?.({ accountId: "acct-1", insertedIds: ["m-1"] });
    });

    await waitFor(() => {
      expect(invalidateQueries).toHaveBeenCalledWith({
        queryKey: ["emails", "acct-1"],
        predicate: expect.any(Function),
        refetchType: "active",
      });
      expect(invalidateQueries).toHaveBeenCalledWith({
        queryKey: ["folders", "acct-1"],
        refetchType: "active",
      });
      expect(invalidateQueries).toHaveBeenCalledWith({
        queryKey: ["list-categories", "acct-1"],
        refetchType: "active",
      });
    });
  });

  it("updates counts from a metadata insert before any body or folder event arrives", async () => {
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    let emit!: (event: MailDatabaseChangeEvent) => void;
    window.wemailDesktop = { mailDatabase: {
      onChanged(callback: (event: MailDatabaseChangeEvent) => void) { emit = callback; return () => {}; },
    } } as unknown as typeof window.wemailDesktop;
    const rendered = render(<QueryClientProvider client={client}><Probe /></QueryClientProvider>);
    try {
      act(() => emit({
        type: "mail-database.changed", commitVersion: 77,
        changes: [{ entityType: "message", entityPublicId: "new-mail", operation: "insert", scopeHint: "account:acct-1" }],
      }));
      for (const key of ["emails", "folders", "list-categories"]) {
        expect(invalidate).toHaveBeenCalledWith(expect.objectContaining({ queryKey: [key, "acct-1"] }));
      }
    } finally { rendered.unmount(); }
  });

  it("does not duplicate desktop new-mail delivery with an in-app toast", async () => {
    let emit: ((payload: { accountId: string; insertedIds: string[] }) => void) | null = null;

    window.wemailDesktop = {
      onMailChanged: (
        callback: (payload: { accountId: string; insertedIds: string[] }) => void,
      ) => {
        emit = callback;
        return () => {
          emit = null;
        };
      },
    };

    render(
      <QueryClientProvider client={new QueryClient()}>
        <Probe />
      </QueryClientProvider>,
    );

    act(() => {
      emit?.({ accountId: "acct-1", insertedIds: ["m-1", "m-2"] });
    });

    await waitFor(() => {
      expect(toastMock).not.toHaveBeenCalled();
    });
  });

  it("does not show an in-app notification for empty mail change events", async () => {
    let emit: ((payload: { accountId: string; insertedIds: string[] }) => void) | null = null;

    window.wemailDesktop = {
      onMailChanged: (
        callback: (payload: { accountId: string; insertedIds: string[] }) => void,
      ) => {
        emit = callback;
        return () => {
          emit = null;
        };
      },
    };

    render(
      <QueryClientProvider client={new QueryClient()}>
        <Probe />
      </QueryClientProvider>,
    );

    act(() => {
      emit?.({ accountId: "acct-1", insertedIds: [] });
    });

    await waitFor(() => {
      expect(toastMock).not.toHaveBeenCalled();
    });
  });

  it("does not create EventSource when desktop mail events are available", () => {
    const eventSource = vi.fn();
    window.wemailDesktop = {
      onMailChanged: () => () => {},
    };
    vi.stubGlobal("EventSource", eventSource as unknown as typeof EventSource);

    render(
      <QueryClientProvider client={new QueryClient()}>
        <Probe />
      </QueryClientProvider>,
    );

    expect(eventSource).not.toHaveBeenCalled();
  });

  it("refreshes current mailbox data when the desktop window regains focus", async () => {
    const queryClient = new QueryClient();
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");
    window.wemailDesktop = {
      onMailChanged: () => () => {},
    };

    render(
      <QueryClientProvider client={queryClient}>
        <Probe />
      </QueryClientProvider>,
    );

    act(() => {
      window.dispatchEvent(new Event("focus"));
    });

    await waitFor(() => {
      expect(invalidateQueries).toHaveBeenCalledWith({
        queryKey: ["emails", "acct-1"],
        predicate: expect.any(Function),
        refetchType: "active",
      });
    });
  });

  it("forwards desktop credential failures to the global recovery event", async () => {
    let emit:
      | ((payload: {
          accountId: string;
          code: "MAIL_CREDENTIAL_INVALID";
          stage: "imap.login";
        }) => void)
      | null = null;
    const received = vi.fn();
    window.addEventListener(MAIL_AUTH_REQUIRED_EVENT, received);
    window.wemailDesktop = {
      onMailAuthRequired: (callback) => {
        emit = callback;
        return () => {
          emit = null;
        };
      },
    };

    const view = render(
      <QueryClientProvider client={new QueryClient()}>
        <Probe />
      </QueryClientProvider>,
    );

    act(() => {
      emit?.({
        accountId: "acct-1",
        code: "MAIL_CREDENTIAL_INVALID",
        stage: "imap.login",
      });
    });

    await waitFor(() => expect(received).toHaveBeenCalledTimes(1));
    const event = received.mock.calls[0]?.[0] as CustomEvent;
    expect(event.detail).toEqual({
      accountId: "acct-1",
      code: "MAIL_CREDENTIAL_INVALID",
      source: "background",
    });

    view.unmount();
    window.removeEventListener(MAIL_AUTH_REQUIRED_EVENT, received);
  });

  it("runs one catch-up refresh when the page becomes visible again", async () => {
    const queryClient = new QueryClient();
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");

    render(
      <QueryClientProvider client={queryClient}>
        <Probe />
      </QueryClientProvider>,
    );

    act(() => {
      Object.defineProperty(document, "visibilityState", {
        value: "visible",
        configurable: true,
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });

    await waitFor(() => {
      expect(invalidateQueries).toHaveBeenCalledWith({
        queryKey: ["emails", "acct-1"],
        predicate: expect.any(Function),
        refetchType: "active",
      });
    });
  });
});
