import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentMarkdown } from "./AgentMarkdown";

describe("AgentMarkdown", () => {
  beforeEach(() => {
    Object.defineProperty(window, "wemailDesktop", {
      configurable: true,
      writable: true,
      value: { openExternal: vi.fn().mockResolvedValue({ ok: true }) },
    });
  });

  it("blocks raw scripts and remote Markdown images", () => {
    const { container } = render(
      <AgentMarkdown text={'<script>alert(1)</script>\n\n![tracker](https://example.com/pixel.png)'} />,
    );

    expect(container.querySelector("script")).not.toBeInTheDocument();
    expect(container.querySelector("img")).not.toBeInTheDocument();
  });

  it("routes external links through the desktop safe-link bridge", () => {
    render(<AgentMarkdown text="[Open](https://example.com/path)" />);

    fireEvent.click(screen.getByRole("link", { name: "Open" }));
    expect(window.wemailDesktop?.openExternal).toHaveBeenCalledWith(
      "https://example.com/path",
    );
  });

  it("offers copy-only code controls", () => {
    render(<AgentMarkdown text={'```ts\nconst answer = 42;\n```'} />);

    expect(screen.getByRole("button", { name: /copy code/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /download/i })).not.toBeInTheDocument();
  });
});
