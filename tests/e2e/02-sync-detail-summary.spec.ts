// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { test, expect } from "@playwright/test";
import {
  bundledLlmResponder,
  launchElectron,
  loginWithFixture,
  waitFor,
} from "./helpers/electronApp";

test("sync → list → detail → summary health succeeds", async () => {
  const app = await launchElectron({
    rendererUrl: "http://127.0.0.1:14175",
    inboxFixtures: ["mail-001-question.json"],
    llmResponder: bundledLlmResponder(),
  });
  try {
    await loginWithFixture(app.apiBaseUrl);
    const window = await app.electronApp.firstWindow();
    await window.waitForLoadState("domcontentloaded");

    // Sync is a Mail Core operation; the desktop exposes it through the
    // preload bridge (the POST /api/mail/sync route was removed with the
    // two-repo split, along with the /api/mail/messages read surface).
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
    expect(listed.messages[0].subject).toContain("launch");
    const emailId = listed.messages[0].id;

    // Detail is queryable through the canonical DB bridge.
    const detail = await window.evaluate(async (id) => {
      const database = window.wemailDesktop!.mailDatabase!;
      return await database.getMailSnapshot(id);
    }, emailId);
    expect(detail.message?.id).toBe(emailId);

    // The summary lane is drained by the desktop AI worker pool against the
    // local LLM mock; /api/digests/summary-health reports the canonical state.
    const health = await waitFor(async () => {
      const res = await fetch(
        `${app.apiBaseUrl}/api/digests/summary-health`,
      );
      const payload = (await res.json()) as {
        status?: { succeeded?: number; items?: Array<{ emailId: string; state: string }> };
      };
      return payload.status?.items?.some(
        (item) => item.emailId === emailId && item.state === "succeeded",
      ) ? payload.status : null;
    }, { label: "summary-populated", timeoutMs: 30_000 });

    expect(health.succeeded).toBeGreaterThan(0);
  } finally {
    await app.close();
  }
});
