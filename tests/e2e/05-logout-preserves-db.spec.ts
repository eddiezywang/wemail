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

test("logout preserves mail DB across app re-open", async () => {
  const first = await launchElectron({
    rendererUrl: "http://127.0.0.1:14175",
    inboxFixtures: ["mail-001-question.json"],
    llmResponder: bundledLlmResponder(),
  });
  const dataDir = first.dataDir;
  try {
    await loginWithFixture(first.apiBaseUrl);
    const window = await first.electronApp.firstWindow();
    await window.waitForLoadState("domcontentloaded");

    // The preload bridge may still be connecting on a cold CI runner; wait
    // for Mail Core before the first refresh instead of assuming it is ready
    // at domcontentloaded.
    const refresh = await waitFor(
      async () => {
        const result = await window.evaluate(async () => {
          const mailCore = window.wemailDesktop?.mailCore;
          if (!mailCore?.isConnected()) return null;
          return await mailCore.refreshMail("acct-e2e");
        });
        return result && result.status === "queued" ? result : null;
      },
      { label: "mail-core-refresh", timeoutMs: 30_000 },
    );
    expect(refresh.status).toBe("queued");

    const listed = await waitFor(async () => {
      const data = await window.evaluate(async () => {
        const database = window.wemailDesktop?.mailDatabase;
        if (!database?.isConnected()) return null;
        return await database.listMail({ accountId: "acct-e2e", folder: "INBOX" });
      });
      return data && data.messages.length > 0 ? data : null;
    }, { label: "message-listed", timeoutMs: 20_000 });
    expect(listed.messages.length).toBe(1);

    const out = await fetch(`${first.apiBaseUrl}/api/account/logout`, {
      method: "POST",
    });
    expect(out.ok).toBeTruthy();
  } finally {
    await first.close();
  }

  // Re-open with the same data directory — SQLite rows survive the logout
  // (logout clears session secrets only, never the canonical store).
  const second = await launchElectron({
    reuseDataDir: dataDir,
    rendererUrl: "http://127.0.0.1:14175",
  });
  try {
    const reopened = await second.electronApp.firstWindow();
    const after = await waitFor(async () => {
      const data = await reopened.evaluate(async () => {
        const database = window.wemailDesktop?.mailDatabase;
        if (!database?.isConnected()) return null;
        return await database.listMail({ accountId: "acct-e2e", folder: "INBOX" });
      });
      return data && data.messages.length > 0 ? data : null;
    }, { label: "cache-preserved", timeoutMs: 20_000 });
    expect(after.messages[0].id).toBeDefined();
    expect(after.messages[0].subject).toContain("launch");
  } finally {
    await second.close();
  }
});
