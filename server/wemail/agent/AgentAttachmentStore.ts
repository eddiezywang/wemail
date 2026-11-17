import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import yauzl from "yauzl";
import sharp from "sharp";
import type { MailDatabase } from "../database/Database.js";
import { extractPdfText } from "./pdfText.js";

export const AGENT_ATTACHMENT_LIMITS = Object.freeze({
  maxFiles: 10,
  maxFileBytes: 25 * 1024 * 1024,
  maxMessageBytes: 50 * 1024 * 1024,
  maxPdfPages: 200,
  maxFileCharacters: 200_000,
  maxMessageCharacters: 400_000,
});

export type AgentAttachmentSource =
  | { type: "local"; filePath: string; name?: string; mediaType?: string }
  | {
      type: "mail";
      emailId: string;
      attachmentId: string;
      name: string;
      mediaType: string;
      sizeBytes?: number;
      load: () => Promise<Buffer>;
    };

export interface AgentAttachmentRecord {
  id: string;
  accountId: string;
  sourceKey: string;
  sourceType: "local" | "mail";
  name: string;
  mediaType: string;
  sizeBytes: number;
  sha256: string;
  relativePath: string;
  extractedRelativePath?: string;
  thumbnailRelativePath?: string;
  imageWidth?: number;
  imageHeight?: number;
  characterCount: number;
  reused: boolean;
}

interface AttachmentRow {
  id: string;
  account_id: string;
  source_key: string;
  source_type: "local" | "mail";
  name: string;
  media_type: string;
  size_bytes: number;
  sha256: string;
  relative_path: string;
  extracted_relative_path: string | null;
  thumbnail_relative_path: string | null;
  image_width: number | null;
  image_height: number | null;
  character_count: number;
  parse_state: string;
}

export class AgentAttachmentError extends Error {
  constructor(readonly code: string, message = code) {
    super(message);
    this.name = "AgentAttachmentError";
  }
}

export class AgentAttachmentStore {
  private readonly inFlight = new Map<string, Promise<AgentAttachmentRecord>>();

  constructor(
    private readonly db: MailDatabase,
    private readonly rootDir: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async intakeMany(
    accountId: string,
    sources: AgentAttachmentSource[],
    messageId?: string,
  ): Promise<AgentAttachmentRecord[]> {
    if (sources.length > AGENT_ATTACHMENT_LIMITS.maxFiles) {
      throw new AgentAttachmentError("attachment-count-limit", "最多只能添加 10 个附件");
    }
    const declaredSizes = await Promise.all(sources.map(async (source) =>
      source.type === "local" ? (await fs.stat(source.filePath)).size : source.sizeBytes ?? 0,
    ));
    if (declaredSizes.some((size) => size > AGENT_ATTACHMENT_LIMITS.maxFileBytes)) {
      throw new AgentAttachmentError("attachment-file-size-limit", "单个附件不能超过 25 MB");
    }
    if (declaredSizes.reduce((sum, size) => sum + size, 0) > AGENT_ATTACHMENT_LIMITS.maxMessageBytes) {
      throw new AgentAttachmentError("attachment-total-size-limit", "附件总大小不能超过 50 MB");
    }
    const records: AgentAttachmentRecord[] = [];
    for (const source of sources) records.push(await this.intake(accountId, source));
    if (records.reduce((sum, item) => sum + item.sizeBytes, 0) > AGENT_ATTACHMENT_LIMITS.maxMessageBytes) {
      throw new AgentAttachmentError("attachment-total-size-limit", "附件总大小不能超过 50 MB");
    }
    if (records.reduce((sum, item) => sum + item.characterCount, 0) > AGENT_ATTACHMENT_LIMITS.maxMessageCharacters) {
      throw new AgentAttachmentError("attachment-total-character-limit", "附件提取文本总量超过 400,000 字符");
    }
    if (messageId) records.forEach((record, index) => this.addReference(record.id, messageId, index));
    return records;
  }

  async intake(accountId: string, source: AgentAttachmentSource): Promise<AgentAttachmentRecord> {
    const descriptor = await this.describeSource(source);
    const flightKey = `${accountId}\0${descriptor.sourceKey}`;
    const pending = this.inFlight.get(flightKey);
    if (pending) return pending;
    const operation = this.performIntake(accountId, source, descriptor).finally(() => {
      this.inFlight.delete(flightKey);
    });
    this.inFlight.set(flightKey, operation);
    return operation;
  }

  async revalidateForSend(accountId: string, attachmentIds: string[]): Promise<AgentAttachmentRecord[]> {
    const records: AgentAttachmentRecord[] = [];
    for (const id of attachmentIds) {
      const row = this.db.prepare(
        "SELECT * FROM agent_attachments WHERE id = ? AND account_id = ? AND parse_state = 'ready'",
      ).get(id, accountId) as AttachmentRow | undefined;
      if (!row) throw new AgentAttachmentError("attachment-not-ready");
      const absolute = this.absoluteManagedPath(row.relative_path);
      let bytes: Buffer;
      try {
        bytes = await fs.readFile(absolute);
      } catch {
        throw new AgentAttachmentError("attachment-unreadable");
      }
      if (bytes.byteLength !== row.size_bytes || digest(bytes) !== row.sha256) {
        throw new AgentAttachmentError("attachment-integrity-failed");
      }
      records.push(toRecord(row, true));
    }
    return records;
  }

  addReference(attachmentId: string, messageId: string, position: number): void {
    this.db.transaction(() => {
      this.db.prepare(
        `INSERT INTO agent_attachment_refs (attachment_id, message_id, position)
         VALUES (?, ?, ?)
         ON CONFLICT(attachment_id, message_id) DO UPDATE SET position = excluded.position`,
      ).run(attachmentId, messageId, position);
      this.db.prepare("UPDATE agent_attachments SET unreferenced_at = NULL WHERE id = ?").run(attachmentId);
    })();
  }

  removeMessageReferences(messageId: string): void {
    const ids = this.db.prepare(
      "SELECT attachment_id FROM agent_attachment_refs WHERE message_id = ?",
    ).all(messageId) as Array<{ attachment_id: string }>;
    const now = this.now().toISOString();
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM agent_attachment_refs WHERE message_id = ?").run(messageId);
      const mark = this.db.prepare(
        `UPDATE agent_attachments SET unreferenced_at = ?
          WHERE id = ? AND NOT EXISTS (
            SELECT 1 FROM agent_attachment_refs WHERE attachment_id = agent_attachments.id
          )`,
      );
      ids.forEach(({ attachment_id }) => mark.run(now, attachment_id));
    })();
  }

  async cleanup(): Promise<{ parts: number; orphans: number }> {
    const partCutoff = this.now().getTime() - 24 * 60 * 60_000;
    let parts = 0;
    for (const file of await walkFiles(this.rootDir)) {
      if (!path.basename(file).includes(".part")) continue;
      try {
        const stat = await fs.stat(file);
        if (stat.mtimeMs <= partCutoff) {
          await fs.unlink(file);
          parts += 1;
        }
      } catch {
        // Concurrent cleanup or inaccessible file.
      }
    }
    const orphanCutoff = new Date(this.now().getTime() - 7 * 24 * 60 * 60_000).toISOString();
    const rows = this.db.prepare(
      `SELECT * FROM agent_attachments
        WHERE unreferenced_at IS NOT NULL AND unreferenced_at <= ?
          AND NOT EXISTS (SELECT 1 FROM agent_attachment_refs r WHERE r.attachment_id = agent_attachments.id)`,
    ).all(orphanCutoff) as AttachmentRow[];
    for (const row of rows) {
      await fs.rm(path.dirname(this.absoluteManagedPath(row.relative_path)), { recursive: true, force: true });
      this.db.prepare("DELETE FROM agent_attachments WHERE id = ?").run(row.id);
    }
    return { parts, orphans: rows.length };
  }

  async clearAll(): Promise<void> {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM agent_attachment_refs").run();
      this.db.prepare("DELETE FROM agent_attachments").run();
    })();
    await fs.rm(this.rootDir, { recursive: true, force: true });
  }

  private async performIntake(
    accountId: string,
    source: AgentAttachmentSource,
    descriptor: Awaited<ReturnType<AgentAttachmentStore["describeSource"]>>,
  ): Promise<AgentAttachmentRecord> {
    const existing = this.db.prepare(
      "SELECT * FROM agent_attachments WHERE account_id = ? AND source_key = ? AND parse_state = 'ready'",
    ).get(accountId, descriptor.sourceKey) as AttachmentRow | undefined;
    if (existing) {
      try {
        const bytes = await fs.readFile(this.absoluteManagedPath(existing.relative_path));
        if (bytes.byteLength === existing.size_bytes && digest(bytes) === existing.sha256) {
          this.db.prepare(
            "UPDATE agent_attachments SET unreferenced_at = ?, updated_at = ? WHERE id = ?",
          ).run(this.now().toISOString(), this.now().toISOString(), existing.id);
          return toRecord(existing, true);
        }
      } catch {
        // Replace a missing or damaged canonical file below.
      }
    }

    const bytes = source.type === "local"
      ? await fs.readFile(source.filePath).catch(() => { throw new AgentAttachmentError("attachment-unreadable"); })
      : Buffer.from(await source.load());
    if (bytes.byteLength > AGENT_ATTACHMENT_LIMITS.maxFileBytes) {
      throw new AgentAttachmentError("attachment-file-size-limit", "单个附件不能超过 25 MB");
    }
    const mediaType = supportedMediaType(descriptor.name, descriptor.mediaType);
    const extracted = await extractAttachmentText(bytes, mediaType);
    if (extracted.length > AGENT_ATTACHMENT_LIMITS.maxFileCharacters) {
      throw new AgentAttachmentError("attachment-character-limit", "单个附件提取文本超过 200,000 字符");
    }
    if (mediaType === "application/pdf" && extracted.trim().length === 0) {
      throw new AgentAttachmentError("attachment-ocr-required", "暂不支持仅包含扫描图片的 PDF");
    }

    const hash = digest(bytes);
    const relativeDir = path.posix.join(
      "attachments",
      digest(Buffer.from(accountId)).slice(0, 24),
      digest(Buffer.from(descriptor.sourceKey)).slice(0, 32),
    );
    const relativePath = path.posix.join(relativeDir, "content");
    const extractedRelativePath = extracted.length > 0
      ? path.posix.join(relativeDir, "extracted.txt")
      : undefined;
    const image = mediaType.startsWith("image/")
      ? await inspectAndThumbnail(bytes)
      : undefined;
    const thumbnailRelativePath = image
      ? path.posix.join(relativeDir, "thumbnail.webp")
      : undefined;
    const absoluteDir = this.absoluteManagedPath(relativeDir);
    const contentPart = path.join(absoluteDir, `content.${randomUUID()}.part`);
    await fs.mkdir(absoluteDir, { recursive: true });
    try {
      await fs.writeFile(contentPart, bytes, { flag: "wx" });
      const verification = await fs.readFile(contentPart);
      if (verification.byteLength !== bytes.byteLength || digest(verification) !== hash) {
        throw new AgentAttachmentError("attachment-integrity-failed");
      }
      if (existing) await fs.unlink(this.absoluteManagedPath(relativePath)).catch(() => {});
      await fs.rename(contentPart, this.absoluteManagedPath(relativePath));
      if (extractedRelativePath) {
        const textPart = path.join(absoluteDir, `extracted.${randomUUID()}.part`);
        await fs.writeFile(textPart, extracted, "utf8");
        await fs.rename(textPart, this.absoluteManagedPath(extractedRelativePath));
      }
      if (image && thumbnailRelativePath) {
        const thumbnailPart = path.join(absoluteDir, `thumbnail.${randomUUID()}.part`);
        await fs.writeFile(thumbnailPart, image.thumbnail);
        await fs.rename(thumbnailPart, this.absoluteManagedPath(thumbnailRelativePath));
      }
      const id = existing?.id ?? `attachment-${randomUUID()}`;
      const now = this.now().toISOString();
      this.db.prepare(
        `INSERT INTO agent_attachments (
           id, account_id, source_key, source_type, source_json, name, media_type,
           size_bytes, sha256, relative_path, parse_state, extracted_relative_path,
           character_count, thumbnail_relative_path, image_width, image_height,
           created_at, updated_at, unreferenced_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(account_id, source_key) DO UPDATE SET
           source_type = excluded.source_type, source_json = excluded.source_json,
           name = excluded.name, media_type = excluded.media_type,
           size_bytes = excluded.size_bytes, sha256 = excluded.sha256,
           relative_path = excluded.relative_path, parse_state = 'ready', parse_error = NULL,
           extracted_relative_path = excluded.extracted_relative_path,
           thumbnail_relative_path = excluded.thumbnail_relative_path,
           image_width = excluded.image_width, image_height = excluded.image_height,
           character_count = excluded.character_count, updated_at = excluded.updated_at`,
      ).run(
        id, accountId, descriptor.sourceKey, source.type,
        JSON.stringify(descriptor.sourceMetadata), descriptor.name, mediaType,
        bytes.byteLength, hash, relativePath, extractedRelativePath ?? null,
        extracted.length, thumbnailRelativePath ?? null,
        image?.width ?? null, image?.height ?? null, now, now, now,
      );
      const row = this.db.prepare(
        "SELECT * FROM agent_attachments WHERE account_id = ? AND source_key = ?",
      ).get(accountId, descriptor.sourceKey) as AttachmentRow;
      return toRecord(row, false);
    } finally {
      await fs.unlink(contentPart).catch(() => {});
    }
  }

  private async describeSource(source: AgentAttachmentSource) {
    if (source.type === "mail") {
      return {
        sourceKey: `mail:${source.emailId}:${source.attachmentId}`,
        name: source.name,
        mediaType: source.mediaType,
        sourceMetadata: { emailId: source.emailId, attachmentId: source.attachmentId },
      };
    }
    const absolute = path.resolve(source.filePath);
    const stat = await fs.stat(absolute).catch(() => { throw new AgentAttachmentError("attachment-unreadable"); });
    return {
      sourceKey: `local:${normalizePath(absolute)}:${stat.size}:${stat.mtimeMs}`,
      name: source.name ?? path.basename(absolute),
      mediaType: source.mediaType ?? "",
      sourceMetadata: { originalName: source.name ?? path.basename(absolute) },
    };
  }

  private absoluteManagedPath(relativePath: string): string {
    const root = path.resolve(this.rootDir);
    const resolved = path.resolve(root, ...relativePath.split("/"));
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
      throw new AgentAttachmentError("attachment-path-escape");
    }
    return resolved;
  }
}

function toRecord(row: AttachmentRow, reused: boolean): AgentAttachmentRecord {
  return {
    id: row.id,
    accountId: row.account_id,
    sourceKey: row.source_key,
    sourceType: row.source_type,
    name: row.name,
    mediaType: row.media_type,
    sizeBytes: row.size_bytes,
    sha256: row.sha256,
    relativePath: row.relative_path,
    ...(row.extracted_relative_path ? { extractedRelativePath: row.extracted_relative_path } : {}),
    ...(row.thumbnail_relative_path ? { thumbnailRelativePath: row.thumbnail_relative_path } : {}),
    ...(row.image_width ? { imageWidth: row.image_width } : {}),
    ...(row.image_height ? { imageHeight: row.image_height } : {}),
    characterCount: row.character_count,
    reused,
  };
}

function normalizePath(filePath: string): string {
  return process.platform === "win32" ? filePath.replaceAll("\\", "/").toLowerCase() : filePath;
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function supportedMediaType(name: string, declared: string): string {
  const extension = path.extname(name).toLowerCase();
  const mediaType = declared.toLowerCase().split(";", 1)[0]!.trim();
  if (mediaType.startsWith("image/") && ![".svg"].includes(extension)) return mediaType;
  if (mediaType === "text/plain" || extension === ".txt") return "text/plain";
  if (mediaType === "text/markdown" || [".md", ".markdown"].includes(extension)) return "text/markdown";
  if (mediaType === "application/pdf" || extension === ".pdf") return "application/pdf";
  if (mediaType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" || extension === ".docx") {
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  }
  throw new AgentAttachmentError("attachment-format-unsupported", "仅支持图片、TXT、Markdown、PDF 和 DOCX");
}

async function extractAttachmentText(bytes: Buffer, mediaType: string): Promise<string> {
  try {
    if (mediaType.startsWith("image/")) return "";
    if (mediaType === "text/plain" || mediaType === "text/markdown") {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    }
    if (mediaType === "application/pdf") {
      return await extractPdfText(bytes, {
        maxPages: AGENT_ATTACHMENT_LIMITS.maxPdfPages,
        maxCharacters: AGENT_ATTACHMENT_LIMITS.maxFileCharacters + 1,
      });
    }
    return await extractDocxText(bytes);
  } catch (error) {
    if (error instanceof AgentAttachmentError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("pdf-page-limit-exceeded")) {
      throw new AgentAttachmentError("attachment-pdf-page-limit", "PDF 不能超过 200 页");
    }
    if (message.includes("character-limit")) throw error;
    throw new AgentAttachmentError("attachment-parse-failed", "附件损坏、加密或无法解析");
  }
}

async function inspectAndThumbnail(bytes: Buffer): Promise<{
  width: number;
  height: number;
  thumbnail: Buffer;
}> {
  try {
    const image = sharp(bytes, { failOn: "error", limitInputPixels: 40_000_000 });
    const metadata = await image.metadata();
    const width = metadata.width ?? 0;
    const height = metadata.height ?? 0;
    if (width <= 0 || height <= 0 || width > 20_000 || height > 20_000) {
      throw new AgentAttachmentError("attachment-image-dimensions-invalid");
    }
    const thumbnail = await image
      .rotate()
      .resize({ width: 512, height: 512, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 78 })
      .toBuffer();
    return { width, height, thumbnail };
  } catch (error) {
    if (error instanceof AgentAttachmentError) throw error;
    throw new AgentAttachmentError("attachment-image-invalid", "图片损坏或尺寸不安全");
  }
}

function extractDocxText(bytes: Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(bytes, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) return reject(error ?? new Error("invalid-docx"));
      let settled = false;
      const finish = (value?: string, failure?: unknown) => {
        if (settled) return;
        settled = true;
        zip.close();
        failure ? reject(failure) : resolve(value ?? "");
      };
      zip.on("error", (failure) => finish(undefined, failure));
      zip.on("end", () => finish(undefined, new Error("docx-document-missing")));
      zip.on("entry", (entry) => {
        if (entry.fileName !== "word/document.xml") return zip.readEntry();
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) return finish(undefined, streamError ?? new Error("docx-stream"));
          const chunks: Buffer[] = [];
          stream.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
          stream.on("error", (failure) => finish(undefined, failure));
          stream.on("end", () => {
            const xml = Buffer.concat(chunks).toString("utf8");
            finish(xml
              .replace(/<w:tab\/?\s*>/g, "\t")
              .replace(/<\/w:p>/g, "\n")
              .replace(/<[^>]+>/g, "")
              .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"));
          });
        });
      });
      zip.readEntry();
    });
  });
}

async function walkFiles(root: string): Promise<string[]> {
  const output: string[] = [];
  const visit = async (directory: string) => {
    let entries: Array<import("node:fs").Dirent>;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile()) output.push(target);
    }
  };
  await visit(root);
  return output;
}
