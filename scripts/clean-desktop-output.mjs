#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

// Both directories are pure build artifacts of `build:desktop`. Cleaning them
// together before the renderer build runs prevents a partial/interrupted
// `react-router build` (which cannot empty outDir by itself) from poisoning
// the next packaging run — stale client assets without `index.html` /
// `.vite/manifest.json` make the following build crash with a manifest ENOENT.
const outputs = ["dist-electron", "build"];
for (const name of outputs) {
  const outputDirectory = path.resolve(process.cwd(), name);
  if (path.basename(outputDirectory) !== name) {
    throw new Error(`Refusing to clean an unexpected output directory: ${name}`);
  }
  fs.rmSync(outputDirectory, { recursive: true, force: true });
  console.log(`[desktop-build] cleaned ${outputDirectory}`);
}
