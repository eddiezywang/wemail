import { describe, expect, it, vi } from "vitest";
import { NewMailAttentionController } from "./new-mail-attention.js";

function event(
  origin: "live-idle" | "live-poll" | "manual",
  ids: string[],
) {
  return {
    accountId: "acct-1",
    origin,
    insertedCount: ids.length,
    inserted: ids.map((id) => ({ id, from: "Sender", subject: "Subject" })),
  };
}

describe("NewMailAttentionController", () => {
  it("counts unique realtime arrivals while the window is unattended", () => {
    const update = vi.fn();
    const controller = new NewMailAttentionController(
      () => false,
      { update },
    );

    controller.record(event("live-idle", ["m-1", "m-2"]));
    controller.record(event("live-poll", ["m-2", "m-3"]));

    expect(controller.getCount()).toBe(3);
    expect(update).toHaveBeenNthCalledWith(1, 2);
    expect(update).toHaveBeenNthCalledWith(2, 3);
  });

  it("ignores focused arrivals and manual discovery", () => {
    let focused = true;
    const update = vi.fn();
    const controller = new NewMailAttentionController(
      () => focused,
      { update },
    );

    controller.record(event("live-idle", ["m-1"]));
    focused = false;
    controller.record(event("manual", ["m-2"]));

    expect(controller.getCount()).toBe(0);
    expect(update).not.toHaveBeenCalled();
  });

  it("clears count and deduplication state when focus is acknowledged", () => {
    const update = vi.fn();
    const controller = new NewMailAttentionController(
      () => false,
      { update },
    );

    controller.record(event("live-idle", ["m-1"]));
    controller.acknowledgeFocus();
    controller.record(event("live-poll", ["m-1"]));

    expect(update.mock.calls).toEqual([[1], [0], [1]]);
    expect(controller.getCount()).toBe(1);
  });
});
