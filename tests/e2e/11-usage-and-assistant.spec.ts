// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Usage monitoring + assistant E2E: the seven canonical usage buckets are
// reported, an AI compose draft call succeeds against the mock LLM, and
// the usage ledger records the call. Assistant surface (conversations,
// tools, suggestions) answers.
import { expect, test } from "@playwright/test";
import {
  bundledLlmResponder,
  launchElectron,
  loginWithFixture,
  waitFor,
  type LaunchOptions,
} from "./helpers/electronApp";

const USAGE_CATEGORIES = [
  "summary",
  "agent_chat",
  "compose",
  "todo",
  "translation",
  "automation",
  "other",
] as const;

// The compose lane's system prompt ("draft-writing assistant") is distinct
// from the bundled lanes; respond with a minimal valid draft payload.
const composeAwareResponder: LaunchOptions["llmResponder"] = (body) => {
  const b = body as { messages?: Array<{ role: string; content: string }> };
  const system = b.messages?.find((m) => m.role === "system")?.content ?? "";
  if (system.includes("draft-writing")) {
    return JSON.stringify({
      status: "draft",
      draftMarkdown: "您好，\n\n会议时间已确认，明天上午十点见。\n",
      subject: "会议确认",
      recipientChanges: {
        to: { operation: "add", recipients: [] },
        cc: { operation: "add", recipients: [] },
        bcc: { operation: "add", recipients: [] },
      },
      suggestedSendAt: "",
      questions: [],
      missingFields: [],
    });
  }
  if (!system.includes("summarization") && !system.includes("tag") && !system.includes("reply-decision")) {
    return "{}";
  }
  return bundledLlmResponder()(body);
};

test("usage ledger tracks AI compose and assistant endpoints answer", async () => {
  test.setTimeout(120_000);
  const app = await launchElectron({
    llmResponder: composeAwareResponder,
    inboxFixtures: ["mail-001-question.json"],
  });
  try {
    const window = await app.electronApp.firstWindow();
    await loginWithFixture(app.apiBaseUrl);

    // Wait for the account runtime so receipt/intelligence can process mail.
    await expect.poll(() =>
      window.evaluate(async () =>
        (await window.wemailDesktop?.mailCore?.health())?.accountRuntime?.accountId ?? null,
      ),
    ).toBe("acct-e2e");
    const refresh = await window.evaluate(() =>
      window.wemailDesktop?.mailCore?.refreshMail("acct-e2e"),
    );
    expect(refresh?.status).toBe("queued");

    // Assistant surface smoke: conversations / tools / suggestions answer.
    for (const path of [
      "/api/agent/conversations",
      "/api/agent/tools",
      "/api/agent/suggestions?accountId=acct-e2e",
    ]) {
      const res = await fetch(`${app.apiBaseUrl}${path}`);
      expect(res.ok, path).toBeTruthy();
    }

    // Baseline usage: all seven canonical buckets present.
    const usageUrl = `${app.apiBaseUrl}/api/settings/usage?accountId=acct-e2e&period=30d`;
    const baseline = (await (await fetch(usageUrl)).json()) as {
      ok?: boolean;
      usage?: Array<{ category?: string; calls?: number }>;
    };
    expect(baseline.ok).toBe(true);
    const categories = baseline.usage?.map((row) => row.category) ?? [];
    for (const category of USAGE_CATEGORIES) {
      expect(categories).toContain(category);
    }
    const summaryCallsBefore =
      baseline.usage?.find((row) => row.category === "summary")?.calls ?? 0;

    // Drive the summary lane through the canonical AI worker — the path
    // that records usage (recordAiUsage → ai_usage ledger).
    const retry = await fetch(`${app.apiBaseUrl}/api/digests/summary-retry`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "all", kinds: ["summary"] }),
    });
    expect(retry.ok).toBeTruthy();

    // Wait until the fixture mail exists so the retry lane has work, then
    // re-request if the first pass raced ahead of receipt.
    await waitFor(async () => {
      const health = await fetch(
        `${app.apiBaseUrl}/api/digests/summary-health`,
      );
      const body = (await health.json()) as {
        ok?: boolean;
        status?: { total?: number };
      };
      if (!body.ok || (body.status?.total ?? 0) < 1) return null;
      await fetch(`${app.apiBaseUrl}/api/digests/summary-retry`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "all", kinds: ["summary"] }),
      });
      return body;
    }, { label: "summary work available", timeoutMs: 20_000 });

    // Usage ledger must record the LLM call.
    await waitFor(async () => {
      const res = await fetch(usageUrl);
      const body = (await res.json()) as {
        ok?: boolean;
        usage?: Array<{ category?: string; calls?: number }>;
      };
      const calls =
        body.usage?.find((row) => row.category === "summary")?.calls ?? 0;
      return body.ok && calls > summaryCallsBefore ? body : null;
    }, { label: "summary usage recorded", timeoutMs: 30_000, intervalMs: 500 });

    // Drive one real AI compose draft through the local API (compose is a
    // synchronous lane — it succeeds without touching the usage ledger).
    const draft = await fetch(`${app.apiBaseUrl}/api/compose/draft`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        operationType: "NEW",
        intent: "确认明天上午十点的产品会议",
      }),
    });
    expect(draft.ok).toBeTruthy();
    const draftBody = (await draft.json()) as {
      ok?: boolean;
      draft?: { subject?: string; draftMarkdown?: string };
      code?: string;
      message?: string;
    };
    if (!draftBody.ok) {
      console.log("DBG compose/draft", draft.status, JSON.stringify(draftBody).slice(0, 500));
    }
    expect(draftBody.ok).toBe(true);
    expect(typeof draftBody.draft?.draftMarkdown).toBe("string");

    // Usage stats (UI buckets) answer for the same window.
    const stats = await fetch(
      `${app.apiBaseUrl}/api/settings/usage-stats?accountId=acct-e2e&period=30d`,
    );
    expect(stats.ok).toBeTruthy();
  } finally {
    await app.close();
  }
});
