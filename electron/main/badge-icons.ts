import { nativeImage, type NativeImage } from "electron";

const TASKBAR_SIZE = 32;
const TRAY_SOURCE_SIZE = 32;

const GLYPHS: Record<string, readonly string[]> = {
  "0": ["111", "101", "101", "101", "111"],
  "1": ["010", "110", "010", "010", "111"],
  "2": ["111", "001", "111", "100", "111"],
  "3": ["111", "001", "111", "001", "111"],
  "4": ["101", "101", "111", "001", "001"],
  "5": ["111", "100", "111", "001", "111"],
  "6": ["111", "100", "111", "101", "111"],
  "7": ["111", "001", "010", "010", "010"],
  "8": ["111", "101", "111", "101", "111"],
  "9": ["111", "101", "111", "001", "111"],
  "+": ["000", "010", "111", "010", "000"],
};

export function formatBadgeCount(count: number): string {
  const normalized = Math.max(0, Math.floor(count));
  return normalized > 99 ? "99+" : String(normalized);
}

export function renderTaskbarBadgeBitmap(count: number): Buffer | null {
  if (count <= 0) return null;
  const bitmap = Buffer.alloc(TASKBAR_SIZE * TASKBAR_SIZE * 4);
  drawBadge(bitmap, TASKBAR_SIZE, {
    centerX: 16,
    centerY: 16,
    radius: 15,
    label: formatBadgeCount(count),
  });
  return bitmap;
}

export function renderTrayBadgeBitmap(
  baseBitmap: Buffer,
  count: number,
): Buffer | null {
  if (count <= 0) return null;
  const bitmap = Buffer.from(baseBitmap);
  drawBadge(bitmap, TRAY_SOURCE_SIZE, {
    centerX: 24,
    centerY: 8,
    radius: 8,
    label: formatBadgeCount(count),
  });
  return bitmap;
}

export function createTaskbarBadgeImage(count: number): NativeImage | null {
  const bitmap = renderTaskbarBadgeBitmap(count);
  return bitmap
    ? nativeImage.createFromBitmap(bitmap, {
        width: TASKBAR_SIZE,
        height: TASKBAR_SIZE,
        scaleFactor: 1,
      })
    : null;
}

export function createBadgedTrayImage(
  baseIcon: NativeImage,
  count: number,
): NativeImage {
  if (count <= 0) return baseIcon.resize({ width: 16, height: 16 });
  const source = baseIcon.resize({
    width: TRAY_SOURCE_SIZE,
    height: TRAY_SOURCE_SIZE,
  });
  const bitmap = renderTrayBadgeBitmap(source.toBitmap(), count);
  if (!bitmap) return baseIcon.resize({ width: 16, height: 16 });
  const badged = nativeImage
    .createFromBitmap(bitmap, {
      width: TRAY_SOURCE_SIZE,
      height: TRAY_SOURCE_SIZE,
      scaleFactor: 1,
    })
    .resize({ width: 16, height: 16 });
  return badged.isEmpty() ? baseIcon.resize({ width: 16, height: 16 }) : badged;
}

function drawBadge(
  bitmap: Buffer,
  width: number,
  options: {
    centerX: number;
    centerY: number;
    radius: number;
    label: string;
  },
): void {
  const { centerX, centerY, radius, label } = options;
  for (let y = centerY - radius; y <= centerY + radius; y += 1) {
    for (let x = centerX - radius; x <= centerX + radius; x += 1) {
      const distanceSquared = (x - centerX) ** 2 + (y - centerY) ** 2;
      if (distanceSquared > radius ** 2) continue;
      const border = distanceSquared >= (radius - 1.5) ** 2;
      blendGrayPixel(bitmap, width, x, y, border ? 255 : 32, 255);
    }
  }

  const scale = label.length >= 3 ? 2 : label.length === 2 ? 3 : 4;
  const glyphWidth = 3 * scale;
  const gap = scale;
  const totalWidth = label.length * glyphWidth + (label.length - 1) * gap;
  const totalHeight = 5 * scale;
  let cursorX = Math.round(centerX - totalWidth / 2);
  const startY = Math.round(centerY - totalHeight / 2);
  for (const character of label) {
    drawGlyph(bitmap, width, cursorX, startY, character, scale);
    cursorX += glyphWidth + gap;
  }
}

function drawGlyph(
  bitmap: Buffer,
  width: number,
  startX: number,
  startY: number,
  character: string,
  scale: number,
): void {
  const glyph = GLYPHS[character];
  if (!glyph) return;
  glyph.forEach((row, rowIndex) => {
    [...row].forEach((pixel, columnIndex) => {
      if (pixel !== "1") return;
      for (let dy = 0; dy < scale; dy += 1) {
        for (let dx = 0; dx < scale; dx += 1) {
          blendGrayPixel(
            bitmap,
            width,
            startX + columnIndex * scale + dx,
            startY + rowIndex * scale + dy,
            255,
            255,
          );
        }
      }
    });
  });
}

function blendGrayPixel(
  bitmap: Buffer,
  width: number,
  x: number,
  y: number,
  gray: number,
  alpha: number,
): void {
  if (x < 0 || y < 0 || x >= width) return;
  const height = bitmap.length / 4 / width;
  if (y >= height) return;
  const offset = (y * width + x) * 4;
  const sourceAlpha = alpha / 255;
  const destinationAlpha = bitmap[offset + 3]! / 255;
  const outputAlpha = sourceAlpha + destinationAlpha * (1 - sourceAlpha);
  for (let channel = 0; channel < 3; channel += 1) {
    const destination = bitmap[offset + channel]!;
    bitmap[offset + channel] = Math.round(
      gray * sourceAlpha + destination * (1 - sourceAlpha),
    );
  }
  bitmap[offset + 3] = Math.round(outputAlpha * 255);
}
