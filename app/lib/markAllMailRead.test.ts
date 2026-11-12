import { afterEach, describe, expect, it, vi } from "vitest";
import api from "~/services/api";
import type { Email } from "~/types";
import { isMarkAllMailReadRunning, markAllMailRead } from "./markAllMailRead";

function page(ids: string[], nextCursor?: string) {
  return { emails: ids.map((id) => ({ id, read: false })) as Email[], totalCount: ids.length,
    unreadCount: ids.length, hasMore: !!nextCursor, nextCursor };
}

afterEach(() => vi.restoreAllMocks());

describe("markAllMailRead", () => {
  it("keeps the account busy until cancellation settles and clears it afterwards", async () => {
    const controller = new AbortController();
    let finish!: (value: ReturnType<typeof page>) => void;
    vi.spyOn(api, "listEmails").mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const pending = markAllMailRead("account", { folder: "INBOX" }, vi.fn(), controller.signal);
    expect(isMarkAllMailReadRunning("account")).toBe(true);
    controller.abort();
    expect(isMarkAllMailReadRunning("account")).toBe(true);
    finish(page([]));
    await pending;
    expect(isMarkAllMailReadRunning("account")).toBe(false);
  });
  it("stops during collection without changing any mail", async () => {
    const controller = new AbortController();
    vi.spyOn(api, "listEmails").mockImplementation(async () => {
      controller.abort();
      return page(["a"], "next");
    });
    const update = vi.spyOn(api, "updateEmail");
    expect(await markAllMailRead("account", { folder: "INBOX" }, vi.fn(), controller.signal))
      .toEqual({ marked: 0, failed: 0, stopped: true });
    expect(update).not.toHaveBeenCalled();
  });

  it("settles the submitted batch and leaves later messages untouched", async () => {
    const controller = new AbortController();
    vi.spyOn(api, "listEmails").mockResolvedValue(page(["a", "b", "c", "d", "e", "f"]));
    const update = vi.spyOn(api, "updateEmail").mockImplementation(async (_account, id) => {
      if (id === "a") controller.abort();
      if (id === "b") throw new Error("failed");
      return { ok: true };
    });
    expect(await markAllMailRead("account", { folder: "INBOX" }, vi.fn(), controller.signal))
      .toEqual({ marked: 3, failed: 1, stopped: true, remaining: 2 });
    expect(update).toHaveBeenCalledTimes(4);
    expect(update).not.toHaveBeenCalledWith("account", "e", expect.anything());
  });
  it("collects every page before mutating and preserves the requested scope", async () => {
    const list = vi.spyOn(api, "listEmails").mockResolvedValueOnce(page(["first"], "next")).mockResolvedValueOnce(page(["second"]));
    const update = vi.spyOn(api, "updateEmail").mockImplementation(async () => {
      expect(list).toHaveBeenCalledTimes(2);
      return { ok: true };
    });
    const progress = vi.fn();
    expect(await markAllMailRead("account", { folder: "INBOX", category: "invoice" }, progress)).toEqual({ marked: 2, failed: 0 });
    expect(list).toHaveBeenLastCalledWith("account", { folder: "INBOX", category: "invoice", unread: "1", limit: "500", cursor: "next" });
    expect(update).toHaveBeenCalledWith("account", "second", { read: true });
    expect(progress).toHaveBeenLastCalledWith(2, 2);
  });

  it("reports individual failures while finishing other messages", async () => {
    vi.spyOn(api, "listEmails").mockResolvedValue(page(["a", "b", "c"]));
    vi.spyOn(api, "updateEmail").mockResolvedValueOnce({ ok: true }).mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({ ok: true });
    expect(await markAllMailRead("account", { folder: "INBOX" }, vi.fn())).toEqual({ marked: 2, failed: 1 });
  });

  it("does not mutate a truncated result with no usable next cursor", async () => {
    vi.spyOn(api, "listEmails").mockResolvedValue({ ...page(["a"]), hasMore: true });
    const update = vi.spyOn(api, "updateEmail");
    await expect(markAllMailRead("account", { folder: "INBOX" }, vi.fn())).rejects.toThrow("pagination-incomplete");
    expect(update).not.toHaveBeenCalled();
  });
});
