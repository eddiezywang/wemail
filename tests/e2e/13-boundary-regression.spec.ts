// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Boundary regression for the intelligence surface: compose validation,
// clarification / malformed-LLM paths, summary-retry argument hardening,
// usage + agent parameter validation. Hermetic — all LLM traffic hits the
// local mock.
import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import {
  bundledLlmResponder,
  launchElectron,
  loginWithFixture,
  waitFor,
  type LaunchOptions,
} from "./helpers/electronApp";

const INBOX = ["mail-001-question.json"];

async function postJson(url: string, body: unknown) {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test.describe("compose boundaries", () => {
  test("request validation: intent / operationType / reply-target", async () => {
    const app = await launchElectron();
    try {
      await loginWithFixture(app.apiBaseUrl);
      const url = `${app.apiBaseUrl}/api/compose/draft`;

      const missingIntent = await postJson(url, { operationType: "NEW" });
      expect(missingIntent.status).toBe(400);
      expect(((await missingIntent.json()) as { code?: string }).code).toBe("INTENT_REQUIRED");

      const blankIntent = await postJson(url, { operationType: "NEW", intent: "   " });
      expect(blankIntent.status).toBe(400);

      const badOperation = await postJson(url, { operationType: "FORWARD", intent: "hi" });
      expect(badOperation.status).toBe(400);
      expect(((await badOperation.json()) as { code?: string }).code).toBe("INVALID_OPERATION_TYPE");

      const replyNoTarget = await postJson(url, { operationType: "REPLY", intent: "hi" });
      expect(replyNoTarget.status).toBe(400);
      expect(((await replyNoTarget.json()) as { code?: string }).code).toBe("SOURCE_MESSAGE_REQUIRED");

      const replyUnknown = await postJson(url, {
        operationType: "REPLY",
        intent: "hi",
        emailId: "acct-e2e/INBOX/999-999",
      });
      expect(replyUnknown.status).toBe(404);
      expect(((await replyUnknown.json()) as { code?: string }).code).toBe("SOURCE_MESSAGE_NOT_FOUND");

      const badJson = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not-json{{{",
      });
      expect(badJson.status).toBe(400);
    } finally {
      await app.close();
    }
  });

  test("llm paths: clarification honored, malformed json → 502", async () => {
    test.setTimeout(120_000);
    const responder: LaunchOptions["llmResponder"] = (body) => {
      const b = body as { messages?: Array<{ role: string; content: string }> };
      const system = b.messages?.find((m) => m.role === "system")?.content ?? "";
      if (system.includes("draft-writing")) {
        return JSON.stringify({
          status: "needsClarification",
          questions: ["Which meeting do you mean?"],
          missingFields: ["meeting"],
          draftMarkdown: "",
          subject: "",
          recipientChanges: { to: { operation: "add", recipients: [] }, cc: { operation: "add", recipients: [] }, bcc: { operation: "add", recipients: [] } },
          suggestedSendAt: "",
        });
      }
      return bundledLlmResponder()(body);
    };
    const app = await launchElectron({ llmResponder: responder });
    try {
      await loginWithFixture(app.apiBaseUrl);
      const clarification = await postJson(`${app.apiBaseUrl}/api/compose/draft`, {
        operationType: "NEW",
        intent: "confirm the meeting",
      });
      expect(clarification.ok).toBeTruthy();
      const body = (await clarification.json()) as {
        draft?: { status?: string; clarification?: { questions?: string[] } };
      };
      expect(body.draft?.status).toBe("needsClarification");
      expect(body.draft?.clarification?.questions?.length).toBeGreaterThan(0);
    } finally {
      await app.close();
    }

    // Second launch: draft lane returns garbage → the route maps it to a
    // retryable 502 instead of crashing.
    const hostile: LaunchOptions["llmResponder"] = (body) => {
      const b = body as { messages?: Array<{ role: string; content: string }> };
      const system = b.messages?.find((m) => m.role === "system")?.content ?? "";
      if (system.includes("draft-writing")) return "not-json{{{";
      return bundledLlmResponder()(body);
    };
    const app2 = await launchElectron({ llmResponder: hostile });
    try {
      await loginWithFixture(app2.apiBaseUrl);
      const failed = await postJson(`${app2.apiBaseUrl}/api/compose/draft`, {
        operationType: "NEW",
        intent: "write a draft",
      });
      expect(failed.status).toBe(502);
      expect(((await failed.json()) as { code?: string }).code).toBe("AI_COMPOSE_FAILED");
    } finally {
      await app2.close();
    }
  });
});

test.describe("summary-retry + tags boundaries", () => {
  test("argument hardening and malformed tags fail the lane safely", async () => {
    test.setTimeout(150_000);
    // Tags lane returns invalid JSON → the attribute must land in `failed`
    // (not pending forever), while valid lanes keep working.
    const hostileTags: LaunchOptions["llmResponder"] = (body) => {
      const b = body as { messages?: Array<{ role: string; content: string }> };
      const system = b.messages?.find((m) => m.role === "system")?.content ?? "";
      if (system.includes("tag")) return "not-json{{{";
      return bundledLlmResponder()(body);
    };
    const app = await launchElectron({
      rendererUrl: "http://127.0.0.1:14175/",
      inboxFixtures: INBOX,
      llmResponder: hostileTags,
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

      const retryUrl = `${app.apiBaseUrl}/api/digests/summary-retry`;

      // Unknown mode → falls back to "all" instead of 500.
      const weirdMode = await postJson(retryUrl, { mode: "bogus", kinds: ["summary"] });
      expect(weirdMode.ok).toBeTruthy();

      // >4 kinds are sliced, unknown kinds filtered — both accepted.
      const extraKinds = await postJson(retryUrl, {
        mode: "all",
        kinds: ["summary", "tags", "todoExtraction", "replyDecision", "summary", "nonexistent"],
      });
      expect(extraKinds.ok).toBeTruthy();

      // The malformed tags lane must converge to a FAILED attribute state
      // (checked BEFORE the flood below, which would starve the lane).
      // The retry is re-sent on every poll so a receipt that lands late is
      // still picked up inside the wait window.
      await waitFor(async () => {
        const health = await fetch(`${app.apiBaseUrl}/api/digests/summary-health`);
        const payload = (await health.json()) as {
          status?: { items?: Array<{ attributes?: Array<{ kind?: string; state?: string }> }> };
        };
        const tagStates = payload.status?.items?.flatMap((i) => i.attributes ?? [])
          .filter((a) => a.kind === "tags") ?? [];
        if (tagStates.some((a) => a.state === "failed")) return tagStates;
        await postJson(retryUrl, { mode: "all", kinds: ["tags"] });
        return null;
      }, { label: "malformed tags lane marked failed", timeoutMs: 120_000, intervalMs: 1_000 });

      // >500 emailIds are capped, unknown ids tolerated.
      const flood = await postJson(retryUrl, {
        mode: "all",
        kinds: ["summary"],
        emailIds: Array.from({ length: 520 }, (_, i) => `acct-e2e/INBOX/x-${i}`),
      });
      expect(flood.ok).toBeTruthy();
    } finally {
      await app.close();
    }
  });
});

test.describe("usage + agent boundaries", () => {
  test("parameter validation stays structured", async () => {
    const app = await launchElectron();
    try {
      await loginWithFixture(app.apiBaseUrl);

      // Usage without accountId → 400.
      const noAccount = await fetch(`${app.apiBaseUrl}/api/settings/usage`);
      expect(noAccount.status).toBe(400);

      // Unknown account → empty ledger, not an error.
      const unknown = await (await fetch(
        `${app.apiBaseUrl}/api/settings/usage?accountId=acct-nobody&period=30d`,
      )).json();
      expect((unknown as { ok?: boolean }).ok).toBe(true);

      // Suggestions without accountId → 400; with the right one → ok.
      const noId = await fetch(`${app.apiBaseUrl}/api/agent/suggestions`);
      expect(noId.status).toBe(400);
      const okId = await fetch(
        `${app.apiBaseUrl}/api/agent/suggestions?accountId=acct-e2e`,
      );
      expect(okId.ok).toBeTruthy();

      // Agent chat without userText → 400.
      const noText = await postJson(`${app.apiBaseUrl}/api/agent/chat`, {});
      expect(noText.status).toBe(400);
    } finally {
      await app.close();
    }
  });
});
