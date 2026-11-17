// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Smart-tag + summarization pipeline E2E (canonical runtime):
// file-injected inbox → receipt → intelligence retry lanes (summary/tags)
// → AI tags land on the smart-tags API.
import { expect, test } from "@playwright/test";
import {
  bundledLlmResponder,
  launchElectron,
  loginWithFixture,
  waitFor,
} from "./helpers/electronApp";

test("smart pipeline: receipt → AI tags + summary attributes", async () => {
  test.setTimeout(120_000);
  const app = await launchElectron({
    rendererUrl: "http://127.0.0.1:14175/",
    inboxFixtures: ["mail-001-question.json", "mail-002-notification.json"],
    llmResponder: bundledLlmResponder(),
  });
  try {
    const window = await app.electronApp.firstWindow();
    await loginWithFixture(app.apiBaseUrl);
    await expect(window.getByTestId("workbench")).toBeVisible();

    // Canonical receipt: wait for the account runtime, then refresh.
    await expect.poll(() =>
      window.evaluate(async () =>
        (await window.wemailDesktop?.mailCore?.health())?.accountRuntime?.accountId ?? null,
      ),
    ).toBe("acct-e2e");
    const refresh = await window.evaluate(() =>
      window.wemailDesktop?.mailCore?.refreshMail("acct-e2e"),
    );
    expect(refresh?.status).toBe("queued");
    await expect(window.getByTestId("mail-item").first()).toBeVisible({
      timeout: 20_000,
    });

    // Drive the summary + tags lanes deterministically through the retry API.
    const retry = await fetch(`${app.apiBaseUrl}/api/digests/summary-retry`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "all", kinds: ["summary", "tags"] }),
    });
    expect(retry.ok).toBeTruthy();
    const retryBody = (await retry.json()) as { ok?: boolean };
    expect(retryBody.ok).toBe(true);

    // The mock tag lane returns 待回复/通知; the tags attribute must reach
    // succeeded state (LLM called, output parsed, persisted).
    const tagApplied = await waitFor(async () => {
      const res = await fetch(`${app.apiBaseUrl}/api/digests/summary-health`);
      const body = (await res.json()) as {
        ok?: boolean;
        status?: {
          items?: Array<{
            attributes?: Array<{ kind?: string; state?: string }>;
          }>;
        };
      };
      if (!body.ok || !body.status?.items) return null;
      const tagStates = body.status.items.flatMap(
        (item) => item.attributes ?? [],
      ).filter((attribute) => attribute.kind === "tags");
      return tagStates.some((attribute) => attribute.state === "succeeded")
        ? tagStates
        : null;
    }, { label: "smart tag attribute succeeded", timeoutMs: 45_000, intervalMs: 500 });
    expect(tagApplied.length).toBeGreaterThan(0);

    // The user-tag registry endpoint stays contract-shaped (builtin tag
    // applications surface per-email, promotions create entries here).
    const tagList = await fetch(`${app.apiBaseUrl}/api/smart-tags`);
    expect(tagList.ok).toBeTruthy();

    // Summary health endpoint reports readable per-attribute state.
    const health = await fetch(
      `${app.apiBaseUrl}/api/digests/summary-health`,
    );
    expect(health.ok).toBeTruthy();
    const healthBody = (await health.json()) as {
      ok?: boolean;
      status?: Record<string, unknown>;
    };
    expect(healthBody.ok).toBe(true);
    expect(healthBody.status).toBeTruthy();

    // Todos endpoint answers (todoExtraction lane may stay empty with the
    // canned fixtures — the contract check is that the route works).
    const todos = await fetch(`${app.apiBaseUrl}/api/todos`);
    expect(todos.ok).toBeTruthy();
  } finally {
    await app.close();
  }
});
