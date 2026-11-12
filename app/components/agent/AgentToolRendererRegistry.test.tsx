import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ConversationToolState } from "../../../shared/wemail/conversationState";
import {
  AgentToolCard,
  GenericToolCard,
  getAgentToolRenderer,
} from "./AgentToolRendererRegistry";

function tool(overrides: Partial<ConversationToolState> = {}): ConversationToolState {
  return {
    toolCallId: "tool-1",
    runId: "run-1",
    toolName: "search_mail",
    argsText: "",
    state: "completed",
    input: { query: "budget" },
    output: { count: 2 },
    ...overrides,
  };
}

describe("AgentToolRendererRegistry", () => {
  it("selects mail-specific renderers and falls back for unknown tools", () => {
    expect(getAgentToolRenderer("search_mail")).not.toBe(GenericToolCard);
    expect(getAgentToolRenderer("unknown_tool")).toBe(GenericToolCard);
  });

  it("renders a search result as a business summary", () => {
    render(<AgentToolCard tool={tool()} />);

    expect(screen.getByText("搜索邮件")).toBeInTheDocument();
    expect(screen.getByText("搜索已完成")).toBeInTheDocument();
    expect(screen.queryByText(/"query": "budget"/)).not.toBeInTheDocument();
  });

  it("keeps failed tools expanded with an actionable error", () => {
    render(
      <AgentToolCard
        tool={tool({
          state: "failed",
          error: { code: "timeout", message: "邮件服务超时" },
        })}
      />,
    );

    // The error shows both in the card summary line and the expanded details.
    expect(screen.getAllByText("邮件服务超时").length).toBeGreaterThan(0);
    expect(screen.getByText("命令")).toBeInTheDocument();
    expect(screen.getByText("结果")).toBeInTheDocument();
  });

  it("keeps Skill lifecycle cards compact and hides internal package metadata", () => {
    render(
      <AgentToolCard
        tool={tool({
          toolName: "validate_skill_draft",
          input: { draftId: "draft-1" },
          output: {
            displayName: "监控日报",
            version: "1.0.0",
            contentHash: "secret-hash",
            sourcePipelineId: "pipeline-1",
            manifest: { source: "internal" },
          },
        })}
      />,
    );

    expect(screen.getByText("校验 Skill 草稿")).toBeInTheDocument();
    expect(screen.getByText("校验完成，等待确认")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(
      screen.queryByText(/draft-1|1\.0\.0|secret-hash|pipeline-1|internal/),
    ).not.toBeInTheDocument();
  });

  it("keeps native Skill reads compact and hides the loaded body", () => {
    render(
      <AgentToolCard
        tool={tool({
          toolName: "read",
          input: { path: "skills/wemail-insight-report/SKILL.md" },
          output: "内部 Skill 正文",
        })}
      />,
    );

    expect(screen.getByText("读取 Skill")).toBeInTheDocument();
    expect(screen.getByText("已按需读取 Skill 资源")).toBeInTheDocument();
    expect(screen.queryByText(/内部 Skill 正文|SKILL\.md/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("hides the edition-only WeCLI cards unless the feature is enabled", () => {
    // P2.5: the open edition registers no wecli_* agent tools, and the
    // WeCLI-specific cards are merged into the map only when the caller
    // passes wecliEnabled (derived from useEditionFeatures().wecli).
    expect(getAgentToolRenderer("wecli_query")).toBe(GenericToolCard);
    expect(getAgentToolRenderer("propose_wecli_command")).toBe(GenericToolCard);
    expect(getAgentToolRenderer("wecli_query", true)).not.toBe(GenericToolCard);
    expect(getAgentToolRenderer("propose_wecli_command", true)).not.toBe(GenericToolCard);

    const hidden = render(
      <AgentToolCard tool={tool({ toolName: "wecli_run", output: { ok: true } })} />,
    );
    expect(hidden.queryByText("企业工具")).not.toBeInTheDocument();
    hidden.unmount();

    const shown = render(
      <AgentToolCard
        tool={tool({ toolName: "wecli_run", output: { ok: true } })}
        wecliEnabled
      />,
    );
    expect(shown.getByText("企业工具")).toBeInTheDocument();
    shown.unmount();
  });
});
