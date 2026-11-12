import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { conversationStateFromEvents } from "../../../shared/wemail/conversationState";
import type { WemailAgentEvent } from "../../../shared/wemail/agentProtocol";
import { AgentConversationThread } from "./AgentConversationThread";

const base = {
  schemaVersion: 1 as const,
  conversationId: "conv-1",
  runId: "run-1",
  messageId: "assistant-1",
  timestamp: "2026-07-14T12:00:00.000Z",
};

function event(sequence: number, payload: Record<string, unknown>): WemailAgentEvent {
  return { ...base, sequence, ...payload } as WemailAgentEvent;
}

function completedState() {
  return conversationStateFromEvents("conv-1", [
    event(0, { type: "run_started" }),
    event(1, { type: "message_started", role: "assistant" }),
    event(2, { type: "progress_added", partId: "progress-1", text: "先查邮件" }),
    event(4, {
      type: "tool_call_started",
      toolCallId: "tool-1",
      toolName: "search_mail",
    }),
    event(5, {
      type: "tool_args_completed",
      toolCallId: "tool-1",
      input: { query: "budget" },
    }),
    event(6, { type: "tool_execution_started", toolCallId: "tool-1" }),
    event(7, {
      type: "tool_execution_completed",
      toolCallId: "tool-1",
      output: { count: 1 },
      summary: "找到 1 封邮件",
    }),
    event(8, { type: "text_started", partId: "text-1" }),
    event(9, {
      type: "text_completed",
      partId: "text-1",
      text: "## 结果\n\n找到一封邮件。",
    }),
    event(10, { type: "message_completed" }),
    event(11, { type: "run_settled" }),
  ]);
}

describe("AgentConversationThread", () => {
  it("uses a one-piece AI mark instead of the WeMail brand image", () => {
    render(<AgentConversationThread state={completedState()} isStreaming={false} />);

    const mark = screen.getByTestId("agent-assistant-mark");
    expect(mark.querySelector("svg")).not.toBeNull();
    expect(mark.querySelector('img[src="/ai-panel-logo.png"]')).toBeNull();
  });

  it("collapses the completed run process while keeping the final answer visible", () => {
    render(<AgentConversationThread state={completedState()} isStreaming={false} />);

    expect(screen.getByTestId("agent-conversation-v2")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /已思考/ })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("先查邮件")).not.toBeInTheDocument();
    expect(screen.queryByText("查阅了邮件")).not.toBeInTheDocument();
    expect(screen.queryByText("找到 1 封邮件")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "结果" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /展开所有/i })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /已思考/ }));
    expect(screen.getByText("先查邮件")).toBeInTheDocument();
    expect(screen.getByText("查阅了邮件")).toBeInTheDocument();
    fireEvent.click(screen.getByText("查阅了邮件"));
    expect(screen.getByRole("button", { name: /搜索邮件，已完成/ })).toBeInTheDocument();
  });

  it("derives the completed elapsed time from server run timestamps", () => {
    const state = conversationStateFromEvents("conv-1", [
      event(0, { type: "run_started", timestamp: "2026-07-14T12:00:00.000Z" }),
      event(1, { type: "message_started", role: "assistant", timestamp: "2026-07-14T12:00:00.000Z" }),
      event(2, { type: "progress_added", partId: "progress-1", text: "正在处理", timestamp: "2026-07-14T12:00:02.000Z" }),
      event(4, { type: "message_completed", timestamp: "2026-07-14T12:06:43.000Z" }),
      event(5, { type: "run_settled", timestamp: "2026-07-14T12:06:44.000Z" }),
    ]);

    render(<AgentConversationThread state={state} isStreaming={false} />);

    expect(screen.getByRole("button", { name: "已思考 6分 44秒" })).toBeInTheDocument();
  });

  it("does not revive an older process when the panel is streaming another turn", () => {
    const completed = completedState();
    const state = {
      ...completed,
      runs: {},
    };

    render(<AgentConversationThread state={state} isStreaming={true} />);

    expect(screen.getByRole("button", { name: /已思考/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /正在处理/ })).not.toBeInTheDocument();
  });

  it("keeps successful tools collapsed until their own chip is opened", () => {
    render(<AgentConversationThread state={completedState()} isStreaming={false} />);

    expect(screen.queryByText(/"query": "budget"/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /已思考/ }));
    fireEvent.click(screen.getByText("查阅了邮件"));
    expect(screen.queryByText('search_mail {"query":"budget"}')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /搜索邮件，已完成/ }));
    expect(screen.getByText("找到 1 封邮件")).toBeInTheDocument();
    expect(screen.getByText('search_mail {"query":"budget"}')).toBeInTheDocument();
    expect(screen.queryByText(/"query": "budget"/)).not.toBeInTheDocument();
  });

  it("keeps final answers, safe progress, and tool diagnostics selectable", () => {
    render(<AgentConversationThread state={completedState()} isStreaming={false} />);

    expect(screen.getByTestId("agent-final-answer")).toHaveClass("select-text");
    fireEvent.click(screen.getByRole("button", { name: /已思考/ }));
    expect(screen.getByTestId("agent-process-progress")).toHaveClass("select-text");
    fireEvent.click(screen.getByText("查阅了邮件"));
    fireEvent.click(screen.getByRole("button", { name: /搜索邮件，已完成/ }));
    expect(
      screen.getByText('search_mail {"query":"budget"}').closest(".select-text"),
    ).toBeInTheDocument();
  });

  it("shows process prose while active and auto-collapses it after settlement", () => {
    const active = conversationStateFromEvents("conv-1", [
      event(0, { type: "run_started" }),
      event(1, { type: "message_started", role: "assistant" }),
      event(2, { type: "progress_added", partId: "progress-1", text: "正在检查" }),
    ]);
    const { rerender } = render(
      <AgentConversationThread state={active} isStreaming={true} />,
    );

    expect(screen.getByText("正在检查")).toBeInTheDocument();
    expect(screen.getByTestId("agent-run-process")).toHaveAttribute("data-run-state", "running");

    rerender(<AgentConversationThread state={completedState()} isStreaming={false} />);
    expect(screen.queryByText("查阅了邮件")).not.toBeInTheDocument();
    expect(screen.queryByText("先查邮件")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /已思考/ })).toHaveAttribute("aria-expanded", "false");
  });

  it("opens structured mail citations and explains unavailable sources", () => {
    const onOpenEmail = vi.fn();
    const state = conversationStateFromEvents("conv-1", [
      event(0, { type: "run_started" }),
      event(1, { type: "message_started", role: "assistant" }),
      event(2, { type: "text_started", partId: "text-1" }),
      event(3, { type: "text_completed", partId: "text-1", text: "有两个来源。" }),
      event(4, { type: "citation_added", partId: "text-1", citation: { id: "mail-cite", source: { kind: "mail", emailId: "mail-1", label: "预算邮件", excerpt: "预算审批结果" } } }),
      event(5, { type: "citation_added", partId: "text-1", citation: { id: "record-cite", source: { kind: "record", recordType: "invoice", recordId: "missing", label: "报销记录" } } }),
    ]);
    render(<AgentConversationThread state={state} isStreaming={false} onOpenEmail={onOpenEmail} />);
    fireEvent.click(screen.getByRole("button", { name: "引用 1: 预算邮件" }));
    expect(screen.getByText("预算审批结果")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "打开邮件" }));
    expect(onOpenEmail).toHaveBeenCalledWith("mail-1");
    fireEvent.click(screen.getByRole("button", { name: "引用 2: 报销记录" }));
    expect(screen.getByText(/来源当前不可用/)).toBeInTheDocument();
  });

  it("offers grounded follow-up chips after a settled answer and submits on click", () => {
    const onFollowup = vi.fn();
    const state = conversationStateFromEvents("conv-1", [
      event(0, { type: "run_started" }),
      event(1, { type: "message_started", role: "assistant" }),
      event(2, { type: "text_completed", partId: "text-1", text: "报销合计见引用。" }),
      event(3, { type: "citation_added", partId: "text-1", citation: { id: "cite-1", source: { kind: "mail", emailId: "mail-1", label: "报销一" } } }),
      event(4, { type: "citation_added", partId: "text-1", citation: { id: "cite-2", source: { kind: "mail", emailId: "mail-2", label: "报销二" } } }),
    ]);

    render(<AgentConversationThread state={state} isStreaming={false} onFollowup={onFollowup} />);

    const followups = screen.getByTestId("agent-answer-followups");
    expect(followups).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "对比这几封邮件的要点和时间线" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "逐项列出这些邮件的关键信息" }));
    expect(onFollowup).toHaveBeenCalledWith("逐项列出这些邮件的关键信息");
  });

  it("shows three unique mail sources before expanding the rest", () => {
    const state = conversationStateFromEvents("conv-1", [
      event(0, { type: "run_started" }),
      event(1, { type: "message_started", role: "assistant" }),
      event(2, { type: "text_completed", partId: "text-1", text: "报告完成。" }),
      ...[1, 2, 3, 4, 4, 5].map((mail, index) => event(3 + index, {
        type: "citation_added",
        partId: "text-1",
        citation: {
          id: `mail-cite-${index}`,
          source: { kind: "mail", emailId: `mail-${mail}`, label: `来源邮件 ${mail}` },
        },
      })),
    ]);

    render(<AgentConversationThread state={state} isStreaming={false} />);

    expect(screen.getByRole("button", { name: "引用 1: 来源邮件 1" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "引用 3: 来源邮件 3" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /来源邮件 4/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "其余 2 封邮件" })).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(screen.getByRole("button", { name: "其余 2 封邮件" }));
    expect(screen.getByRole("button", { name: "引用 4: 来源邮件 4" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "引用 5: 来源邮件 5" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /来源邮件 4/ })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "收起关联邮件" })).toHaveAttribute("aria-expanded", "true");
  });

  it("offers in-app and browser actions for completed artifacts", () => {
    const state = conversationStateFromEvents("conv-1", [
      event(0, { type: "run_started" }),
      event(1, { type: "message_started", role: "assistant" }),
      event(2, {
        type: "artifact_ready",
        partId: "artifact-1",
        artifact: {
          artifactId: "artifact-1",
          version: 2,
          kind: "report",
          contentHash: "hash-1",
          title: "日报",
          preview: "报告摘要",
          applicationMessageId: "message-1",
        },
      }),
    ]);

    render(<AgentConversationThread state={state} isStreaming={false} accountId="acct-1" />);

    expect(screen.getByRole("button", { name: /打开报告/ })).toBeInTheDocument();
    const browserLink = screen.getByRole("link", { name: /浏览器打开/ });
    expect(browserLink).toHaveAttribute("target", "_blank");
    expect(browserLink).toHaveAttribute(
      "href",
      "http://localhost:3000/api/application-messages/message-1/artifact?accountId=acct-1",
    );
  });

  it("keeps resolved confirmation cards as read-only history", () => {
    const state = conversationStateFromEvents("conv-1", [
      event(0, { type: "run_started" }),
      event(1, { type: "message_started", role: "assistant" }),
      event(2, { type: "confirmation_requested", confirmation: { id: "confirm-1", actionType: "send", description: "发送邮件给财务", riskLevel: "high", parameters: {}, expiresAt: "2026-07-15T12:00:00.000Z", idempotencyKey: "key-1", status: "pending" } }),
      event(3, { type: "confirmation_resolved", confirmationId: "confirm-1", status: "confirmed" }),
    ]);
    render(<AgentConversationThread state={state} isStreaming={false} />);
    expect(screen.getByText("已确认执行：发送邮件给财务")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /确认执行/ })).not.toBeInTheDocument();
  });

  it("keeps the whole process before the final answer even when a tool arrives late", () => {
    const state = conversationStateFromEvents("conv-1", [
      event(0, { type: "run_started" }),
      event(1, { type: "message_started", role: "assistant" }),
      event(2, { type: "text_started", partId: "text-1" }),
      event(3, { type: "text_completed", partId: "text-1", text: "最终结论" }),
      event(4, { type: "tool_call_started", toolCallId: "tool-late", toolName: "search_mail" }),
      event(5, { type: "tool_execution_started", toolCallId: "tool-late" }),
      event(6, { type: "tool_execution_completed", toolCallId: "tool-late", output: { count: 0 }, summary: "搜索完成" }),
      event(7, { type: "message_completed" }),
      event(8, { type: "run_settled" }),
    ]);
    render(<AgentConversationThread state={state} isStreaming={false} />);

    const process = screen.getByTestId("agent-run-process");
    const answer = screen.getByTestId("agent-final-answer");
    expect(process.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByText("搜索完成")).not.toBeInTheDocument();
  });

  it("collapses a failed process into a recoverable summary", () => {
    const state = conversationStateFromEvents("conv-1", [
      event(0, { type: "run_started" }),
      event(1, { type: "message_started", role: "assistant" }),
      event(2, { type: "progress_added", partId: "progress-1", text: "正在搜索" }),
      event(4, { type: "message_completed" }),
      event(5, { type: "run_failed", code: "network", message: "网络不可用", retryable: true }),
    ]);
    render(<AgentConversationThread state={state} isStreaming={false} />);

    expect(screen.queryByText("正在搜索")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /未能完成/ })).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(screen.getByRole("button", { name: /未能完成/ }));
    const progress = screen.getByText("正在搜索");
    const error = screen.getByText("Agent 操作未能完成，请重试或调整要求。");
    expect(progress.compareDocumentPosition(error) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("keeps confirmation fixed between pre- and post-confirmation phases", () => {
    const state = conversationStateFromEvents("conv-1", [
      event(0, { type: "run_started" }),
      event(1, { type: "message_started", role: "assistant" }),
      event(2, { type: "progress_added", partId: "progress-before", text: "准备发送" }),
      event(4, { type: "confirmation_requested", confirmation: { id: "confirm-1", actionType: "send", description: "发送邮件给财务", riskLevel: "high", parameters: {}, expiresAt: "2026-07-15T12:00:00.000Z", idempotencyKey: "key-1", status: "pending" } }),
      event(5, { type: "tool_call_started", toolCallId: "tool-after", toolName: "search_mail" }),
      event(6, { type: "tool_execution_completed", toolCallId: "tool-after", output: { ok: true }, summary: "确认后执行完成" }),
      event(7, { type: "text_started", partId: "text-after" }),
      event(8, { type: "text_completed", partId: "text-after", text: "邮件已处理。" }),
      event(9, { type: "message_completed" }),
      event(10, { type: "run_settled" }),
    ]);
    render(<AgentConversationThread state={state} isStreaming={false} />);

    fireEvent.click(screen.getByRole("button", { name: /已思考/ }));
    const progress = screen.getByText("准备发送");
    const process = screen.getByTestId("agent-process-disclosure");
    const confirmation = screen.getByText("等待确认：发送邮件给财务");
    const answer = screen.getByText("邮件已处理。");
    expect(progress.compareDocumentPosition(confirmation) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(confirmation.compareDocumentPosition(process) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(process.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
