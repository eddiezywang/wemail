import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePaths = {
  micro: path.join(root, "electron", "assets", "wemail-icon-micro.svg"),
  compact: path.join(root, "electron", "assets", "wemail-icon-compact.svg"),
  full: path.join(root, "electron", "assets", "wemail-icon.svg"),
};
const sources = Object.fromEntries(
  Object.entries(sourcePaths).map(([name, filePath]) => [name, fs.readFileSync(filePath)]),
);
const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256];

function sourceForSize(size) {
  if (size <= 20) return sources.micro;
  if (size <= 40) return sources.compact;
  return sources.full;
}

const frames = await Promise.all(
  sizes.map((size) =>
    sharp(sourceForSize(size), { density: 384 })
      .resize(size, size, { fit: "fill", kernel: sharp.kernel.lanczos3 })
      .png({ compressionLevel: 9, palette: false })
      .toBuffer(),
  ),
);

const png256 = frames[sizes.indexOf(256)];
for (const size of [16, 20]) {
  fs.writeFileSync(
    path.join(root, "electron", "assets", `wemail-tray-${size}.png`),
    frames[sizes.indexOf(size)],
  );
}
for (const size of [24, 32, 40]) {
  fs.writeFileSync(
    path.join(root, "electron", "assets", `wemail-compact-${size}.png`),
    frames[sizes.indexOf(size)],
  );
}
fs.writeFileSync(
  path.join(root, "electron", "assets", "wemail-256.png"),
  png256,
);
for (const size of [48, 96, 144, 192]) {
  fs.writeFileSync(
    path.join(root, "electron", "assets", `wemail-toast-${size}.png`),
    await sharp(sources.full, { density: 384 })
      .resize(size, size, { fit: "fill", kernel: sharp.kernel.lanczos3 })
      .png({ compressionLevel: 9, palette: false })
      .toBuffer(),
  );
}
fs.writeFileSync(
  path.join(root, "public", "ai-panel-logo.png"),
  await sharp(sources.full, { density: 384 })
    .resize(1024, 1024, { fit: "fill", kernel: sharp.kernel.lanczos3 })
    .png({ compressionLevel: 9, palette: false })
    .toBuffer(),
);

const ico = createIco(
  sizes.map((size, index) => ({ size, png: frames[index] })),
);
for (const output of [
  path.join(root, "electron", "assets", "wemail.ico"),
  path.join(root, "packaging", "icon.ico"),
  path.join(root, "public", "favicon.ico"),
]) {
  fs.writeFileSync(output, ico);
}
fs.copyFileSync(sourcePaths.full, path.join(root, "public", "favicon.svg"));

function createIco(images) {
  const headerSize = 6 + images.length * 16;
  const header = Buffer.alloc(headerSize);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let dataOffset = headerSize;
  images.forEach(({ size, png }, index) => {
    const entryOffset = 6 + index * 16;
    header[entryOffset] = size === 256 ? 0 : size;
    header[entryOffset + 1] = size === 256 ? 0 : size;
    header[entryOffset + 2] = 0;
    header[entryOffset + 3] = 0;
    header.writeUInt16LE(1, entryOffset + 4);
    header.writeUInt16LE(32, entryOffset + 6);
    header.writeUInt32LE(png.length, entryOffset + 8);
    header.writeUInt32LE(dataOffset, entryOffset + 12);
    dataOffset += png.length;
  });
  return Buffer.concat([header, ...images.map(({ png }) => png)]);
}
