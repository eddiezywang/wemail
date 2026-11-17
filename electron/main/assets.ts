import type { App } from "electron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function firstExisting(paths: string[]): string | undefined {
  return paths.find((candidate) => {
    try {
      return fs.existsSync(candidate);
    } catch {
      return false;
    }
  });
}

export function resolveElectronAsset(app: App, fileName: string): string | undefined {
  return firstExisting([
    path.join(process.resourcesPath, "assets", fileName),
    path.join(app.getAppPath(), "electron", "assets", fileName),
    path.join(process.cwd(), "electron", "assets", fileName),
    path.join(__dirname, "../../../electron/assets", fileName),
  ]);
}

export function getRuntimeIconPath(app: App): string | undefined {
  return resolveElectronAsset(
    app,
    process.platform === "win32" ? "wemail.ico" : "wemail-256.png",
  );
}
