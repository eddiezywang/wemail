import type { LiveMailNotificationEvent } from "../../shared/wemail/notifications.js";

export interface AggregatedLiveMail {
  accountId: string;
  groupKey: string;
  messages: LiveMailNotificationEvent[];
}

interface PendingBatch {
  messages: LiveMailNotificationEvent[];
  timer: ReturnType<typeof setTimeout>;
}

export class LiveMailAggregator {
  private readonly pending = new Map<string, PendingBatch>();
  private readonly windowMs: number;
  private readonly onFlush: (batch: AggregatedLiveMail) => void;

  constructor(options: {
    onFlush: (batch: AggregatedLiveMail) => void;
    windowMs?: number;
  }) {
    this.onFlush = options.onFlush;
    this.windowMs = options.windowMs ?? 0;
  }

  push(event: LiveMailNotificationEvent): void {
    if (this.windowMs <= 0) {
      this.onFlush({
        accountId: event.accountId,
        groupKey: `new-mail:${event.accountId}`,
        messages: [event],
      });
      return;
    }
    const existing = this.pending.get(event.accountId);
    if (existing) {
      existing.messages.push(event);
      return;
    }

    const timer = setTimeout(() => {
      this.flush(event.accountId);
    }, this.windowMs);
    this.pending.set(event.accountId, {
      messages: [event],
      timer,
    });
  }

  flush(accountId: string): void {
    const batch = this.pending.get(accountId);
    if (!batch) return;
    clearTimeout(batch.timer);
    this.pending.delete(accountId);
    this.onFlush({
      accountId,
      groupKey: `new-mail:${accountId}`,
      messages: [...batch.messages],
    });
  }

  dispose(): void {
    for (const batch of this.pending.values()) {
      clearTimeout(batch.timer);
    }
    this.pending.clear();
  }
}
