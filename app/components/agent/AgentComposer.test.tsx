import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import type { AgentAttachedMail } from "../../../shared/wemail/agent";
import type { ConversationFollowupState } from "../../../shared/wemail/conversationState";
import { AgentComposer } from "./AgentComposer";

const useSearchEmailsMock = vi.hoisted(() => vi.fn());
const apiMock = vi.hoisted(() => ({ searchEmails: vi.fn() }));
vi.mock("~/queries/search", () => ({ useSearchEmails: useSearchEmailsMock }));
vi.mock("~/services/api", () => ({ default: apiMock }));

const candidateEmails = [
  { id: "e1", subject: "补光灯067", sender: "SHDR Lost & Found", date: "2026-06-01", read: false, message_id: "m1" },
  { id: "e2", subject: "月度发票核对", sender: "finance@example.com", date: "2026-07-02", read: true, message_id: "m2" },
];

const queryClient = new QueryClient({
	defaultOptions: { queries: { retry: false } },
});
function withProviders(ui: ReactElement) {
	return <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>;
}

const queue: ConversationFollowupState[] = [
  { id: "one", text: "第一条", position: 0, state: "queued" },
  { id: "two", text: "第二条", position: 1, state: "queued" },
];

function renderComposer(overrides: Partial<React.ComponentProps<typeof AgentComposer>> = {}) {
  const props: React.ComponentProps<typeof AgentComposer> = {
    accountId: "acct-1",
    conversationId: "conv-1",
    isStreaming: false,
    followups: [],
    onSubmit: vi.fn(),
    onStop: vi.fn(),
    onUpdateFollowup: vi.fn(),
    onRemoveFollowup: vi.fn(),
    onMoveFollowup: vi.fn(),
    onResumeFollowups: vi.fn(),
    ...overrides,
  };
  return { props, ...render(withProviders(<AgentComposer {...props} />)) };
}

describe("AgentComposer", () => {
  beforeEach(() => {
    window.localStorage.clear();
    (window as { wemailDesktop?: unknown }).wemailDesktop = undefined;
    apiMock.searchEmails.mockReset().mockResolvedValue({ emails: candidateEmails });
    useSearchEmailsMock.mockReset().mockReturnValue({ data: undefined });
  });

  it("does not render a voice input control", () => {
    renderComposer();
    expect(screen.queryByRole("button", { name: "Voice" })).not.toBeInTheDocument();
  });

  it("opens the slash command menu on '/' and inserts the picked prompt", () => {
    renderComposer();
    const input = screen.getByLabelText("向 WeMail AI 发送消息");
    fireEvent.change(input, { target: { value: "/" } });
    expect(screen.getByTestId("agent-slash-commands")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("option", { name: /起草回复/ }));
    expect(input).toHaveValue("基于当前邮件帮我起草一封简洁回复，等待我确认后再发送。");
    // Menu closes once a prompt is inserted (value no longer starts with "/").
    expect(screen.queryByTestId("agent-slash-commands")).not.toBeInTheDocument();
  });

  it("dismisses the slash menu with Escape and reopens after a fresh slash", () => {
    renderComposer();
    const input = screen.getByLabelText("向 WeMail AI 发送消息");
    fireEvent.change(input, { target: { value: "/回" } });
    expect(screen.getByTestId("agent-slash-commands")).toBeInTheDocument();

    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByTestId("agent-slash-commands")).not.toBeInTheDocument();

    fireEvent.change(input, { target: { value: "不以斜杠开头" } });
    fireEvent.change(input, { target: { value: "/总" } });
    expect(screen.getByTestId("agent-slash-commands")).toBeInTheDocument();
  });

  it("keeps the composer active during streaming and queues submitted text", () => {
    const { props } = renderComposer({ isStreaming: true, followups: queue });
    const input = screen.getByLabelText("向 WeMail AI 发送消息");
    expect(input).not.toBeDisabled();
    fireEvent.change(input, { target: { value: "完成后继续总结" } });
    fireEvent.click(screen.getByRole("button", { name: "加入后续消息队列" }));
    expect(props.onSubmit).toHaveBeenCalledWith("完成后继续总结");
    expect(screen.getByTestId("agent-followup-queue")).toHaveTextContent("第一条");
  });

  it("reports the first typed content so home suggestions can freeze", () => {
    const onInteraction = vi.fn();
    renderComposer({ onInteraction });
    fireEvent.change(screen.getByLabelText("向 WeMail AI 发送消息"), {
      target: { value: "先不要替换推荐" },
    });
    expect(onInteraction).toHaveBeenCalled();
  });

  it("shows the focused mail as the default chip and pops it out on ✕", async () => {
    const onDismissFocusedMail = vi.fn();
    renderComposer({
      focusedMail: { emailId: "e0", subject: "关键词告警统计-2026-08-11" },
      onDismissFocusedMail,
    });

    expect(screen.getByTestId("agent-focused-mail-chip")).toHaveTextContent(
      "关键词告警统计-2026-08-11",
    );
    fireEvent.click(screen.getByRole("button", { name: "取消关联：关键词告警统计-2026-08-11" }));
    // The ✕ plays a pop-out before the removal commits.
    await waitFor(() => expect(onDismissFocusedMail).toHaveBeenCalledTimes(1), { timeout: 1000 });
  });

  it("prefills and focuses an explicit input request", () => {
    const { rerender } = renderComposer();
    rerender(
      withProviders(
        <AgentComposer
          accountId="acct-1"
          conversationId="conv-1"
          isStreaming={false}
          followups={[]}
          inputRequest={{ id: 1, text: "请解释这条自动化：" }}
          onSubmit={vi.fn()}
          onStop={vi.fn()}
          onUpdateFollowup={vi.fn()}
          onRemoveFollowup={vi.fn()}
          onMoveFollowup={vi.fn()}
          onResumeFollowups={vi.fn()}
        />,
      ),
    );

    expect(screen.getByLabelText("向 WeMail AI 发送消息")).toHaveValue(
      "请解释这条自动化：",
    );
    expect(screen.getByLabelText("向 WeMail AI 发送消息")).toHaveFocus();
  });

  it("opens the @ mail picker, attaches the picked mail, and clears the trigger", async () => {
    const onAttachMail = vi.fn();
    renderComposer({ onAttachMail });
    const input = screen.getByLabelText("向 WeMail AI 发送消息");
    fireEvent.change(input, { target: { value: "对比一下 @" } });
    expect(await screen.findByTestId("agent-at-candidates")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("option", { name: /补光灯067/ }));
    expect(onAttachMail).toHaveBeenCalledWith({
      emailId: "e1",
      subject: "补光灯067",
      sender: "SHDR Lost & Found",
      receivedAt: "2026-06-01",
    });
    expect(input).toHaveValue("对比一下 ");
    expect(screen.queryByTestId("agent-at-candidates")).not.toBeInTheDocument();
  });

  it("selects an @ candidate with the keyboard and dismisses with Escape", async () => {
    const onAttachMail = vi.fn();
    renderComposer({ onAttachMail });
    const input = screen.getByLabelText("向 WeMail AI 发送消息");
    fireEvent.change(input, { target: { value: "@" } });
    expect(await screen.findByTestId("agent-at-candidates")).toBeInTheDocument();

    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByTestId("agent-at-candidates")).not.toBeInTheDocument();

    fireEvent.change(input, { target: { value: "再选 @" } });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onAttachMail).toHaveBeenCalledWith(
      expect.objectContaining({ emailId: "e2", subject: "月度发票核对" }),
    );
  });

  it("renders attached mails as removable chips", async () => {
    const onRemoveAttachedMail = vi.fn();
    const mail: AgentAttachedMail = { emailId: "e1", subject: "补光灯067", sender: "SHDR Lost & Found" };
    renderComposer({ attachedMails: [mail], onRemoveAttachedMail });

    const chips = screen.getByTestId("agent-attached-mails");
    expect(chips).toHaveTextContent("补光灯067");
    fireEvent.click(screen.getByRole("button", { name: "取消关联：补光灯067" }));
    await waitFor(() => expect(onRemoveAttachedMail).toHaveBeenCalledWith("e1"), { timeout: 1000 });
  });

  it("supports edit, remove, and reorder controls", () => {
    const { props } = renderComposer({ followups: queue });
    fireEvent.click(screen.getAllByRole("button", { name: "下移后续消息" })[0]);
    expect(props.onMoveFollowup).toHaveBeenCalledWith("one", 1);
    fireEvent.click(screen.getAllByRole("button", { name: "移除后续消息" })[1]);
    expect(props.onRemoveFollowup).toHaveBeenCalledWith("two");
    fireEvent.click(screen.getAllByRole("button", { name: "编辑后续消息" })[0]);
    fireEvent.change(screen.getByLabelText("编辑后续消息 1"), { target: { value: "修改后" } });
    fireEvent.click(screen.getByRole("button", { name: "保存后续消息" }));
    expect(props.onUpdateFollowup).toHaveBeenCalledWith("one", "修改后");
  });

  it("restores a separate unsent draft for each conversation", async () => {
    const drafts = new Map([
      ["acct-1|conv-1", "会话一草稿"],
      ["acct-1|conv-2", "会话二草稿"],
    ]);
    (window as { wemailDesktop?: unknown }).wemailDesktop = {
      agentDrafts: {
        get: vi.fn(async (accountId: string, conversationId: string) => ({
          text: drafts.get(`${accountId}|${conversationId}`) ?? "",
        })),
        save: vi.fn(async () => ({ ok: true })),
        delete: vi.fn(async () => ({ ok: true })),
      },
    };
    const { rerender } = renderComposer();
    await waitFor(() =>
      expect(screen.getByLabelText("向 WeMail AI 发送消息")).toHaveValue("会话一草稿"));
    rerender(withProviders(<AgentComposer accountId="acct-1" conversationId="conv-2" isStreaming={false} followups={[]} onSubmit={vi.fn()} onStop={vi.fn()} onUpdateFollowup={vi.fn()} onRemoveFollowup={vi.fn()} onMoveFollowup={vi.fn()} onResumeFollowups={vi.fn()} />));
    await waitFor(() =>
      expect(screen.getByLabelText("向 WeMail AI 发送消息")).toHaveValue("会话二草稿"));
  });
});
