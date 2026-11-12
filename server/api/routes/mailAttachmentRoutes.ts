import { Hono } from "hono";
import type { AppLogger } from "../../wemail/telemetry/AppLogger.js";
import type { MailAttachmentCache } from "../../wemail/mail/MailAttachmentCache.js";
import type {
  CanonicalMailRepository,
  MailAttachmentFetchDescriptor,
} from "../../wemail/mail/CanonicalMailRepository.js";
import { mailAttachmentCacheKey } from "../../../shared/wemail/mail.js";
import { createReadStream } from "node:fs";
import { stat as fsStat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";

export interface MailAttachmentGateway {
  fetchAttachment(input: {
    accountId: string;
    remoteEmailId: string;
    partPath: string;
    source?: "inline" | "download";
    viewId?: string;
    signal?: AbortSignal;
  }): Promise<{ bytes: Buffer; mediaType: string }>;
}

export interface MailAttachmentRoutesDeps {
  repository: Pick<CanonicalMailRepository, "getAttachmentFetchDescriptor">;
  cache: MailAttachmentCache;
  gateway?: MailAttachmentGateway;
  getCurrentAccountId: () => string | undefined;
  logger?: Pick<AppLogger, "error"> & Partial<Pick<AppLogger, "debug" | "info">>;
}

export function buildMailAttachmentRoutes(deps: MailAttachmentRoutesDeps) {
  const router = new Hono();

  router.get("/messages/:id/attachments/:attachmentId", async (c) => {
    if (!deps.gateway) {
      return c.json({ ok: false, error: "attachment service unavailable" }, 503);
    }
    const messageId = c.req.param("id");
    const attachmentId = c.req.param("attachmentId");
    const descriptor = deps.repository.getAttachmentFetchDescriptor(
      messageId,
      attachmentId,
    );
    const currentAccountId = deps.getCurrentAccountId();
    if (!descriptor || !currentAccountId || descriptor.accountId !== currentAccountId) {
      return c.json({ ok: false, error: "attachment not found" }, 404);
    }

    const cacheKey = mailAttachmentCacheKey(descriptor.accountId, messageId, attachmentId);
    const startedAt = Date.now();
    try {
      // Fast path: stream directly from disk (no worker, no buffer) if the
      // attachment is already cached on disk.
      const diskPath = await deps.cache.getDiskPath(cacheKey);
      if (diskPath) {
        const fileStat = await fsStat(diskPath);
        const contentHash = path.basename(diskPath, ".bin");
        const etag = `"sha256-${contentHash}"`;
        const ifNoneMatch = c.req.header("if-none-match");
        const headers = new Headers({
          "Cache-Control": "private, max-age=31536000, immutable",
          "Content-Type": descriptor.mediaType || "application/octet-stream",
          "Content-Disposition": contentDisposition(
            descriptor.disposition,
            descriptor.filename,
          ),
          "X-Content-Type-Options": "nosniff",
          "Content-Length": String(fileStat.size),
          ETag: etag,
        });
        if (matchesEtag(ifNoneMatch, etag)) {
          return new Response(null, { status: 304, headers });
        }
        deps.logger?.debug?.("mail.attachment.response", {
          source: "disk-stream",
          bytes: fileStat.size,
          durationMs: Math.max(0, Date.now() - startedAt),
        });
        // Node's stream/web ReadableStream and the DOM/undici ReadableStream
        // differ structurally (value-optional variance on read results), so
        // cast through unknown to the global ReadableStream that Response
        // accepts. Runtime is unaffected — there is only one stream object.
        const stream = Readable.toWeb(
          createReadStream(diskPath),
        ) as unknown as ReadableStream<Uint8Array>;
        return new Response(stream, { status: 200, headers });
      }
      const cached = await deps.cache.getOrLoad(
        mailAttachmentCacheKey(descriptor.accountId, messageId, attachmentId),
        async (signal) => {
          const fetched = await deps.gateway!.fetchAttachment({
            accountId: descriptor.accountId,
            remoteEmailId: descriptor.remoteEmailId,
            partPath: descriptor.partPath,
            source: descriptor.disposition === "inline" ? "inline" : "download",
            signal,
          });
          return fetched.bytes;
        },
        c.req.raw.signal,
      );
      deps.logger?.debug?.("mail.attachment.response", {
        source: cached.source,
        bytes: cached.bytes.byteLength,
        durationMs: Math.max(0, Date.now() - startedAt),
      });
      return attachmentResponse({
        descriptor,
        bytes: cached.bytes,
        etag: cached.etag,
        ifNoneMatch: c.req.header("if-none-match"),
      });
    } catch (error) {
      if (c.req.raw.signal.aborted || isAttachmentCancellation(error)) {
        return new Response(null, { status: 499 });
      }
      const projected = projectAttachmentError(error);
      deps.logger?.error("mail.attachment.fetch.failed", {
        messageId,
        attachmentId,
        code: projected.code,
        durationMs: Math.max(0, Date.now() - startedAt),
      });
      return c.json(
        { ok: false, error: projected.message, code: projected.code },
        projected.status,
      );
    }
  });

  return router;
}

function isAttachmentCancellation(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "AbortError" || error.name === "ATTACHMENT_CANCELLED";
}

function attachmentResponse(input: {
  descriptor: MailAttachmentFetchDescriptor;
  bytes: Buffer;
  etag: string;
  ifNoneMatch?: string;
}): Response {
  const headers = new Headers({
    "Cache-Control": "private, max-age=31536000, immutable",
    "Content-Type": resolveMediaType(
      input.bytes,
      input.descriptor.mediaType,
      input.descriptor.filename,
    ),
    "Content-Disposition": contentDisposition(
      input.descriptor.disposition,
      input.descriptor.filename,
    ),
    "X-Content-Type-Options": "nosniff",
    ETag: input.etag,
  });
  if (matchesEtag(input.ifNoneMatch, input.etag)) {
    return new Response(null, { status: 304, headers });
  }
  headers.set("Content-Length", String(input.bytes.byteLength));
  return new Response(new Uint8Array(input.bytes), { status: 200, headers });
}

function matchesEtag(ifNoneMatch: string | undefined, etag: string): boolean {
  if (!ifNoneMatch) return false;
  return ifNoneMatch.split(",").some((value) => {
    const candidate = value.trim();
    return candidate === "*" || candidate === etag || candidate === `W/${etag}`;
  });
}

function contentDisposition(
  disposition: "inline" | "attachment",
  filename: string,
): string {
  const fallback = filename
    .replace(/[\u0000-\u001f\u007f"\\]/g, "_")
    .replace(/[^\x20-\x7e]/g, "_") || "attachment";
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function resolveMediaType(
  bytes: Buffer,
  declared: string,
  filename: string,
): string {
  if (hasPrefix(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "image/png";
  }
  if (hasPrefix(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (hasAsciiPrefix(bytes, "GIF87a") || hasAsciiPrefix(bytes, "GIF89a")) {
    return "image/gif";
  }
  if (
    bytes.byteLength >= 12 &&
    hasAsciiPrefix(bytes, "RIFF") &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  if (hasAsciiPrefix(bytes, "%PDF-")) return "application/pdf";

  const normalized = declared.trim().toLowerCase();
  if (/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(normalized)) {
    return normalized;
  }
  const extension = filename.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  return extension === "png"
    ? "image/png"
    : extension === "jpg" || extension === "jpeg"
      ? "image/jpeg"
      : extension === "gif"
        ? "image/gif"
        : extension === "webp"
          ? "image/webp"
          : extension === "pdf"
            ? "application/pdf"
            : "application/octet-stream";
}

function hasPrefix(bytes: Buffer, prefix: number[]): boolean {
  return bytes.byteLength >= prefix.length && prefix.every(
    (value, index) => bytes[index] === value,
  );
}

function hasAsciiPrefix(bytes: Buffer, prefix: string): boolean {
  return bytes.byteLength >= prefix.length &&
    bytes.subarray(0, prefix.length).toString("ascii") === prefix;
}

function projectAttachmentError(error: unknown): {
  status: 429 | 502 | 503 | 504;
  code: string;
  message: string;
} {
  const code = error instanceof Error ? error.name : "ATTACHMENT_FETCH_FAILED";
  const detail = error instanceof Error ? error.message : String(error);
  if (/queue|busy/i.test(code) || /queue|busy/i.test(detail)) {
    return { status: 429, code: "ATTACHMENT_QUEUE_BUSY", message: "图片加载任务较多，请稍后重试" };
  }
  if (/timeout/i.test(code) || /timeout/i.test(detail)) {
    return { status: 504, code: "ATTACHMENT_FETCH_TIMEOUT", message: "图片加载超时，请稍后重试" };
  }
  if (/unavailable|stopped|credential/i.test(code) || /unavailable|stopped|credential/i.test(detail)) {
    return { status: 503, code: "ATTACHMENT_SERVICE_UNAVAILABLE", message: "邮件服务暂不可用" };
  }
  return { status: 502, code: "ATTACHMENT_FETCH_FAILED", message: "图片加载失败，请稍后重试" };
}
