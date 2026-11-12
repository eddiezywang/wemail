// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import type { MailMessage } from "../../../shared/wemail/mail.js";
import type { CanonicalMailRepository } from "./CanonicalMailRepository.js";

export interface SnoozeServiceOptions {
  repository: CanonicalMailRepository;
  now?: () => Date;
  logger?: (message: string, fields?: Record<string, unknown>) => void;
}

/**
 * Feature F1 — message snooze.
 *
 * Hides a message from the inbox until a chosen ISO timestamp. Visibility is
 * derived in the read query, so expiry needs no timer, poller, or cleanup write.
 *
 * No IMAP-side action is taken: snooze is a local DB-only flag. Body
 * cache, intelligence, tag feedback, and audit logs are untouched. If
 * the message is deleted before the wake time, the snooze entry simply
 * disappears with the canonical message row.
 */
export class SnoozeService {
  private readonly repository: CanonicalMailRepository;
  private readonly now: () => Date;
  private readonly logger:
    | ((message: string, fields?: Record<string, unknown>) => void)
    | undefined;

  constructor(options: SnoozeServiceOptions) {
    this.repository = options.repository;
    this.now = options.now ?? (() => new Date());
    this.logger = options.logger;
  }

  /**
   * Snooze `emailId` until `until`. The timestamp must be strictly in
   * the future, else this throws — callers can validate up front and
   * surface a 400 to the user.
   */
  async snooze(emailId: string, until: string): Promise<MailMessage> {
    const wakeAt = new Date(until);
    if (Number.isNaN(wakeAt.getTime())) {
      throw new Error("snooze.until must be a valid ISO timestamp");
    }
    if (wakeAt.getTime() <= this.now().getTime()) {
      throw new Error("snooze.until must be in the future");
    }
    const updated = await this.repository.setSnoozedUntil(emailId, wakeAt.toISOString());
    if (!updated) {
      throw new Error(`snooze: message ${emailId} not found`);
    }
    this.logger?.("snooze.set", { emailId, until: wakeAt.toISOString() });
    return updated;
  }

  /** Clear the snooze flag for `emailId`. No-op if it wasn't snoozed. */
  async unsnooze(emailId: string): Promise<MailMessage | null> {
    const updated = await this.repository.setSnoozedUntil(emailId, null);
    if (updated) this.logger?.("snooze.clear", { emailId });
    return updated;
  }

  listSnoozed(accountId: string): MailMessage[] {
    return this.repository.listSnoozed(accountId);
  }

}
