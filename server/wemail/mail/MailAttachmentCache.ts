import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_MEMORY_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_MEMORY_ITEM_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_DISK_MAX_BYTES = 512 * 1024 * 1024;
const DEFAULT_DISK_ITEM_MAX_BYTES = 50 * 1024 * 1024;
const HASH_PATTERN = /^[a-f0-9]{64}$/;

export type AttachmentCacheSource = "memory" | "disk" | "network";

export interface CachedAttachmentBytes {
  bytes: Buffer;
  etag: string;
  source: AttachmentCacheSource;
}

export interface MailAttachmentCacheOptions {
  rootDir?: string;
  memoryMaxBytes?: number;
  memoryItemMaxBytes?: number;
  diskMaxBytes?: number;
  diskItemMaxBytes?: number;
}

interface MemoryEntry {
  bytes: Buffer;
  etag: string;
}

interface DiskEntry {
  filePath: string;
  size: number;
  mtimeMs: number;
}

export class MailAttachmentCache {
  private readonly rootDir?: string;
  private readonly memoryMaxBytes: number;
  private readonly memoryItemMaxBytes: number;
  private readonly diskMaxBytes: number;
  private readonly diskItemMaxBytes: number;
  private readonly memory = new Map<string, MemoryEntry>();
  private readonly inFlight = new Map<string, InFlightLoad>();
  private memoryBytes = 0;

  constructor(options: MailAttachmentCacheOptions = {}) {
    this.rootDir = options.rootDir;
    this.memoryMaxBytes = options.memoryMaxBytes ?? DEFAULT_MEMORY_MAX_BYTES;
    this.memoryItemMaxBytes =
      options.memoryItemMaxBytes ?? DEFAULT_MEMORY_ITEM_MAX_BYTES;
    this.diskMaxBytes = options.diskMaxBytes ?? DEFAULT_DISK_MAX_BYTES;
    this.diskItemMaxBytes = options.diskItemMaxBytes ?? DEFAULT_DISK_ITEM_MAX_BYTES;
  }

  async getOrLoad(
    key: string,
    loader: (signal?: AbortSignal) => Promise<Buffer>,
    signal?: AbortSignal,
  ): Promise<CachedAttachmentBytes> {
    const memory = this.getMemory(key);
    if (memory) return { ...memory, source: "memory" };

    const pending = this.inFlight.get(key);
    if (pending) return this.waitForLoad(pending, signal);

    const controller = new AbortController();
    const request = this.load(key, loader, controller.signal).finally(() => {
      this.inFlight.delete(key);
    });
    const inFlight: InFlightLoad = { request, controller, waiters: 0 };
    this.inFlight.set(key, inFlight);
    return this.waitForLoad(inFlight, signal);
  }

  private async load(
    key: string,
    loader: (signal?: AbortSignal) => Promise<Buffer>,
    signal: AbortSignal,
  ): Promise<CachedAttachmentBytes> {
    const disk = await this.readDisk(key);
    if (disk) {
      this.setMemory(key, disk);
      return { ...disk, source: "disk" };
    }

    const bytes = Buffer.from(await loader(signal));
    const etag = etagFor(bytes);
    const entry = { bytes, etag };
    this.setMemory(key, entry);
    await this.writeDisk(key, bytes);
    return { ...entry, source: "network" };
  }

  private waitForLoad(
    pending: InFlightLoad,
    signal?: AbortSignal,
  ): Promise<CachedAttachmentBytes> {
    pending.waiters += 1;
    return new Promise<CachedAttachmentBytes>((resolve, reject) => {
      let settled = false;
      const removeAbortListener = () =>
        signal?.removeEventListener("abort", onAbort);
      const release = (abortIfEmpty: boolean) => {
        pending.waiters = Math.max(0, pending.waiters - 1);
        if (abortIfEmpty && pending.waiters === 0) pending.controller.abort();
      };
      const onAbort = () => {
        if (settled) return;
        settled = true;
        removeAbortListener();
        release(true);
        const error = new Error("attachment request cancelled");
        error.name = "AbortError";
        reject(error);
      };
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      pending.request.then(
        (value) => {
          if (settled) return;
          settled = true;
          removeAbortListener();
          release(false);
          resolve(value);
        },
        (error) => {
          if (settled) return;
          settled = true;
          removeAbortListener();
          release(false);
          reject(error);
        },
      );
    });
  }

  private getMemory(key: string): MemoryEntry | undefined {
    const entry = this.memory.get(key);
    if (!entry) return undefined;
    this.memory.delete(key);
    this.memory.set(key, entry);
    return entry;
  }

  private setMemory(key: string, entry: MemoryEntry): void {
    const size = entry.bytes.byteLength;
    if (size > this.memoryItemMaxBytes || size > this.memoryMaxBytes) return;
    const existing = this.memory.get(key);
    if (existing) {
      this.memoryBytes -= existing.bytes.byteLength;
      this.memory.delete(key);
    }
    this.memory.set(key, entry);
    this.memoryBytes += size;
    while (this.memoryBytes > this.memoryMaxBytes) {
      const oldestKey = this.memory.keys().next().value as string | undefined;
      if (!oldestKey) break;
      const oldest = this.memory.get(oldestKey);
      if (oldest) this.memoryBytes -= oldest.bytes.byteLength;
      this.memory.delete(oldestKey);
    }
  }

  private async readDisk(key: string): Promise<MemoryEntry | undefined> {
    if (!this.rootDir || this.diskMaxBytes <= 0 || this.diskItemMaxBytes <= 0) {
      return undefined;
    }
    const keyDir = this.keyDir(key);
    let names: string[];
    try {
      names = await fs.readdir(keyDir);
    } catch {
      return undefined;
    }
    for (const name of names) {
      const contentHash = name.endsWith(".bin") ? name.slice(0, -4) : "";
      if (!HASH_PATTERN.test(contentHash)) continue;
      const filePath = path.join(keyDir, name);
      try {
        const bytes = await fs.readFile(filePath);
        if (bytes.byteLength > this.diskItemMaxBytes || digest(bytes) !== contentHash) {
          await fs.unlink(filePath).catch(() => {});
          continue;
        }
        const now = new Date();
        await fs.utimes(filePath, now, now).catch(() => {});
        return { bytes, etag: `"sha256-${contentHash}"` };
      } catch {
        await fs.unlink(filePath).catch(() => {});
      }
    }
    return undefined;
  }

  /**
   * Return the disk file path for a cached attachment WITHOUT reading its
   * content into memory. Lets the HTTP route stream directly from disk
   * (createReadStream → pipe) instead of buffering the full bytes through
   * the worker + main process.
   */
  async getDiskPath(key: string): Promise<string | null> {
    if (!this.rootDir || this.diskMaxBytes <= 0 || this.diskItemMaxBytes <= 0) {
      return null;
    }
    const keyDir = this.keyDir(key);
    let names: string[];
    try {
      names = await fs.readdir(keyDir);
    } catch {
      return null;
    }
    for (const name of names) {
      const contentHash = name.endsWith(".bin") ? name.slice(0, -4) : "";
      if (!HASH_PATTERN.test(contentHash)) continue;
      const filePath = path.join(keyDir, name);
      try {
        const fileStat = await fs.stat(filePath);
        if (fileStat.size > this.diskItemMaxBytes) continue;
        await fs.utimes(filePath, new Date(), new Date()).catch(() => {});
        return filePath;
      } catch {
        continue;
      }
    }
    return null;
  }

  private async writeDisk(key: string, bytes: Buffer): Promise<void> {
    await this.writeDiskCore(key, bytes);
    await this.evictDisk();
  }

  /**
   * Atomic disk write under the cache's sha256 layout (the same layout
   * `getDiskPath`/`readDisk` read), WITHOUT running eviction. Split out so
   * `seed` can write from a separate process (mail-core) without racing the
   * main process's eviction pass — eviction is owned by the read-side instance.
   */
  private async writeDiskCore(key: string, bytes: Buffer): Promise<void> {
    if (
      !this.rootDir ||
      bytes.byteLength > this.diskItemMaxBytes ||
      bytes.byteLength > this.diskMaxBytes ||
      this.diskMaxBytes <= 0
    ) {
      return;
    }
    const keyDir = this.keyDir(key);
    const contentHash = digest(bytes);
    const finalPath = path.join(keyDir, `${contentHash}.bin`);
    const tempPath = path.join(keyDir, `.${randomUUID()}.tmp`);
    try {
      await fs.mkdir(keyDir, { recursive: true });
      await fs.writeFile(tempPath, bytes, { flag: "wx" });
      await fs.rename(tempPath, finalPath).catch(async (error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      });
      const names = await fs.readdir(keyDir);
      await Promise.all(
        names
          .filter((name) => name.endsWith(".bin") && name !== `${contentHash}.bin`)
          .map((name) => fs.unlink(path.join(keyDir, name)).catch(() => {})),
      );
    } catch {
      // Disk caching is best-effort. The downloaded bytes are still returned.
    } finally {
      await fs.unlink(tempPath).catch(() => {});
    }
  }

  /**
   * Pre-seed the disk cache for a key from bytes already in hand (e.g. inline
   * image bytes captured during body parse). Disk-only: does not touch the
   * in-memory LRU and does NOT evict — eviction is owned by the read-side
   * instance to avoid cross-process races. No-op when `rootDir` is unset or
   * the item exceeds size limits (same guards as an internal write). The
   * bytes are normalized to a Buffer and hashed for the filename so the
   * route's `getDiskPath`/`readDisk` find the entry.
   */
  async seed(key: string, bytes: Buffer | Uint8Array): Promise<void> {
    await this.writeDiskCore(key, Buffer.from(bytes));
  }

  private async evictDisk(): Promise<void> {
    if (!this.rootDir) return;
    let keyDirs: string[];
    try {
      keyDirs = await fs.readdir(this.rootDir);
    } catch {
      return;
    }
    const entries: DiskEntry[] = [];
    for (const keyHash of keyDirs) {
      if (!HASH_PATTERN.test(keyHash)) continue;
      const dir = path.join(this.rootDir, keyHash);
      let names: string[];
      try {
        names = await fs.readdir(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        if (!name.endsWith(".bin") || !HASH_PATTERN.test(name.slice(0, -4))) continue;
        const filePath = path.join(dir, name);
        try {
          const stat = await fs.stat(filePath);
          entries.push({ filePath, size: stat.size, mtimeMs: stat.mtimeMs });
        } catch {
          // A concurrent cleanup may have removed the file.
        }
      }
    }
    let total = entries.reduce((sum, entry) => sum + entry.size, 0);
    entries.sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const entry of entries) {
      if (total <= this.diskMaxBytes) break;
      try {
        await fs.unlink(entry.filePath);
        total -= entry.size;
        await fs.rmdir(path.dirname(entry.filePath)).catch(() => {});
      } catch {
        // Best effort; a later write will retry eviction.
      }
    }
  }

  private keyDir(key: string): string {
    return path.join(this.rootDir!, digest(Buffer.from(key, "utf8")));
  }
}

interface InFlightLoad {
  request: Promise<CachedAttachmentBytes>;
  controller: AbortController;
  waiters: number;
}

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function etagFor(bytes: Buffer): string {
  return `"sha256-${digest(bytes)}"`;
}
