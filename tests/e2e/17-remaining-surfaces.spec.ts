// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Remaining read surfaces smoke + boundary: skills (wecli catalog/audit),
// configuration tasks, directory, insight reports, mail attachments and
// invoice refresh for unknown ids — all must answer structurally, no 500s.
import { expect, test } from "@playwright/test";
import { launchElectron, loginWithFixture } from "./helpers/electronApp";

test("remaining surfaces: skills/configuration/directory/insight/attachments", async () => {
  test.setTimeout(120_000);
  const app = await launchElectron();
  try {
    await loginWithFixture(app.apiBaseUrl);
    const B = app.apiBaseUrl;
    const get = (p: string) => fetch(`${B}${p}`);

    // ── skills (wecli catalog + audit are static/status reads) ────
    const catalog = await get("/api/skills/wecli/catalog");
    expect(catalog.status).toBeGreaterThanOrEqual(200);
    expect(catalog.status).toBeLessThan(500);
    // Open edition pins wecli skill routes as 404 (app.wecli-absent.test.ts);
    // the audit lane answers only where the wecli module is mounted.
    if (catalog.status !== 404) {
      const audit = await get("/api/skills/wecli/audit");
      expect(audit.ok).toBeTruthy();
    }

    // ── configuration tasks ────────────────────────────────────────
    const tasks = await get("/api/configuration-tasks");
    expect(tasks.ok).toBeTruthy();
    expect(((await tasks.json()) as { tasks?: unknown[] }).tasks).toBeDefined();
    const taskUnknown = await get("/api/configuration-tasks/task-unknown");
    expect(taskUnknown.status).toBeLessThan(500);

    // ── directory ──────────────────────────────────────────────────
    const dirStatus = await get("/api/directory/status");
    expect(dirStatus.ok).toBeTruthy();
    const contacts = await get("/api/directory/contacts");
    expect(contacts.ok).toBeTruthy();

    // ── insight reports ────────────────────────────────────────────
    const byEmail = await get("/api/insight-reports/by-email?emailId=acct-e2e/INBOX/x-1");
    expect(byEmail.status).toBeLessThan(500);
    const reportUnknown = await get(
      "/api/insight-reports/report-unknown?accountId=acct-e2e",
    );
    expect(reportUnknown.status).toBe(404);

    // ── attachments + invoice refresh for unknown mail ids ─────────
    const attachmentUnknown = await get(
      "/api/mail/messages/msg-unknown/attachments/att-unknown",
    );
    expect(attachmentUnknown.status).toBeGreaterThanOrEqual(400);
    expect(attachmentUnknown.status).toBeLessThan(500);
    const invoiceUnknown = await fetch(
      `${B}/api/mail/messages/msg-unknown/invoice-status/refresh`,
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
    );
    expect(invoiceUnknown.status).toBeGreaterThanOrEqual(400);
    expect(invoiceUnknown.status).toBeLessThan(500);

    // ── remote image proxy requires a url ──────────────────────────
    const noUrl = await get("/api/mail/remote-images");
    expect(noUrl.status).toBeGreaterThanOrEqual(400);
    expect(noUrl.status).toBeLessThan(500);

    // ── agent mail-qa validation ───────────────────────────────────
    const qaNoBody = await fetch(`${B}/api/agent/mail-qa`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not-json{{{",
    });
    expect(qaNoBody.status).toBeGreaterThanOrEqual(400);
    expect(qaNoBody.status).toBeLessThan(500);
  } finally {
    await app.close();
  }
});
