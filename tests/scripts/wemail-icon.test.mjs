import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const svgPath = path.join(root, "electron", "assets", "wemail-icon.svg");
const pngPath = path.join(root, "electron", "assets", "wemail-256.png");
const runtimeIcoPath = path.join(root, "electron", "assets", "wemail.ico");
const packageIcoPath = path.join(root, "packaging", "icon.ico");
const renderScriptPath = path.join(root, "scripts", "render-wemail-icon.mjs");

test("WeMail icon has a deterministic saddle-orange SVG master", () => {
  const svg = fs.readFileSync(svgPath, "utf8");
  assert.match(svg, /viewBox="0 0 256 256"/);
  assert.match(svg, /#D65A24/i);
  assert.match(svg, /#FFF9F0/i);
  assert.match(svg, /id="upper-w-seam"/);
  assert.match(svg, /id="lower-envelope-seams"/);
  assert.equal(fs.existsSync(renderScriptPath), true);
});

test("rendered PNG is a 256px alpha image", () => {
  const png = fs.readFileSync(pngPath);
  assert.deepEqual([...png.subarray(0, 8)], [
    137, 80, 78, 71, 13, 10, 26, 10,
  ]);
  assert.equal(png.readUInt32BE(16), 256);
  assert.equal(png.readUInt32BE(20), 256);
  assert.equal(png[25], 6, "PNG must use RGBA color type");
});

test("runtime and packaging ICOs contain the required Windows sizes", () => {
  const runtime = fs.readFileSync(runtimeIcoPath);
  const packaged = fs.readFileSync(packageIcoPath);
  assert.equal(
    crypto.createHash("sha256").update(runtime).digest("hex"),
    crypto.createHash("sha256").update(packaged).digest("hex"),
  );
  assert.equal(runtime.readUInt16LE(0), 0);
  assert.equal(runtime.readUInt16LE(2), 1);
  const count = runtime.readUInt16LE(4);
  const sizes = new Set();
  for (let index = 0; index < count; index += 1) {
    const offset = 6 + index * 16;
    sizes.add(runtime[offset] === 0 ? 256 : runtime[offset]);
  }
  for (const required of [16, 20, 24, 32, 40, 48, 64, 128, 256]) {
    assert.equal(sizes.has(required), true, `missing ${required}px ICO frame`);
  }
});
