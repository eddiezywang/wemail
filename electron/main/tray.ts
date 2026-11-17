import type { App, BrowserWindow } from "electron";
import { Menu, Tray, nativeImage } from "electron";
import { getRuntimeIconPath } from "./assets.js";
import { createBadgedTrayImage, formatBadgeCount } from "./badge-icons.js";
import { setStartAtLogin } from "./startup.js";

const TRAY_ICON_SIZE = 16;

let tray: Tray | null = null;
let trayController: WemailTrayController | null = null;

function createBaseTrayIcon(app: App) {
  const iconPath = getRuntimeIconPath(app);
  const icon = iconPath
    ? nativeImage.createFromPath(iconPath)
    : nativeImage.createEmpty();

  return icon.resize({ width: TRAY_ICON_SIZE, height: TRAY_ICON_SIZE });
}

export interface WemailTrayController {
  setBadgeCount(count: number): void;
}

export function createTray(app: App, getWindow: () => BrowserWindow | null) {
  if (tray && trayController) return trayController;

  const baseIcon = createBaseTrayIcon(app);
  tray = new Tray(baseIcon);
  tray.setToolTip("WeMail");
  const showWindow = () => {
    const win = getWindow();
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  };
  tray.on("click", showWindow);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: "开机自动启动",
        type: "checkbox",
        checked: app.getLoginItemSettings().openAtLogin,
        click: (menuItem) => {
          const settings = setStartAtLogin(app, menuItem.checked);
          menuItem.checked = settings.openAtLogin;
        },
      },
      { type: "separator" },
      {
        label: "Quit",
        click: () => app.quit(),
      },
    ]),
  );

  trayController = {
    setBadgeCount(count) {
      if (!tray || tray.isDestroyed()) return;
      if (count <= 0) {
        tray.setImage(baseIcon);
        tray.setToolTip("WeMail");
        return;
      }
      const badgedIcon = createBadgedTrayImage(baseIcon, count);
      tray.setImage(badgedIcon);
      tray.setToolTip(`WeMail · ${formatBadgeCount(count)} 封新邮件`);
    },
  };
  return trayController;
}
