import fs from "node:fs";
import path from "node:path";

export function isProductionBuildInput(root, inputPath) {
  const relative = path.relative(root, inputPath).replaceAll("\\", "/");
  if (/(^|\/)tests?(\/|$)/.test(relative)) return false;
  return !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(relative);
}

export function newestProductionMtime(root, inputPath) {
  if (!fs.existsSync(inputPath) || !isProductionBuildInput(root, inputPath)) return 0;
  const stat = fs.statSync(inputPath);
  if (stat.isFile()) return stat.mtimeMs;
  return fs.readdirSync(inputPath, { withFileTypes: true }).reduce(
    (newest, entry) => Math.max(newest, newestProductionMtime(root, path.join(inputPath, entry.name))),
    stat.mtimeMs,
  );
}
