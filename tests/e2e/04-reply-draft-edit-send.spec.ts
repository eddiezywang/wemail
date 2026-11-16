// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Reply send E2E (canonical runtime): the exact seam the renderer uses
// (ComposePanel → useSendDraft → window.wemailDesktop.mailDatabase
// .enqueueSend) queues a reply; the mail-core account runtime claims it
// and the file-injected SMTP provider drops it into mock-outbox.
import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import {
  bundledLlmResponder,
  launchElectron,
  loginWithFixture,
  waitFor,
} from "./helpers/electronApp";

test("reply draft enqueueSend reaches the file-injected outbox", async () => {
  const app = await launchElectron({
    rendererUrl: "http://127.0.0.1:14175/",
    inboxFixtures: ["mail-001-question.json"],
    llmResponder: bundledLlmResponder(),
  });
  try {
    const window = await app.electronApp.firstWindow();
    await loginWithFixture(app.apiBaseUrl);
    await expect(window.getByTestId("workbench")).toBeVisible();
    await expect.poll(() =>
      window.evaluate(async () =>
        (await window.wemailDesktop?.mailCore?.health())?.accountRuntime?.accountId ?? null,
      ),
    ).toBe("acct-e2e");
    const refresh = await window.evaluate(() =>
      window.wemailDesktop?.mailCore?.refreshMail("acct-e2e"),
    );
    expect(refresh?.status).toBe("queued");
    await expect(
      window.getByTestId("mail-item").filter({ hasText: "Quick question" }),
    ).toBeVisible({ timeout: 20_000 });

    // Canonical emailId (acct-e2e/INBOX/…) from the intelligence endpoint.
    const health = await waitFor(async () => {
      const res = await fetch(`${app.apiBaseUrl}/api/digests/summary-health`);
      const body = (await res.json()) as {
        status?: { items?: Array<{ emailId: string }> };
      };
      return body.status?.items?.[0]?.emailId ? body : null;
    }, { label: "canonical mail present", timeoutMs: 15_000 });
    const emailId = health.status!.items![0].emailId;

    // Send through the renderer's own seam.
    const committed = await window.evaluate(async (originalEmailId) => {
      const database = window.wemailDesktop?.mailDatabase;
      if (!database?.isConnected?.()) {
        throw new Error("canonical mail database unavailable");
      }
      return await database.enqueueSend({
        accountId: "acct-e2e",
        originalEmailId,
        to: [{ name: "Alice Example", email: "alice@example.test" }],
        subject: "Re: Quick question about the launch",
        bodyText: "Launch is confirmed for 2026-05-01.",
        bodyHtml: "<p>Launch is confirmed for 2026-05-01.</p>",
        attachments: [],
        idempotencyKey: `e2e-send:${originalEmailId}:${crypto.randomUUID()}`,
      });
    }, emailId);
    expect(committed?.value?.messageIdHeader).toBeTruthy();

    // The account runtime claims the queued send; the file-injected SMTP
    // provider writes file-injected-*.json (mutation-*.json is unrelated
    // remote-operation traffic and must not count).
    const outboxFile = await waitFor(async () => {
      const dir = path.join(app.dataDir, "mock-outbox");
      if (!fs.existsSync(dir)) return null;
      const entry = fs.readdirSync(dir).find((name) =>
        name.startsWith("file-injected-"),
      );
      return entry ? path.join(dir, entry) : null;
    }, { label: "smtp outbox file", timeoutMs: 30_000 });
    const sent = JSON.parse(fs.readFileSync(outboxFile, "utf8")) as {
      input: {
        to?: Array<{ email: string }>;
        subject: string;
        bodyText: string;
      };
    };
    expect(sent.input.subject).toBe("Re: Quick question about the launch");
    expect(sent.input.to?.[0]?.email).toBe("alice@example.test");
    expect(sent.input.bodyText).toContain("2026-05-01");
  } finally {
    await app.close();
  }
});
