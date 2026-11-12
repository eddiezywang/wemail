// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import EmailPanelHeader from "~/components/email-panel/EmailPanelHeader";

describe("EmailPanelHeader", () => {
  it("renders the subject text", () => {
    render(<EmailPanelHeader subject="Project update" messageCount={1} showThreadCount={false} />);
    expect(screen.getByText("Project update")).toBeInTheDocument();
  });

  it("does not show thread count when showThreadCount is false", () => {
    render(<EmailPanelHeader subject="Hello" messageCount={5} showThreadCount={false} />);
    expect(screen.queryByText(/messages in this thread/)).toBeNull();
  });

  it("shows thread count when showThreadCount is true", () => {
    render(<EmailPanelHeader subject="Hello" messageCount={3} showThreadCount={true} />);
    expect(screen.getByText("3 封往来")).toBeInTheDocument();
  });

  it("shows 1 message count correctly", () => {
    render(<EmailPanelHeader subject="Hello" messageCount={1} showThreadCount={true} />);
    expect(screen.getByText("1 封往来")).toBeInTheDocument();
  });
});
