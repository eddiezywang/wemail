// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Read-API boundary regression: parameter validation produces structured
// 400/404s (never 500), unknown ids resolve to 404s, and list endpoints
// answer with their contracted shapes while logged in.
import { expect, test } from "@playwright/test";
import { launchElectron, loginWithFixture } from "./helpers/electronApp";

test("read api boundaries: validation, unknown ids, clamped pagination", async () => {
  test.setTimeout(120_000);
  process.env.WEMAIL_CHANNELS_ENABLED = "1";
  const app = await launchElectron();
  try {
    await loginWithFixture(app.apiBaseUrl);
    const B = app.apiBaseUrl;
    const get = (p: string) => fetch(`${B}${p}`);

    // ── semantic search ────────────────────────────────────────────
    const searchNoAccount = await get("/api/mail/semantic-search?query=hi");
    expect(searchNoAccount.status).toBe(400);
    const searchNoQuery = await get("/api/mail/semantic-search?accountId=acct-e2e");
    expect(searchNoQuery.status).toBe(400);
    const searchBadLimit = await get(
      "/api/mail/semantic-search?accountId=acct-e2e&query=hi&limit=-3",
    );
    expect(searchBadLimit.status).toBe(400);
    const searchBadOffset = await get(
      "/api/mail/semantic-search?accountId=acct-e2e&query=hi&offset=-1",
    );
    expect(searchBadOffset.status).toBe(400);
    const searchOk = await get(
      "/api/mail/semantic-search?accountId=acct-e2e&query=launch",
    );
    expect(searchOk.status).toBe(200);
    expect(((await searchOk.json()) as { result?: unknown }).result).toBeDefined();

    // ── summary-health pagination clamps ──────────────────────────
    const healthLimit0 = await get("/api/digests/summary-health?limit=0");
    expect(healthLimit0.ok).toBeTruthy();
    const healthOffsetNeg = await get("/api/digests/summary-health?offset=-5");
    expect(healthOffsetNeg.ok).toBeTruthy();
    const healthBadState = await get("/api/digests/summary-health?state=bogus,state2");
    expect(healthBadState.ok).toBeTruthy();

    // ── todos: unknown id mutations are 404, not 500 ──────────────
    for (const action of ["complete", "restore", "confirm", "reject"]) {
      const res = await fetch(`${B}/api/todos/todo-unknown/${action}`, { method: "POST" });
      expect(res.status, action).toBeGreaterThanOrEqual(400);
      expect(res.status, action).toBeLessThan(500);
    }

    // ── smart tags: promotions + unknown tag id ───────────────────
    const promoNoBody = await fetch(`${B}/api/smart-tags/promotions/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not-json{{{",
    });
    expect(promoNoBody.status).toBe(400);
    const promoUnknown = await fetch(`${B}/api/smart-tags/promotions/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ emailId: "acct-e2e/INBOX/x-1", candidateName: "随便" }),
    });
    expect(promoUnknown.status).toBeGreaterThanOrEqual(400);
    expect(promoUnknown.status).toBeLessThan(500);
    const restoreUnknown = await fetch(`${B}/api/smart-tags/tag-unknown/restore-original`, {
      method: "POST",
    });
    expect(restoreUnknown.status).toBe(404);
    const backfills = await get("/api/smart-tags/backfills");
    expect(backfills.ok).toBeTruthy();

    // ── channels: unknown ids are structured 4xx ──────────────────
    const setupUnknown = await get("/api/channels/platform-configurations/setup/does-not-exist");
    expect(setupUnknown.status).toBeGreaterThanOrEqual(400);
    expect(setupUnknown.status).toBeLessThan(500);
    const bindingsUnknown = await get("/api/channels/profiles/profile-unknown/bindings");
    // Unknown profile reads resolve leniently to an empty 200 payload.
    expect(bindingsUnknown.status).toBe(200);

    // ── application messages / action center / workspace smoke ────
    const appMessagesNoAccount = await get("/api/application-messages");
    expect(appMessagesNoAccount.status).toBe(400);
    const appMessages = await get("/api/application-messages?accountId=acct-e2e");
    expect(appMessages.ok).toBeTruthy();
    const appMessageUnknown = await get(
      "/api/application-messages/msg-unknown?accountId=acct-e2e",
    );
    expect(appMessageUnknown.status).toBe(404);
    const actionCenter = await get("/api/action-center/");
    expect(actionCenter.status).toBeGreaterThanOrEqual(200);
    expect(actionCenter.status).toBeLessThan(500);
    const workspaceFiles = await get("/api/workspace/files");
    expect(workspaceFiles.status).toBeGreaterThanOrEqual(200);
    expect(workspaceFiles.status).toBeLessThan(500);

    // ── unknown top-level route → structured 404 envelope ─────────
    const unknownRoute = await get("/api/definitely-not-a-route");
    expect(unknownRoute.status).toBe(404);
  } finally {
    await app.close();
  }
});
