import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getBusinessPreferences = vi.fn(async () => ({
  ok: true,
  stored: false,
  preferences: {},
}));
const saveBusinessPreferences = vi.fn(async () => ({
  ok: true,
  preferences: {},
}));

vi.mock("~/services/api", () => ({
  default: {
    getBusinessPreferences,
    saveBusinessPreferences,
  },
}));

describe("useUserPreferences notification migration", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  it("defaults action-required and new-mail on while sound stays off", async () => {
    const { useUserPreferences } = await import("./useUserPreferences");
    const { result, unmount } = renderHook(() => useUserPreferences());

    expect(result.current.actionRequiredNotifications).toBe(true);
    expect(result.current.newMailNotifications).toBe(true);
    expect(result.current.notificationSound).toBe(false);
    expect(result.current.notificationContentMode).toBe("full");
    expect("desktopNotifications" in result.current).toBe(false);

    unmount();
  });

  it("treats a legacy desktopNotifications value as not yet configured", async () => {
    window.localStorage.setItem(
      "wemail.userPreferences",
      JSON.stringify({ desktopNotifications: false }),
    );

    const { useUserPreferences } = await import("./useUserPreferences");
    const { result, unmount } = renderHook(() => useUserPreferences());

    expect(result.current.actionRequiredNotifications).toBe(true);
    expect(result.current.newMailNotifications).toBe(true);
    expect("desktopNotifications" in result.current).toBe(false);

    unmount();
  });

  it("preserves an explicit dedicated new-mail choice", async () => {
    window.localStorage.setItem(
      "wemail.userPreferences",
      JSON.stringify({ newMailNotifications: false }),
    );

    const { useUserPreferences } = await import("./useUserPreferences");
    const { result, unmount } = renderHook(() => useUserPreferences());

    expect(result.current.newMailNotifications).toBe(false);

    unmount();
  });
});
