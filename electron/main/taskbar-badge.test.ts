import { describe, expect, it, vi } from "vitest";
import { projectTaskbarBadge } from "./taskbar-badge.js";

describe("projectTaskbarBadge", () => {
  it("sets and clears the Windows taskbar overlay", () => {
    const setOverlayIcon = vi.fn();
    const window = { isDestroyed: () => false, setOverlayIcon };
    const image = { id: "badge", isEmpty: () => false } as never;

    expect(projectTaskbarBadge(window, 120, "win32", () => image)).toBe(true);
    expect(setOverlayIcon).toHaveBeenCalledWith(image, "99+ 封新邮件");

    projectTaskbarBadge(window, 0, "win32", () => null);
    expect(setOverlayIcon).toHaveBeenLastCalledWith(null, "");
  });

  it("rejects an empty overlay image instead of reporting success", () => {
    const setOverlayIcon = vi.fn();
    const window = { isDestroyed: () => false, setOverlayIcon };
    const emptyImage = { isEmpty: () => true } as never;

    expect(projectTaskbarBadge(window, 1, "win32", () => emptyImage)).toBe(false);
    expect(setOverlayIcon).not.toHaveBeenCalled();
  });

  it("does nothing off Windows or after the window is destroyed", () => {
    const setOverlayIcon = vi.fn();
    const window = { isDestroyed: () => true, setOverlayIcon };

    expect(projectTaskbarBadge(window, 1, "win32")).toBe(false);
    expect(projectTaskbarBadge(window, 1, "darwin")).toBe(false);
    expect(setOverlayIcon).not.toHaveBeenCalled();
  });
});
