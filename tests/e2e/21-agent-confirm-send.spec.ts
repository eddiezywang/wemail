// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Agent confirm→execute chain regression: the agent (driven by the mock
// LLM emitting a propose_send_mail tool call) proposes a high-risk send,
// the user confirms it through /pending-actions/:id/resolve, and the
// canonical outbox delivers it to the mock SMTP provider. This is the
// security-critical authorized-send path.
import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { bundledLlmResponder, launchElectron, loginWithFixture, waitFor } from "./helpers/electronApp";
import type { LaunchOptions } from "./helpers/electronApp";

const SUBJECT = "Agent Regression Send";
const RECIPIENT = "alice@example.test";

// The agent lane is detected by the tool name appearing in the request's
// tool definitions; intelligence lanes keep their bundled canned answers.
const agentToolResponder: LaunchOptions["llmResponder"] = (body) => {
  const tools = (body as { tools?: Array<{ function?: { name?: string } }> }).tools ?? [];
  if (tools.some((t) => t.function?.name === "propose_send_mail")) {
    // Streaming tool-call signal (harness converts to SSE deltas).
    return "TOOL_CALL:" + JSON.stringify([{
      id: "call_regression_1",
      function: {
        name: "propose_send_mail",
        arguments: JSON.stringify({
          accountId: "acct-e2e",
          to: [RECIPIENT],
          subject: SUBJECT,
          bodyText: "Agent 确认链回归正文",
          bodyHtml: "<p>Agent 确认链回归正文</p>",
        }),
      },
    }]);
  }
  return bundledLlmResponder()(body);
};

/** Status: test.skip — the harness mock now supports streaming (SSE) and the
 *  agent runtime receives + executes the propose_send_mail tool call
 *  (tool_call_started → confirmation_requested are observable), but the
 *  runtime accumulates EMPTY tool arguments under the mock's SSE deltas, so
 *  the confirm→execute resolve rejects with missing-accountId. Remaining
 *  work: match OpenAI's exact multi-delta tool-call argument accumulation
 *  semantics in the harness mock (or extend the runtime's parser). The
 *  full chain (propose → pending → resolve → outbox) is otherwise wired
 *  and asserted below. */
test.skip("agent propose_send_mail → confirm → mock SMTP outbox", async () => {
  test.setTimeout(240_000);
  const app = await launchElectron({
    rendererUrl: "http://127.0.0.1:14175/",
    inboxFixtures: ["mail-001-question.json"],
    llmResponder: agentToolResponder,
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

    // 1. Agent chat: the mock LLM proposes the send tool call.
    const chat = await fetch(`${app.apiBaseUrl}/api/agent/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        userText: `请发送一封主题为「${SUBJECT}」的邮件给 ${RECIPIENT}`,
        accountId: "acct-e2e",
      }),
    });
    expect(chat.ok).toBeTruthy();
    const chatBody = (await chat.json()) as { events?: Array<Record<string, unknown>>; conversationId?: string };
    for (const ev of chatBody.events ?? []) {
      const t = String(ev.type ?? "");
      if (t !== "run_started" && t !== "heartbeat") {
        console.log("EVT:", t, "|", JSON.stringify(ev).slice(0, 200));
      }
    }

    // 2. The confirmation_requested event carries the pending action id.
    const confirmation = (chatBody.events ?? []).find(
      (ev) => String(ev.type ?? "") === "confirmation_requested",
    ) as { confirmation?: { id?: string; actionType?: string } } | undefined;
    expect(confirmation?.confirmation?.id).toBeTruthy();
    const actionId = confirmation!.confirmation!.id!;

    // 3. Read back the pending action (parameters + idempotency key).
    const action = await waitFor(async () => {
      const res = await fetch(
        `${app.apiBaseUrl}/api/agent/pending-actions?accountId=acct-e2e`,
      );
      const body = (await res.json()) as {
        actions?: Array<{
          id?: string;
          parameters?: Record<string, unknown>;
          idempotencyKey?: string;
        }>;
      };
      const hit = (body.actions ?? []).find((a) => a.id === actionId && a.parameters && a.idempotencyKey);
      return hit ?? null;
    }, { label: "pending action readable", timeoutMs: 30_000, intervalMs: 1_000 });

    // 3. Confirm exactly what was displayed (parameters echo + stored
    //    idempotency key) through the resolve endpoint.
    const resolved = await fetch(
      `${app.apiBaseUrl}/api/agent/pending-actions/${actionId}/resolve`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          status: "confirmed",
          idempotencyKey: action.idempotencyKey,
          parameters: action.parameters,
        }),
      },
    );
    expect(resolved.ok).toBeTruthy();

    // 4. The canonical outbox delivers to the mock SMTP provider.
    const outboxDir = path.join(app.dataDir, "mock-outbox");
    const sentFile = await waitFor(async () => {
      if (!fs.existsSync(outboxDir)) return null;
      const entry = fs.readdirSync(outboxDir).find((n) => n.startsWith("file-injected-"));
      return entry ? path.join(outboxDir, entry) : null;
    }, { label: "mock smtp outbox file", timeoutMs: 45_000 });
    const sent = JSON.parse(fs.readFileSync(sentFile, "utf8")) as {
      input: { to?: Array<{ email: string }>; subject: string };
    };
    expect(sent.input.subject).toContain(SUBJECT);
    expect(sent.input.to?.[0]?.email).toBe(RECIPIENT);

    // 5. The action records the execution result.
    const after = await (await fetch(
      `${app.apiBaseUrl}/api/agent/pending-actions?accountId=acct-e2e`,
    )).json();
    const executed = ((after as { actions?: Array<{ id?: string; executionState?: string; executionResult?: { ok?: boolean } }> })
      .actions ?? []).find((a) => a.id === actionId);
    expect(executed?.executionState).toBe("succeeded");
    expect(executed?.executionResult?.ok).toBe(true);
  } finally {
    await app.close();
  }
});
