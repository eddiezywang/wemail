import type { Page } from "@playwright/test";

type Scenario =
  | "queue-followup"
  | "stoppable-queue"
  | "reasoning-markdown-tool"
  | "citations-confirmation-error";

/**
 * Install a `window.fetch` mock for `/api/agent/chat` that speaks the current
 * canonical `WemailAgentEvent` delivery protocol (shared/wemail/agentProtocol.ts).
 *
 * The historical mock used the retired `AgentEvent` wire names
 * (`reasoning_delta`, `progress_update`, `text_end`, `assistant_text`, `done`).
 * The renderer now reduces canonical events (`progress_added`,
 * `text_completed`, `citation_added`, `confirmation_requested`,
 * `run_settled`/`run_failed`) and drops provider reasoning entirely, so those
 * frames render nothing.
 *
 * Every event carries the full envelope (schemaVersion / conversationId /
 * runId / messageId / sequence / timestamp); conversationId is read from the
 * POST body's `sessionId` so the reducer doesn't discard the frame.
 */
export async function installAgentStreamScenario(page: Page, scenario: Scenario) {
  await page.addInitScript((selectedScenario) => {
    window.localStorage.setItem("wemail.agent-ui-version", "v2");
    const nativeFetch = window.fetch.bind(window);
    let call = 0;
    const json = (value: unknown) =>
      new Response(JSON.stringify(value), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    window.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      // The real run creates the conversation server-side when /chat is
      // called. Our mocked stream never reaches that handler, so serve the
      // follow-up CRUD endpoints locally; otherwise the client's optimistic
      // queue is removed on a 404 and the composer never shows a queue.
      if (url.includes("/api/agent/conversations/") && url.includes("/followups")) {
        if (url.endsWith("/resume")) return json({ ok: true, resumed: 1 });
        if (init?.method === "DELETE") return json({ ok: true });
        if (init?.method === "PATCH") {
          return json({ ok: true, followup: { id: "mock-followup", text: "" } });
        }
        return json({
          ok: true,
          followup: { id: "mock-followup", text: "queued", state: "queued", position: 1 },
        });
      }
      if (!url.includes("/api/agent/chat")) return nativeFetch(input, init);

      let sessionId = "browser-e2e-session";
      try {
        const body = typeof init?.body === "string" ? JSON.parse(init.body) as { sessionId?: string } : null;
        if (body?.sessionId) sessionId = body.sessionId;
      } catch {
        // keep the fallback id
      }
      call += 1;
      const runId = `browser-e2e-run-${call}`;
      const messageId = `browser-e2e-assistant-${call}`;
      let sequence = 0;
      const event = (type: string, fields: Record<string, unknown> = {}) => ({
        schemaVersion: 1,
        conversationId: sessionId,
        runId,
        messageId,
        sequence: ++sequence,
        timestamp: new Date().toISOString(),
        type,
        ...fields,
      });

      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const send = (type: string, fields?: Record<string, unknown>) =>
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify(event(type, fields))}\n\n`),
            );
          const settle = () => send("run_settled");

          if (selectedScenario === "queue-followup") {
            send("run_started");
            send("progress_added", { partId: `p-${call}-1`, text: "正在检查邮件" });
            if (call === 1) {
              window.setTimeout(() => {
                send("text_started", { partId: `t-${call}-1` });
                send("text_completed", {
                  partId: `t-${call}-1`,
                  text: "## 第一轮完成\n\n已经检查完毕。",
                });
                settle();
                controller.close();
              }, 1_200);
            } else {
              window.setTimeout(() => {
                send("text_started", { partId: `t-${call}-1` });
                send("text_completed", { partId: `t-${call}-1`, text: "第二轮已自动执行。" });
                settle();
                controller.close();
              }, 100);
            }
            return;
          }

          if (selectedScenario === "stoppable-queue") {
            send("run_started");
            send("progress_added", { partId: `p-${call}-1`, text: "长任务进行中" });
            if (call === 1) {
              // Hold the stream open until the user stops the run; the client
              // aborts the request and the composer shows the paused queue.
              init?.signal?.addEventListener(
                "abort",
                () => controller.error(new DOMException("Aborted", "AbortError")),
                { once: true },
              );
            } else {
              window.setTimeout(() => {
                send("text_started", { partId: `t-${call}-1` });
                send("text_completed", { partId: `t-${call}-1`, text: "暂停后的队列已恢复。" });
                settle();
                controller.close();
              }, 100);
            }
            return;
          }

          if (selectedScenario === "reasoning-markdown-tool") {
            send("run_started");
            send("progress_added", {
              partId: "p-1",
              text: "我先检索最近七天的重点邮件，并比较它们的优先级。",
            });
            window.setTimeout(() => {
              send("tool_call_started", { toolCallId: "visual-tool-1", toolName: "list_mail" });
              send("tool_args_completed", { toolCallId: "visual-tool-1", input: { limit: 5 } });
              send("tool_execution_started", { toolCallId: "visual-tool-1" });
              send("tool_execution_completed", {
                toolCallId: "visual-tool-1",
                output: { count: 3 },
                summary: "找到 3 封需要关注的邮件",
              });
              send("progress_added", {
                partId: "p-2",
                text: "已经找到三封需要关注的邮件。我继续整理截止时间、风险和处理顺序。",
              });
              send("text_started", { partId: "t-1" });
              send("text_completed", {
                partId: "t-1",
                text: "## 今日重点\n\n- **预算审批**：今天 17:00 前回复\n- **项目周报**：补充风险项\n\n| 优先级 | 数量 |\n| --- | ---: |\n| 高 | 1 |\n| 中 | 2 |\n\n建议先处理预算审批。",
              });
              settle();
              controller.close();
            }, 900);
            return;
          }

          if (selectedScenario === "citations-confirmation-error") {
            send("run_started");
            send("text_started", { partId: "t-1" });
            send("text_completed", { partId: "t-1", text: "已根据原邮件整理出处理建议。" });
            send("citation_added", {
              partId: "t-1",
              citation: {
                id: "visual-citation-1",
                source: { kind: "mail", emailId: "mail-001", label: "原邮件" },
              },
            });
            send("confirmation_requested", {
              confirmation: {
                id: "visual-confirm-1",
                actionType: "send",
                description: "向 Alice 发送确认邮件",
                riskLevel: "high",
                parameters: { to: "alice@example.test", subject: "Re: Launch" },
                expiresAt: new Date(Date.now() + 60_000).toISOString(),
                idempotencyKey: "visual-confirm-1",
                status: "pending",
              },
            });
            send("run_failed", {
              code: "runtime_error",
              message: "邮件服务暂时不可用，请检查网络后重试。",
              retryable: false,
            });
            controller.close();
            return;
          }
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    };
  }, scenario);
}
