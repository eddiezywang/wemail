import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import yauzl from "yauzl";
import type { SkillPackageVersion } from "../../../shared/wemail/skillCenter.js";
import { SkillCenterService } from "./SkillCenterService.js";
import {
  SkillPackageValidator,
  type SkillPackageValidationResult,
} from "./SkillPackageValidator.js";

const MAX_ENTRIES = 500;
const MAX_ENTRY_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 10 * 1024 * 1024;
const MAX_EXPANSION_RATIO = 100;

export class SkillPackageImportService {
  private readonly validator = new SkillPackageValidator();

  constructor(private readonly skills: SkillCenterService) {}

  async importPath(sourcePath: string): Promise<SkillPackageVersion> {
    return this.withPreparedPackage(sourcePath, (directory) =>
      this.skills.installPersonalFromDirectory(directory, "import"),
    );
  }

  async previewPath(sourcePath: string): Promise<SkillPackageValidationResult> {
    return this.withPreparedPackage(sourcePath, (directory) =>
      this.validator.validateDirectory(directory, { scope: "personal" }),
    );
  }

  async importConfirmed(
    sourcePath: string,
    contentHash: string,
  ): Promise<SkillPackageVersion> {
    return this.withPreparedPackage(sourcePath, (directory) => {
      const validation = this.validator.validateDirectory(directory, {
        scope: "personal",
      });
      if (
        !validation.valid ||
        !validation.contentHash ||
        validation.contentHash !== contentHash
      ) {
        throw new Error("skill-import-confirmation-hash-mismatch");
      }
      const installed = this.skills.installPersonalFromDirectory(
        directory,
        "import",
      );
      if (installed.manifest.contentHash !== contentHash) {
        throw new Error("skill-import-post-install-verification-failed");
      }
      return installed;
    });
  }

  private async withPreparedPackage<T>(
    sourcePath: string,
    operation: (directory: string) => T | Promise<T>,
  ): Promise<T> {
    const source = path.resolve(sourcePath);
    if (!fs.existsSync(source)) throw new Error("skill-import-source-not-found");
    const stat = fs.lstatSync(source);
    if (stat.isSymbolicLink()) throw new Error("skill-import-link-forbidden");
    if (stat.isDirectory()) {
      return operation(source);
    }
    if (!stat.isFile() || path.extname(source).toLowerCase() !== ".zip") {
      throw new Error("skill-import-source-unsupported");
    }

    const staging = fs.mkdtempSync(
      path.join(os.tmpdir(), "wemail-skill-import-"),
    );
    try {
      await extractZipSafely(source, staging);
      return operation(resolveExtractedPackageRoot(staging));
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
  }
}

export async function extractZipSafely(
  zipPath: string,
  destination: string,
): Promise<void> {
  const root = path.resolve(destination);
  fs.mkdirSync(root, { recursive: true });
  const zip = await openZip(zipPath);
  let entries = 0;
  let totalBytes = 0;

  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        if (error) reject(error);
        else resolve();
      };
      zip.on("error", finish);
      zip.on("end", () => finish());
      zip.on("entry", (entry) => {
        void (async () => {
          try {
            entries += 1;
            if (entries > MAX_ENTRIES) {
              throw new Error("skill-archive-too-many-entries");
            }
            const relative = validateSkillZipEntry(entry.fileName);
            if (isZipSymlink(entry.externalFileAttributes)) {
              throw new Error("skill-archive-link-forbidden");
            }
            if (entry.uncompressedSize > MAX_ENTRY_BYTES) {
              throw new Error("skill-archive-entry-too-large");
            }
            totalBytes += entry.uncompressedSize;
            if (totalBytes > MAX_TOTAL_BYTES) {
              throw new Error("skill-archive-too-large");
            }
            if (
              entry.uncompressedSize > 1024 * 1024 &&
              entry.compressedSize > 0 &&
              entry.uncompressedSize / entry.compressedSize >
                MAX_EXPANSION_RATIO
            ) {
              throw new Error("skill-archive-expansion-ratio-too-high");
            }

            const target = path.resolve(root, ...relative.split("/"));
            if (!isInside(root, target)) {
              throw new Error("skill-archive-path-outside-staging");
            }
            if (entry.fileName.endsWith("/")) {
              fs.mkdirSync(target, { recursive: true });
              zip.readEntry();
              return;
            }

            fs.mkdirSync(path.dirname(target), { recursive: true });
            const readStream = await openEntryStream(zip, entry);
            await pipeline(
              readStream,
              fs.createWriteStream(target, {
                flags: "wx",
                mode: 0o600,
              }),
            );
            zip.readEntry();
          } catch (error) {
            finish(error);
          }
        })();
      });
      zip.readEntry();
    });
  } finally {
    zip.close();
  }
}

function resolveExtractedPackageRoot(staging: string): string {
  if (fs.existsSync(path.join(staging, "SKILL.md"))) return staging;
  const directories = fs
    .readdirSync(staging, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(staging, entry.name))
    .filter((directory) => fs.existsSync(path.join(directory, "SKILL.md")));
  if (directories.length !== 1) {
    throw new Error("skill-archive-package-root-ambiguous");
  }
  return directories[0]!;
}

export function validateSkillZipEntry(fileName: string): string {
  if (
    !fileName ||
    fileName.includes("\0") ||
    fileName.includes("\\") ||
    fileName.startsWith("/") ||
    /^[a-zA-Z]:/.test(fileName)
  ) {
    throw new Error("skill-archive-entry-path-invalid");
  }
  const normalized = path.posix.normalize(fileName);
  if (
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../")
  ) {
    throw new Error("skill-archive-entry-path-invalid");
  }
  return normalized.replace(/\/$/, "");
}

function isZipSymlink(externalAttributes: number): boolean {
  const unixMode = (externalAttributes >>> 16) & 0xffff;
  return (unixMode & 0xf000) === 0xa000;
}

function isInside(root: string, candidate: string): boolean {
  return (
    candidate === root ||
    candidate.startsWith(`${root}${path.sep}`)
  );
}

function openZip(file: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, autoClose: false }, (error, zip) => {
      if (error || !zip) reject(error ?? new Error("skill-archive-open-failed"));
      else resolve(zip);
    });
  });
}

function openEntryStream(
  zip: yauzl.ZipFile,
  entry: yauzl.Entry,
): Promise<NodeJS.ReadableStream> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error || !stream) {
        reject(error ?? new Error("skill-archive-entry-open-failed"));
      } else {
        resolve(stream);
      }
    });
  });
}
