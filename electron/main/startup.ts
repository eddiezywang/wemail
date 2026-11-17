import type { App } from "electron";

export function setStartAtLogin(app: App, enabled: boolean) {
  app.setLoginItemSettings({ openAtLogin: enabled });
  return app.getLoginItemSettings();
}
