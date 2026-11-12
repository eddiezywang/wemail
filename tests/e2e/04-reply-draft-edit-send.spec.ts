// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { test, expect } from "@playwright/test";
import {
  bundledLlmResponder,
  launchElectron,
  loginWithFixture,
  waitFor,
} from "./helpers/electronApp";

test("canonical send path hands an outbound mail to the file-injected provider", async () => {
  const app = await launchElectron({
    rendererUrl: "http://127.0.0.1:14175",
    inboxFixtures: ["mail-001-question.json"],
    llmResponder: bundledLlmResponder(),
  });
  try {
    await loginWithFixture(app.apiBaseUrl);
    const window = await app.electronApp.firstWindow();
    await window.waitForLoadState("domcontentloaded");

    const refresh = await window.evaluate(async () =>
      window.wemailDesktop?.mailCore?.refreshMail("acct-e2e"),
    );
    expect(refresh?.status).toBe("queued");

    const listed = await waitFor(async () => {
      const data = await window.evaluate(async () => {
        const database = window.wemailDesktop?.mailDatabase;
        if (!database?.isConnected()) return null;
        return await database.listMail({ accountId: "acct-e2e", folder: "INBOX" });
      });
      return data && data.messages.length > 0 ? data : null;
    }, { label: "message-listed", timeoutMs: 20_000 });
    const emailId = listed.messages[0].id;

    // Send is a canonical DB write (`mailDatabase.enqueueSend`); Mail Core
    // claims the outbox row and the file-injected provider drops a JSON file
    // under mock-outbox. The legacy POST /api/mail/send and
    // /api/mail/messages/:id/draft/feedback HTTP surfaces were removed with
    // the two-repo split (the draft-feedback Markdown lane no longer has a
    // writer in the open edition).
    const send = await window.evaluate(async (originalId) => {
      const database = window.wemailDesktop!.mailDatabase!;
      return await database.enqueueSend({
        accountId: "acct-e2e",
        originalEmailId: originalId,
        to: [{ name: "Alice Example", email: "alice@example.test" }],
        cc: [],
        bcc: [],
        subject: "Re: Quick question about the launch",
        bodyText: "Launch is confirmed for 2026-05-01.",
        bodyHtml: "<p>Launch is confirmed for 2026-05-01.</p>",
        attachments: [],
        idempotencyKey: `send:acct-e2e:e2e-reply-${originalId}`,
      });
    }, emailId);
    expect(send.value.outboxId).toBeTruthy();

    const outboxDir = path.join(app.dataDir, "mock-outbox");
    const files = await waitFor(async () => {
      if (!fs.existsSync(outboxDir)) return null;
      const entries = fs.readdirSync(outboxDir);
      return entries.length > 0 ? entries : null;
    }, { label: "mock-outbox-written" });
    expect(files.length).toBeGreaterThan(0);
    const receipt = JSON.parse(
      fs.readFileSync(path.join(outboxDir, files[0]), "utf8"),
    ) as {
      messageId?: string;
      input?: { subject?: string; to?: Array<{ email?: string }> };
    };
    expect(receipt.input?.subject).toContain("Quick question");
    expect(receipt.input?.to?.[0]?.email).toBe("alice@example.test");
  } finally {
    await app.close();
  }
});
