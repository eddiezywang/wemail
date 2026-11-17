import { gzipSync } from "node:zlib";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const assetDirectory = path.resolve("build", "client", "assets");
const rawLimit = 750_000;
const gzipLimit = 230_000;

let assetNames;
try {
  assetNames = await readdir(assetDirectory);
} catch (error) {
  console.error(`Renderer assets are unavailable at ${assetDirectory}. Build the renderer first.`);
  throw error;
}

const workbenchAssets = assetNames.filter(
  (name) => name.startsWith("_workbench-") && name.endsWith(".js"),
);
if (workbenchAssets.length === 0) {
  throw new Error("No _workbench renderer chunk was found; the bundle budget could not be evaluated.");
}

const failures = [];
for (const assetName of workbenchAssets) {
  const source = await readFile(path.join(assetDirectory, assetName));
  const rawBytes = source.byteLength;
  const gzipBytes = gzipSync(source).byteLength;
  console.log(`${assetName}: raw ${rawBytes} B, gzip ${gzipBytes} B`);
  if (rawBytes > rawLimit || gzipBytes > gzipLimit) {
    failures.push(`${assetName} exceeds raw ${rawLimit} B or gzip ${gzipLimit} B`);
  }
}

if (failures.length > 0) {
  throw new Error(failures.join("\n"));
}
