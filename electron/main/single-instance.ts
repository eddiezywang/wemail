import type { App, BrowserWindow } from "electron";

export function enforceSingleInstance(
  app: App,
  getWindow: () => BrowserWindow | null,
): boolean {
  const hasLock = app.requestSingleInstanceLock();

  if (!hasLock) {
    app.quit();
    return false;
  }

  app.on("second-instance", () => {
    const win = getWindow();
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });

  return true;
}
