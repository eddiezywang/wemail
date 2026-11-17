// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import fs from "node:fs";
import path from "node:path";
import type {
  MailFlagsPatch,
  MailMessage,
  MailSyncCursor,
  WemailDraftInput,
} from "../../../shared/wemail/mail.js";
import type { MailProvider, SendDraftResult } from "./MailProvider.js";

/**
 * Test-only MailProvider used by the Playwright E2E suite.
 *
 * Reads JSON `MailMessage` fixtures from `<baseDir>/mock-inbox/*.json`
 * on every `syncRecent()` call, and writes sent drafts to
 * `<baseDir>/mock-outbox/`. No sockets, no real SMTP/IMAP — the
 * Electron main process therefore stays fully hermetic under tests.
 *
 * This provider is ONLY wired in when `WEMAIL_E2E_MODE=1`; the default
 * production path still uses {@link ImapSmtpMailProvider}.
 */
export interface FileInjectedMailProviderOptions {
  baseDir: string;
}

export class FileInjectedMailProvider implements MailProvider {
  private readonly inboxDir: string;
  private readonly outboxDir: string;
  private connected = false;

  constructor(opts: FileInjectedMailProviderOptions) {
    this.inboxDir = path.join(opts.baseDir, "mock-inbox");
    this.outboxDir = path.join(opts.baseDir, "mock-outbox");
    fs.mkdirSync(this.inboxDir, { recursive: true });
    fs.mkdirSync(this.outboxDir, { recursive: true });
  }

  async connect(): Promise<void> {
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  async syncRecent(limit: number): Promise<MailMessage[]> {
    if (!this.connected) await this.connect();
    const entries = fs
      .readdirSync(this.inboxDir)
      .filter((n) => n.toLowerCase().endsWith(".json"))
      .sort();
    const out: MailMessage[] = [];
    for (const name of entries) {
      if (out.length >= limit) break;
      try {
        const raw = fs.readFileSync(path.join(this.inboxDir, name), "utf8");
        out.push(JSON.parse(raw) as MailMessage);
      } catch {
        // Corrupt fixture — skip.
      }
    }
    return out;
  }

  async syncSince(since: Date): Promise<MailMessage[]> {
    const all = await this.syncRecent(1000);
    return all.filter((m) => new Date(m.receivedAt) >= since);
  }

  async syncAfterCursor(cursor: MailSyncCursor): Promise<MailMessage[] | null> {
    const all = await this.syncRecent(1000);
    return all.filter(
      (m) =>
        m.sync.uidValidity === cursor.uidValidity && m.sync.uid > cursor.uid,
    );
  }

  async getMessage(emailId: string): Promise<MailMessage | null> {
    const all = await this.syncRecent(1000);
    return all.find((m) => m.id === emailId) ?? null;
  }

  async updateFlags(emailId: string, patch: MailFlagsPatch): Promise<void> {
    this.writeMutation({ type: "flags", emailId, patch });
  }

  async moveMessage(emailId: string, folder: string): Promise<{ folder: string }> {
    this.writeMutation({ type: "move", emailId, folder });
    return { folder };
  }

  async deleteMessage(emailId: string): Promise<void> {
    this.writeMutation({ type: "delete", emailId });
  }

  async resolveMessageLocator(
    folder: string,
    messageId: string,
  ): Promise<{ uid: number; uidValidity: number } | null> {
    const message = (await this.syncRecent(1000)).find((item) => item.messageId === messageId);
    if (!message) return null;
    return { uid: message.sync.uid, uidValidity: message.sync.uidValidity };
  }

  async sendDraft(input: WemailDraftInput): Promise<SendDraftResult> {
    const messageId = `file-injected-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    const file = path.join(this.outboxDir, `${messageId}.json`);
    fs.writeFileSync(file, JSON.stringify({ messageId, input }, null, 2));
    return { messageId };
  }

  private writeMutation(payload: Record<string, unknown>): void {
    const id = `mutation-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    fs.writeFileSync(
      path.join(this.outboxDir, `${id}.json`),
      JSON.stringify(payload, null, 2),
    );
  }
}
