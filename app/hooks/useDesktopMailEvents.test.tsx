import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDesktopMailEvents } from "./useDesktopMailEvents";

function Probe() {
  useDesktopMailEvents();
  return null;
}

describe("useDesktopMailEvents", () => {
  const originalDesktop = window.wemailDesktop;

  beforeEach(() => {
    window.wemailDesktop = originalDesktop;
  });

  afterEach(() => {
    window.wemailDesktop = originalDesktop;
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
      });
      expect(invalidateQueries).toHaveBeenCalledWith({
        queryKey: ["folders", "acct-1"],
      });
      expect(invalidateQueries).toHaveBeenCalledWith({
        queryKey: ["list-categories", "acct-1"],
      });
    });
  });
});
