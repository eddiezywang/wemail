import type { NativeImage } from "electron";
import { createTaskbarBadgeImage, formatBadgeCount } from "./badge-icons.js";

interface TaskbarBadgeWindow {
  isDestroyed(): boolean;
  setOverlayIcon(overlay: NativeImage | null, description: string): void;
}

export function projectTaskbarBadge(
  window: TaskbarBadgeWindow | null,
  count: number,
  platform = process.platform,
  createImage: (value: number) => NativeImage | null = createTaskbarBadgeImage,
): boolean {
  if (platform !== "win32" || !window || window.isDestroyed()) return false;
  const overlay = createImage(count);
  if (count > 0 && (!overlay || overlay.isEmpty())) return false;
  window.setOverlayIcon(
    overlay,
    count > 0 ? `${formatBadgeCount(count)} 封新邮件` : "",
  );
  return true;
}
