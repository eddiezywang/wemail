import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveMailNotificationEvent } from "../../shared/wemail/notifications.js";
import {
  LiveMailAggregator,
  type AggregatedLiveMail,
} from "./live-mail-aggregator.js";

function mail(
  accountId: string,
  messageId: string,
  sender = "Alice",
  subject = "Subject",
): LiveMailNotificationEvent {
  return {
    kind: "liveMail",
    accountId,
    messageId,
    sender,
    subject,
    origin: "live-idle",
    target: { kind: "mail", accountId, messageId },
  };
}

describe("LiveMailAggregator", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("flushes one message immediately by default", () => {
    const batches: AggregatedLiveMail[] = [];
    const aggregator = new LiveMailAggregator({
      onFlush: (batch) => batches.push(batch),
    });

    aggregator.push(mail("acct-1", "mail-1"));
    expect(batches).toEqual([
      {
        accountId: "acct-1",
        groupKey: "new-mail:acct-1",
        messages: [mail("acct-1", "mail-1")],
      },
    ]);
  });

  it("coalesces a burst in insertion order without extending the window", () => {
    const batches: AggregatedLiveMail[] = [];
    const aggregator = new LiveMailAggregator({
      onFlush: (batch) => batches.push(batch),
      windowMs: 2_000,
    });

    aggregator.push(mail("acct-1", "mail-1", "Alice", "One"));
    vi.advanceTimersByTime(1_000);
    aggregator.push(mail("acct-1", "mail-2", "Bob", "Two"));
    vi.advanceTimersByTime(1_000);

    expect(batches).toHaveLength(1);
    expect(batches[0]?.messages.map((item) => item.messageId)).toEqual([
      "mail-1",
      "mail-2",
    ]);
  });

  it("keeps accounts separate and cancels pending work on dispose", () => {
    const batches: AggregatedLiveMail[] = [];
    const aggregator = new LiveMailAggregator({
      onFlush: (batch) => batches.push(batch),
      windowMs: 2_000,
    });

    aggregator.push(mail("acct-1", "mail-1"));
    aggregator.push(mail("acct-2", "mail-2"));
    aggregator.dispose();

    expect(batches).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
