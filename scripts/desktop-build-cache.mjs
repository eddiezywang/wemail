import fs from "node:fs";
import path from "node:path";

export function resolveDesktopBuildCacheRoot({ root = process.cwd(), platform = process.platform, env = process.env, exists = fs.existsSync } = {}) {
  const platformPath = platform === "win32" ? path.win32 : path;
  if (env.WEMAIL_BUILD_CACHE?.trim()) return platformPath.resolve(env.WEMAIL_BUILD_CACHE.trim());
  if (platform === "win32" && exists("E:\\")) return "E:\\wemail-build-cache";
  return platformPath.join(platformPath.resolve(root), "workspace", "cache", "desktop");
}

export function ensureDesktopBuildCacheRoot(options = {}) {
  const cacheRoot = resolveDesktopBuildCacheRoot(options);
  fs.mkdirSync(cacheRoot, { recursive: true });
  const probe = path.join(cacheRoot, `.write-test-${process.pid}-${Date.now()}`);
  try { fs.writeFileSync(probe, "ok"); }
  catch (error) { throw new Error(`Desktop build cache is not writable: ${cacheRoot}`, { cause: error }); }
  finally { fs.rmSync(probe, { force: true }); }
  return cacheRoot;
}
