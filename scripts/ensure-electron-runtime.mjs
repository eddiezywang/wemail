#!/usr/bin/env node
import { downloadArtifact } from "@electron/get";
import extract from "extract-zip";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ensureDesktopBuildCacheRoot } from "./desktop-build-cache.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
export const getElectronArtifactName = ({ version, platform, arch }) => `electron-v${version}-${platform}-${arch}.zip`;
export function getElectronRuntimePaths({ cacheRoot, version, platform, arch }) {
  const base = path.join(cacheRoot, "electron");
  return { downloads: path.join(base, "downloads"), temp: path.join(base, "temp"), runtime: path.join(base, "runtime", version, `${platform}-${arch}`), lock: path.join(base, "locks", `${version}-${platform}-${arch}.lock`) };
}
export function getElectronExecutablePath(runtime, platform) {
  if (platform === "win32") return path.join(runtime, "electron.exe");
  if (platform === "darwin") return path.join(runtime, "Electron.app", "Contents", "MacOS", "Electron");
  return path.join(runtime, "electron");
}
export function isValidElectronRuntime(runtime, { version, platform }) {
  const exe = getElectronExecutablePath(runtime, platform);
  const versionFile = path.join(runtime, "version");
  return fs.existsSync(exe) && fs.existsSync(versionFile) && fs.readFileSync(versionFile, "utf8").trim() === version;
}
async function lock(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const deadline = Date.now() + 300000;
  while (true) try {
    const handle = fs.openSync(file, "wx"); fs.writeFileSync(handle, `${process.pid}\n`);
    return () => { fs.closeSync(handle); fs.rmSync(file, { force: true }); };
  } catch (error) {
    if (error?.code !== "EEXIST" || Date.now() >= deadline) throw error;
    await sleep(500);
  }
}
async function renameRetry(from, to) {
  let last;
  for (let i = 1; i <= 20; i += 1) try { fs.renameSync(from, to); return; }
  catch (error) { last = error; if (!["EPERM", "EBUSY", "EACCES"].includes(error?.code)) throw error; await sleep(i * 250); }
  throw last;
}
function ensureDistLink({ root, runtime, version, platform }) {
  const pkg = path.join(root, "node_modules", "electron");
  const dist = path.join(pkg, "dist");
  if (!isValidElectronRuntime(dist, { version, platform })) {
    fs.rmSync(dist, { recursive: true, force: true });
    fs.symlinkSync(runtime, dist, platform === "win32" ? "junction" : "dir");
  }
  const packageExecutable = platform === "darwin"
    ? "Electron.app/Contents/MacOS/Electron"
    : platform === "win32" ? "electron.exe" : "electron";
  fs.writeFileSync(path.join(pkg, "path.txt"), packageExecutable);
  return dist;
}
export const ensureElectronDistLink = ensureDistLink;
export async function ensureElectronRuntime({ root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), platform = process.platform, arch = process.arch, env = process.env, log = console.log } = {}) {
  const version = readJson(path.join(root, "node_modules", "electron", "package.json")).version;
  const cacheRoot = ensureDesktopBuildCacheRoot({ root, platform, env });
  const paths = getElectronRuntimePaths({ cacheRoot, version, platform, arch });
  if (!isValidElectronRuntime(paths.runtime, { version, platform })) {
    const release = await lock(paths.lock);
    try { if (!isValidElectronRuntime(paths.runtime, { version, platform })) {
      fs.mkdirSync(paths.downloads, { recursive: true }); fs.mkdirSync(paths.temp, { recursive: true });
      const artifactName = getElectronArtifactName({ version, platform, arch });
      const zip = await downloadArtifact({ version, artifactName: "electron", platform, arch, cacheRoot: paths.downloads, tempDirectory: paths.temp, checksums: readJson(path.join(root, "node_modules", "electron", "checksums.json")), mirrorOptions: { mirror: env.ELECTRON_MIRROR || "https://npmmirror.com/mirrors/electron/" }, downloadOptions: { timeout: { request: 180000 }, retry: { limit: 2 } } });
      const staging = `${paths.runtime}.partial-${process.pid}`; fs.rmSync(staging, { recursive: true, force: true }); fs.mkdirSync(staging, { recursive: true });
      try { await extract(zip, { dir: staging }); if (!isValidElectronRuntime(staging, { version, platform })) throw new Error("Incomplete Electron runtime"); fs.mkdirSync(path.dirname(paths.runtime), { recursive: true }); fs.rmSync(paths.runtime, { recursive: true, force: true }); await renameRetry(staging, paths.runtime); }
      finally { fs.rmSync(staging, { recursive: true, force: true }); }
    } } finally { release(); }
  }
  const distPath = ensureDistLink({ root, runtime: paths.runtime, version, platform });
  const executable = getElectronExecutablePath(paths.runtime, platform);
  log(`[electron-runtime] ready at ${paths.runtime}`);
  return { cacheRoot, distPath, executable, runtimePath: paths.runtime, version };
}
async function main() { const result = await ensureElectronRuntime({ log: process.argv.includes("--quiet") ? () => {} : console.log }); if (process.argv.includes("--print-exe")) console.log(result.executable); if (process.argv.includes("--print-dist")) console.log(result.distPath); }
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error(`[electron-runtime] ${e.message}`); process.exit(1); });
