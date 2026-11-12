import path from "node:path";
import { fileURLToPath } from "node:url";
import { BrowserWindow, ipcMain, screen, type Display } from "electron";
import type { CustomNotificationPayload } from "../../shared/wemail/notifications.js";
import type {
  DesktopNotificationActivationHandlers,
  DesktopNotificationOptions,
} from "./notifications.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const WINDOW_WIDTH = 340;
// 初始高度接近无按钮时的常见内容高度；渲染端测得真实高度后立即 resize 贴合，
// 避免固定 176px 在底部留大片空白。
const WINDOW_HEIGHT_INITIAL = 112;
const WINDOW_HEIGHT_MAX = 220;
const AUTO_HIDE_MS = 6_000;
const SCREEN_MARGIN = 16;

/**
 * * Self-drawn desktop notification: a frameless, opaque, always-on-top
 * overlay window rendering electron/assets/notification-window.html. Windows
 * draws the native drop shadow — no transparent-window/GPU compositing, so
 * no black-background artifact. The window height tracks the card's measured
 * content height (right-bottom anchored) so there's no dead space at the
 * bottom. Replaces the native Windows toast while reusing the coordinator's
 * full delivery pipeline (dedupe, aggregation, policy, activation routing).
 *
 * ponytail: single slot (new notification replaces the visible one),
 * primary display only. Native toasts stack vertically; add a queue of
 * per-notification windows if concurrent toasts become a real need.
 */
export class CustomNotificationWindow {
  private window: BrowserWindow | null = null;
  private hideTimer: ReturnType<typeof setTimeout> | null = null;
  private handlers: DesktopNotificationActivationHandlers | undefined;
  private readonly htmlPath: string | undefined;
  private readonly getDisplay: () => Display;

  constructor(options: {
    htmlPath?: string;
    getDisplay?: () => Display;
  }) {
    this.htmlPath = options.htmlPath;
    this.getDisplay = options.getDisplay ?? (() => screen.getPrimaryDisplay());
    ipcMain.on("notify:clicked", () => this.handlers?.onClick?.());
    ipcMain.on("notify:action", (_event, index: number) => {
      this.handlers?.onAction?.(index);
    });
    ipcMain.on("notify:dismissed", () => this.hide());
    // 渲染端退场动画已播完 → 立刻隐藏窗口，不再走 hide() 的 400ms 安全计时器，
    // 否则动画结束后到 window.hide() 之间会暴露不透明窗口的米色底（白屏）。
    ipcMain.on("notify:animated-out", () => this.hideImmediate());
    // 渲染端按真实内容高度驱动窗口尺寸（右下角锚定，向上/向左不变）。
    ipcMain.on("notify:resize", (_event, height: number) => this.resize(height));
  }

  /**
   * Shows the overlay with the given toast content. Returns false when the
   * HTML asset is missing so callers can fall back to the native toast.
   */
  show(
    options: DesktopNotificationOptions,
    handlers?: DesktopNotificationActivationHandlers,
  ): boolean {
    if (!this.htmlPath) return false;
    const window = this.ensureWindow();
    this.handlers = handlers;
    const payload: CustomNotificationPayload = {
      title: options.title,
      body: options.body,
      icon: typeof options.icon === "string" ? options.icon : undefined,
      actions: options.actionButtons ?? [],
      avatarText: options.avatarText,
      accent: options.accent,
    };
    window.webContents.send("notify:payload", payload);
    window.showInactive();
    this.scheduleHide(options.timeoutType === "never" ? null : AUTO_HIDE_MS);
    return true;
  }

  /** 内容高度变化时收紧窗口：保持右下角锚定，高度向上伸缩，消除底部留白。 */
  private resize(height: number): void {
    const window = this.window;
    if (!window || window.isDestroyed()) return;
    const h = Math.max(96, Math.min(Math.round(height), WINDOW_HEIGHT_MAX));
    const bounds = window.getBounds();
    if (bounds.height === h) return;
    const workArea = this.getDisplay().workArea;
    window.setBounds({
      x: workArea.x + workArea.width - WINDOW_WIDTH - SCREEN_MARGIN,
      y: workArea.y + workArea.height - h - SCREEN_MARGIN,
      width: WINDOW_WIDTH,
      height: h,
    });
  }

  dispose(): void {
    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.hideTimer = null;
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    this.window = null;
  }

  private ensureWindow(): BrowserWindow {
    if (this.window && !this.window.isDestroyed()) return this.window;
    const workArea = this.getDisplay().workArea;
    const window = new BrowserWindow({
      width: WINDOW_WIDTH,
      height: WINDOW_HEIGHT_INITIAL,
      x: workArea.x + workArea.width - WINDOW_WIDTH - SCREEN_MARGIN,
      y: workArea.y + workArea.height - WINDOW_HEIGHT_INITIAL - SCREEN_MARGIN,
      show: false,
      frame: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      focusable: false,
      hasShadow: true,
      backgroundColor: "#fdfbf6",
      webPreferences: {
        preload: path.join(__dirname, "../preload/notification-window.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });
    window.on("closed", () => {
      this.window = null;
    });
    if (this.htmlPath) void window.loadFile(this.htmlPath);
    this.window = window;
    return window;
  }

  private scheduleHide(delayMs: number | null): void {
    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.hideTimer = null;
    if (delayMs === null) return;
    this.hideTimer = setTimeout(() => this.hide(), delayMs);
  }

  private hide(): void {
    if (this.hideTimer) {
      clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }
    const window = this.window;
    if (!window || window.isDestroyed()) return;
    // Ask the renderer to play its exit animation, then let it report back;
    // the safety timer guarantees the window still hides if the page is busy.
    if (!window.webContents.isLoading()) {
      window.webContents.send("notify:hide");
      this.hideTimer = setTimeout(() => {
        this.hideTimer = null;
        if (!window.isDestroyed()) window.hide();
      }, 400);
    } else {
      window.hide();
    }
  }

  /** 退场动画已结束：清掉安全计时器并立即隐藏，杜绝米色底白屏间隙。 */
  private hideImmediate(): void {
    if (this.hideTimer) {
      clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }
    const window = this.window;
    if (window && !window.isDestroyed()) window.hide();
  }
}
