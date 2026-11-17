import { describe, expect, it, vi } from "vitest";
import { openWindowsNotificationSettingsWith } from "./windows-notification-settings.js";

describe("openWindowsNotificationSettingsWith", () => {
  it("opens the Windows notification settings URI", async () => {
    const openExternal = vi.fn(async () => undefined);

    const result = await openWindowsNotificationSettingsWith(
      openExternal,
      "win32",
    );

    expect(openExternal).toHaveBeenCalledWith("ms-settings:notifications");
    expect(result).toEqual({ ok: true, supported: true });
  });

  it("reports unsupported without opening a URI on other platforms", async () => {
    const openExternal = vi.fn(async () => undefined);

    const result = await openWindowsNotificationSettingsWith(
      openExternal,
      "darwin",
    );

    expect(openExternal).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: false, supported: false });
  });
});
