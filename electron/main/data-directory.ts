import type { App, BrowserWindow, OpenDialogOptions } from "electron";
import { dialog } from "electron";
import fs from "node:fs";
import path from "node:path";

const LOCATION_FILE = "data-location";
const PENDING_FILE = "data-migration-pending.json";
const RESULT_FILE = "data-migration-result.json";
const DATA_ROOT_MARKER = ".wemail-data-root";

export interface DataDirectoryInfo {
  currentPath: string;
  defaultPath: string;
  custom: boolean;
  managedByEnvironment: boolean;
  lastMigration?: {
    status: "success" | "failed";
    from: string;
    to: string;
    message?: string;
  };
}

interface PendingMigration {
  from: string;
  to: string;
  requestedAt: string;
}

export type ScheduleDataMigrationResult =
  | { ok: true; restarting: true }
  | { ok: false; error: string };

function isPathRoot(value: string): boolean {
  const resolved = path.resolve(value);
  return resolved === path.parse(resolved).root;
}

function pathsOverlap(first: string, second: string): boolean {
  const a = path.resolve(first);
  const b = path.resolve(second);
  const relativeAB = path.relative(a, b);
  const relativeBA = path.relative(b, a);
  return (
    relativeAB === "" ||
    (!relativeAB.startsWith("..") && !path.isAbsolute(relativeAB)) ||
    (!relativeBA.startsWith("..") && !path.isAbsolute(relativeBA))
  );
}

function isSameOrAncestor(candidate: string, protectedPath: string): boolean {
  const relative = path.relative(path.resolve(candidate), path.resolve(protectedPath));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function readText(filePath: string): string | undefined {
  try {
    const value = fs.readFileSync(filePath, "utf8").trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(temporaryPath, filePath);
}

function writeLocationAtomic(controlDir: string, dataDir: string): void {
  fs.mkdirSync(controlDir, { recursive: true });
  const locationPath = path.join(controlDir, LOCATION_FILE);
  const temporaryPath = `${locationPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, path.resolve(dataDir), "utf8");
  fs.renameSync(temporaryPath, locationPath);
}

function directoryEntries(directory: string): string[] {
  try {
    return fs.readdirSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function directoryFingerprint(directory: string): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  const visit = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath);
      } else if (entry.isFile()) {
        const stat = fs.statSync(entryPath);
        files += 1;
        bytes += stat.size;
      }
    }
  };
  if (fs.existsSync(directory)) visit(directory);
  return { files, bytes };
}

export function resolveDataDirectory(controlDir: string): string {
  if (process.env.WEMAIL_DATA_DIR) {
    return path.resolve(process.env.WEMAIL_DATA_DIR);
  }
  const configured = readText(path.join(controlDir, LOCATION_FILE));
  if (configured && path.isAbsolute(configured) && !isPathRoot(configured)) {
    return path.resolve(configured);
  }
  return path.join(controlDir, "data");
}

export function ensureDataDirectoryMarker(dataDir: string): void {
  fs.mkdirSync(dataDir, { recursive: true });
  const markerPath = path.join(dataDir, DATA_ROOT_MARKER);
  if (!fs.existsSync(markerPath)) {
    fs.writeFileSync(markerPath, "com.wemail.app\n", { flag: "wx" });
  }
}

export function applyPendingDataMigration(controlDir: string): void {
  const pendingPath = path.join(controlDir, PENDING_FILE);
  if (!fs.existsSync(pendingPath)) return;

  let pending: PendingMigration | undefined;
  let stagingPath: string | undefined;
  try {
    pending = JSON.parse(fs.readFileSync(pendingPath, "utf8")) as PendingMigration;
    if (
      !pending ||
      !path.isAbsolute(pending.from) ||
      !path.isAbsolute(pending.to) ||
      isPathRoot(pending.from) ||
      isPathRoot(pending.to) ||
      isSameOrAncestor(pending.from, controlDir) ||
      pathsOverlap(pending.from, pending.to)
    ) {
      throw new Error("迁移路径无效或目录互相包含");
    }
    if (
      fs.existsSync(pending.from) &&
      !fs.existsSync(path.join(pending.from, DATA_ROOT_MARKER))
    ) {
      throw new Error("原目录缺少 WeMail 数据标记，为保护文件已取消迁移");
    }
    if (directoryEntries(pending.to).length > 0) {
      throw new Error("目标目录不再为空，迁移已取消");
    }
    fs.mkdirSync(pending.to, { recursive: true });
    stagingPath = path.join(pending.to, ".wemail-migration-staging");
    fs.mkdirSync(stagingPath);
    const sourceFingerprint = directoryFingerprint(pending.from);
    const targetVolume = fs.statfsSync(pending.to);
    const availableBytes = targetVolume.bavail * targetVolume.bsize;
    if (availableBytes < sourceFingerprint.bytes) {
      throw new Error("目标磁盘可用空间不足，迁移已取消");
    }
    if (fs.existsSync(pending.from)) {
      fs.cpSync(pending.from, stagingPath, {
        recursive: true,
        force: false,
        errorOnExist: true,
      });
    }
    const targetFingerprint = directoryFingerprint(stagingPath);
    if (
      sourceFingerprint.files !== targetFingerprint.files ||
      sourceFingerprint.bytes !== targetFingerprint.bytes
    ) {
      throw new Error("迁移后的文件数量或大小校验失败");
    }
    for (const entry of fs.readdirSync(stagingPath)) {
      fs.renameSync(path.join(stagingPath, entry), path.join(pending.to, entry));
    }
    fs.rmdirSync(stagingPath);
    writeLocationAtomic(controlDir, pending.to);
    let cleanupMessage: string | undefined;
    try {
      if (fs.existsSync(pending.from)) {
        fs.rmSync(pending.from, { recursive: true, force: false });
      }
    } catch (error) {
      cleanupMessage = `新目录已启用，但旧目录未能自动清理：${error instanceof Error ? error.message : String(error)}`;
    }
    writeJsonAtomic(path.join(controlDir, RESULT_FILE), {
      status: "success",
      from: pending.from,
      to: pending.to,
      ...(cleanupMessage ? { message: cleanupMessage } : {}),
    });
  } catch (error) {
    if (stagingPath) {
      fs.rmSync(stagingPath, {
        recursive: true,
        force: true,
      });
    }
    writeJsonAtomic(path.join(controlDir, RESULT_FILE), {
      status: "failed",
      from: pending?.from ?? "",
      to: pending?.to ?? "",
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    fs.rmSync(pendingPath, { force: true });
  }
}

export class DataDirectoryController {
  constructor(
    private readonly app: App,
    private readonly getWindow: () => BrowserWindow | null,
    private readonly requestRestart: () => void,
  ) {}

  getInfo(): DataDirectoryInfo {
    const controlDir = this.app.getPath("userData");
    const currentPath = resolveDataDirectory(controlDir);
    let lastMigration: DataDirectoryInfo["lastMigration"];
    try {
      lastMigration = JSON.parse(
        fs.readFileSync(path.join(controlDir, RESULT_FILE), "utf8"),
      ) as DataDirectoryInfo["lastMigration"];
    } catch {
      lastMigration = undefined;
    }
    return {
      currentPath,
      defaultPath: path.join(controlDir, "data"),
      custom: path.resolve(currentPath) !== path.resolve(path.join(controlDir, "data")),
      managedByEnvironment: !!process.env.WEMAIL_DATA_DIR_MANAGED,
      ...(lastMigration ? { lastMigration } : {}),
    };
  }

  async chooseDirectory(): Promise<{ canceled: boolean; path?: string }> {
    const options: OpenDialogOptions = {
      title: "选择 WeMail 数据目录",
      defaultPath: path.dirname(this.getInfo().currentPath),
      buttonLabel: "选择此目录",
      properties: ["openDirectory", "createDirectory"],
    };
    const window = this.getWindow();
    const result = await (window
      ? dialog.showOpenDialog(window, options)
      : dialog.showOpenDialog(options));
    return result.canceled || !result.filePaths[0]
      ? { canceled: true }
      : { canceled: false, path: result.filePaths[0] };
  }

  scheduleMigration(target: unknown): ScheduleDataMigrationResult {
    if (typeof target !== "string" || !path.isAbsolute(target)) {
      return { ok: false, error: "请选择有效的绝对路径" };
    }
    if (process.env.WEMAIL_DATA_DIR_MANAGED) {
      return { ok: false, error: "数据目录由启动环境管理，无法在应用内修改" };
    }
    const controlDir = this.app.getPath("userData");
    const from = resolveDataDirectory(controlDir);
    const to = path.resolve(target);
    if (isPathRoot(to)) {
      return { ok: false, error: "不能直接使用磁盘根目录，请选择一个专用文件夹" };
    }
    if (pathsOverlap(from, to)) {
      return { ok: false, error: "新旧数据目录不能相同或互相包含" };
    }
    if (!fs.existsSync(path.join(from, DATA_ROOT_MARKER))) {
      return { ok: false, error: "当前目录缺少 WeMail 数据标记，无法安全迁移" };
    }
    try {
      fs.mkdirSync(to, { recursive: true });
      if (directoryEntries(to).length > 0) {
        return { ok: false, error: "目标目录必须为空，请新建或选择一个空文件夹" };
      }
      const probePath = path.join(to, `.wemail-write-probe-${process.pid}`);
      fs.writeFileSync(probePath, "", { flag: "wx" });
      fs.rmSync(probePath);
      writeJsonAtomic(path.join(controlDir, PENDING_FILE), {
        from,
        to,
        requestedAt: new Date().toISOString(),
      } satisfies PendingMigration);
      this.requestRestart();
      return { ok: true, restarting: true };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
