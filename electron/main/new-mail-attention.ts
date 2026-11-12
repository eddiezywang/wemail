import type { MailChangedEvent } from "./mail-events.js";

export interface NewMailAttentionProjection {
  update(count: number): void;
}

export class NewMailAttentionController {
  private count = 0;
  private readonly unseenMessageIds = new Set<string>();

  constructor(
    private readonly isWindowAttended: () => boolean,
    private readonly projection: NewMailAttentionProjection,
  ) {}

  record(event: MailChangedEvent): number {
    if (event.origin !== "live-idle" && event.origin !== "live-poll") {
      return this.count;
    }
    if (this.isWindowAttended()) return this.count;

    for (const message of event.inserted) {
      this.unseenMessageIds.add(message.id);
    }
    const next = this.unseenMessageIds.size;
    if (next !== this.count) {
      this.count = next;
      this.projection.update(this.count);
    }
    return this.count;
  }

  acknowledgeFocus(): void {
    if (this.count === 0 && this.unseenMessageIds.size === 0) return;
    this.count = 0;
    this.unseenMessageIds.clear();
    this.projection.update(0);
  }

  getCount(): number {
    return this.count;
  }

  refreshProjection(): void {
    this.projection.update(this.count);
  }
}
