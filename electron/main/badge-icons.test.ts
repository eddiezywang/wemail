import { describe, expect, it } from "vitest";
import {
  formatBadgeCount,
  renderTaskbarBadgeBitmap,
  renderTrayBadgeBitmap,
} from "./badge-icons.js";

describe("badge icons", () => {
  it("formats exact values and caps large counts", () => {
    expect(formatBadgeCount(1)).toBe("1");
    expect(formatBadgeCount(99)).toBe("99");
    expect(formatBadgeCount(100)).toBe("99+");
  });

  it("renders a non-empty native taskbar bitmap", () => {
    expect(renderTaskbarBadgeBitmap(0)).toBeNull();
    const bitmap = renderTaskbarBadgeBitmap(7)!;
    expect(bitmap).toHaveLength(32 * 32 * 4);
    expect([...bitmap].some((value) => value !== 0)).toBe(true);
    expect(bitmap.filter((_, index) => index % 4 === 3 && _ > 0).length).toBeGreaterThan(0);
  });

  it("composites the tray badge over the existing bitmap", () => {
    const base = Buffer.alloc(32 * 32 * 4, 64);
    const bitmap = renderTrayBadgeBitmap(base, 120)!;
    expect(bitmap).toHaveLength(base.length);
    expect(bitmap.equals(base)).toBe(false);
  });
});
