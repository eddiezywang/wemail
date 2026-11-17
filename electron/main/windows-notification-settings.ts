export async function openWindowsNotificationSettingsWith(
  openExternal: (url: string) => Promise<unknown>,
  platform = process.platform,
): Promise<{ ok: boolean; supported: boolean }> {
  if (platform !== "win32") {
    return { ok: false, supported: false };
  }
  try {
    await openExternal("ms-settings:notifications");
    return { ok: true, supported: true };
  } catch {
    return { ok: false, supported: true };
  }
}
