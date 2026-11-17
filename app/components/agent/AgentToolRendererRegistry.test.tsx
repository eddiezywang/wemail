import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { GenericToolDetails } from "./AgentToolRendererRegistry";

it("redacts sensitive nested arguments while retaining useful tool details", () => {
  render(<GenericToolDetails tool={{
    toolCallId: "tool-1", runId: "run-1", toolName: "search_mail", argsText: "",
    state: "failed", input: { query: "budget", nested: { apiKey: "private-value" } },
    error: { code: "timeout", message: "邮件服务超时" },
  }} />);
  expect(screen.getByText(/budget/)).toBeInTheDocument();
  expect(screen.getByText(/已隐藏/)).toBeInTheDocument();
  expect(screen.queryByText(/private-value/)).not.toBeInTheDocument();
  expect(screen.getByText("邮件服务超时")).toBeInTheDocument();
  expect(screen.getByText(/错误码：timeout/)).toBeInTheDocument();
});
