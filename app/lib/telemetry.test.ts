import { describe, expect, it, vi } from "vitest";
import { telemetrySurface, trackTelemetry } from "./telemetry";

describe("renderer telemetry", () => {
  it("maps dynamic paths to safe surface names", () => {
    expect(telemetrySurface("/message/private-id")).toBe("message");
    expect(telemetrySurface("/smart-tags/tag-id")).toBe("smart_tags");
  });

  it("forwards only the registered event and safe args", () => {
    const track = vi.fn();
    window.wemailDesktop = { telemetry: { track } } as typeof window.wemailDesktop;
    trackTelemetry("wemail_surface_viewed", { surface: "inbox" });
    expect(track).toHaveBeenCalledWith("wemail_surface_viewed", { surface: "inbox" });
  });
});
