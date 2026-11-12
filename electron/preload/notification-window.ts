import { contextBridge, ipcRenderer } from "electron";
import type { CustomNotificationPayload } from "../../shared/wemail/notifications.js";

// The overlay window is created lazily on first show; the page may still be
// loading when the first payload is sent. Cache the latest payload so a
// renderer that subscribes late still renders it.
let lastPayload: CustomNotificationPayload | null = null;
const listeners: Array<(payload: CustomNotificationPayload) => void> = [];
const hideListeners: Array<() => void> = [];

ipcRenderer.on("notify:payload", (_event, payload: CustomNotificationPayload) => {
  lastPayload = payload;
  for (const listener of listeners) listener(payload);
});
ipcRenderer.on("notify:hide", () => {
  for (const listener of hideListeners) listener();
});

contextBridge.exposeInMainWorld("notificationBridge", {
  onPayload: (callback: (payload: CustomNotificationPayload) => void) => {
    listeners.push(callback);
    if (lastPayload) callback(lastPayload);
  },
  onHide: (callback: () => void) => hideListeners.push(callback),
  clicked: () => ipcRenderer.send("notify:clicked"),
  action: (index: number) => ipcRenderer.send("notify:action", index),
  dismissed: () => ipcRenderer.send("notify:dismissed"),
  hidden: () => ipcRenderer.send("notify:animated-out"),
  // 渲染端报告真实内容高度，主进程据此收紧窗口高度。
  measure: (height: number) => ipcRenderer.send("notify:resize", height),
});
