import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import http from "node:http";
import https from "node:https";
import { Readable } from "node:stream";
import sharp from "sharp";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 40_000_000;
const MAX_REDIRECTS = 4;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_CACHE_ENTRIES = 64;
const MAX_CACHE_BYTES = 32 * 1024 * 1024;

/** Approved host suffixes are opt-in via WEMAIL_TRUSTED_IMAGE_HOST_SUFFIXES
 *  (comma-separated, e.g. images.example.com). The open-source default is an
 *  empty list, so no host bypasses the SSRF address checks by default. */
function configuredTrustedHostSuffixes(): string[] {
  return (process.env.WEMAIL_TRUSTED_IMAGE_HOST_SUFFIXES ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}
const SUPPORTED_MEDIA_TYPES = new Map<string, string>([
  ["jpeg", "image/jpeg"],
  ["png", "image/png"],
  ["gif", "image/gif"],
  ["webp", "image/webp"],
]);

export interface RemoteImageResult {
  bytes: Buffer;
  mediaType: string;
  etag: string;
}

export class RemoteImageError extends Error {
  constructor(
    readonly code: string,
    readonly status: 400 | 403 | 413 | 415 | 422 | 502 | 504,
    message: string,
  ) {
    super(message);
    this.name = "RemoteImageError";
  }
}

interface CacheEntry extends RemoteImageResult {
  size: number;
}

export interface RemoteImageProxyOptions {
  fetcher?: typeof fetch;
  resolveHostname?: (hostname: string) => Promise<string[]>;
  trustedHostSuffixes?: string[];
  timeoutMs?: number;
}

export class RemoteImageProxy {
  private readonly fetcher?: typeof fetch;
  private readonly resolveHostname: (hostname: string) => Promise<string[]>;
  private readonly trustedHostSuffixes: string[];
  private readonly timeoutMs: number;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly pending = new Map<string, Promise<RemoteImageResult>>();
  private cachedBytes = 0;

  constructor(options: RemoteImageProxyOptions = {}) {
    this.fetcher = options.fetcher;
    this.resolveHostname = options.resolveHostname ?? resolvePublicAddresses;
    this.timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS;
    this.trustedHostSuffixes = (
      options.trustedHostSuffixes ?? configuredTrustedHostSuffixes()
    ).map((value) => value.trim().toLowerCase()).filter(Boolean);
  }

  async fetchImage(rawUrl: string): Promise<RemoteImageResult> {
    const normalized = normalizeRemoteImageUrl(rawUrl);
    const cached = this.cache.get(normalized);
    if (cached) {
      this.cache.delete(normalized);
      this.cache.set(normalized, cached);
      return cached;
    }

    const existing = this.pending.get(normalized);
    if (existing) return existing;
    const request = this.fetchAndValidate(normalized).finally(() => {
      this.pending.delete(normalized);
    });
    this.pending.set(normalized, request);
    return request;
  }

  private async fetchAndValidate(normalizedUrl: string): Promise<RemoteImageResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      let currentUrl = normalizedUrl;
      for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
        const addresses = await this.assertSafeTarget(currentUrl, controller.signal);
        let response: Response;
        try {
          const init: RequestInit = {
            method: "GET",
            redirect: "manual",
            signal: controller.signal,
            headers: {
              Accept: "image/webp,image/png,image/jpeg,image/gif;q=0.9,*/*;q=0.1",
              "User-Agent": "WeMail-Remote-Image/1.0",
            },
          };
          response = this.fetcher
            ? await this.fetcher(currentUrl, init)
            : await fetchPinnedImage(currentUrl, addresses[0]!, init);
        } catch (error) {
          if (controller.signal.aborted) {
            throw new RemoteImageError("REMOTE_IMAGE_TIMEOUT", 504, "远程图片加载超时");
          }
          throw new RemoteImageError("REMOTE_IMAGE_FETCH_FAILED", 502, "无法连接远程图片服务");
        }

        if (isRedirect(response.status)) {
          const location = response.headers.get("location");
          await response.body?.cancel();
          if (!location || redirects === MAX_REDIRECTS) {
            throw new RemoteImageError("REMOTE_IMAGE_REDIRECT_INVALID", 502, "远程图片重定向无效");
          }
          try {
            currentUrl = new URL(location, currentUrl).toString();
          } catch {
            throw new RemoteImageError("REMOTE_IMAGE_REDIRECT_INVALID", 502, "远程图片重定向无效");
          }
          continue;
        }
        if (!response.ok) {
          await response.body?.cancel();
          throw new RemoteImageError("REMOTE_IMAGE_UPSTREAM_ERROR", 502, `远程图片服务返回 ${response.status}`);
        }

        const declaredLength = Number(response.headers.get("content-length") ?? "0");
        if (Number.isFinite(declaredLength) && declaredLength > MAX_IMAGE_BYTES) {
          await response.body?.cancel();
          throw new RemoteImageError("REMOTE_IMAGE_TOO_LARGE", 413, "远程图片超过 10 MB 限制");
        }
        const bytes = await readLimitedBody(response, MAX_IMAGE_BYTES);
        const mediaType = await validateRasterImage(bytes);
        const result = {
          bytes,
          mediaType,
          etag: `"sha256-${createHash("sha256").update(bytes).digest("hex")}"`,
        };
        this.store(normalizedUrl, result);
        return result;
      }
      throw new RemoteImageError("REMOTE_IMAGE_REDIRECT_INVALID", 502, "远程图片重定向无效");
    } catch (error) {
      if (controller.signal.aborted) {
        throw new RemoteImageError("REMOTE_IMAGE_TIMEOUT", 504, "远程图片加载超时");
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async assertSafeTarget(rawUrl: string, signal: AbortSignal): Promise<string[]> {
    const url = new URL(normalizeRemoteImageUrl(rawUrl));
    const hostname = stripIpv6Brackets(url.hostname).toLowerCase();
    const trusted = this.isTrustedEnterpriseHost(hostname);
    if (!trusted && url.port && url.port !== "80" && url.port !== "443") {
      throw new RemoteImageError("REMOTE_IMAGE_PORT_BLOCKED", 403, "远程图片端口不受支持");
    }
    const addresses = await abortableResolve(this.resolveHostname(hostname), signal).catch((error) => {
      if (signal.aborted) throw error;
      return [];
    });
    if (addresses.length === 0 || addresses.some((address) => !isIP(address)) ||
        (!trusted && addresses.some(isBlockedAddress))) {
      throw new RemoteImageError("REMOTE_IMAGE_ADDRESS_BLOCKED", 403, "远程图片地址不允许访问");
    }
    return addresses;
  }

  private isTrustedEnterpriseHost(hostname: string): boolean {
    return this.trustedHostSuffixes.some(
      (suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`),
    );
  }

  private store(url: string, result: RemoteImageResult): void {
    const entry = { ...result, size: result.bytes.byteLength };
    if (entry.size > MAX_CACHE_BYTES) return;
    this.cache.set(url, entry);
    this.cachedBytes += entry.size;
    while (this.cache.size > MAX_CACHE_ENTRIES || this.cachedBytes > MAX_CACHE_BYTES) {
      const oldestKey = this.cache.keys().next().value as string | undefined;
      if (!oldestKey) break;
      const oldest = this.cache.get(oldestKey);
      if (oldest) this.cachedBytes -= oldest.size;
      this.cache.delete(oldestKey);
    }
  }
}

function abortableResolve(pending: Promise<string[]>, signal: AbortSignal): Promise<string[]> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error("resolution aborted"));
    const onAbort = () => reject(new Error("resolution aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/** Connect to the validated address without a second DNS lookup. URL hostname
 * remains unchanged for Host and TLS certificate verification. */
function fetchPinnedImage(url: string, address: string, init: RequestInit): Promise<Response> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const transport = parsed.protocol === "https:" ? https : http;
    const request = transport.request(parsed, {
      method: "GET",
      // A pooled socket could bypass this request's pinned lookup.
      agent: false,
      headers: init.headers as Record<string, string>,
      signal: init.signal ?? undefined,
      family: isIP(address),
      lookup: (_hostname, _options, callback) => callback(null, address, isIP(address)),
    }, (response) => {
      try {
        const headers = new Headers();
        for (const [key, value] of Object.entries(response.headers)) {
          if (Array.isArray(value)) value.forEach((part) => headers.append(key, part));
          else if (value !== undefined) headers.set(key, value);
        }
        const status = response.statusCode ?? 502;
        // Fetch Response forbids a body for these statuses, even when Node
        // represents the incoming response as a readable stream.
        const noBody = status === 204 || status === 205 || status === 304;
        if (noBody) response.resume();
        resolve(new Response(noBody ? null : Readable.toWeb(response) as unknown as ReadableStream<Uint8Array>, {
          status,
          headers,
        }));
      } catch (error) {
        response.destroy();
        reject(error);
      }
    });
    request.on("error", reject);
    request.end();
  });
}

function normalizeRemoteImageUrl(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new RemoteImageError("REMOTE_IMAGE_URL_INVALID", 400, "远程图片地址无效");
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    throw new RemoteImageError("REMOTE_IMAGE_URL_INVALID", 400, "远程图片地址无效");
  }
  url.hash = "";
  return url.toString();
}

async function resolvePublicAddresses(hostname: string): Promise<string[]> {
  if (isIP(hostname)) return [hostname];
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  return addresses.map((entry) => entry.address);
}

function isBlockedAddress(rawAddress: string): boolean {
  let address = stripIpv6Brackets(rawAddress).toLowerCase();
  if (isIP(address) === 6) {
    try {
      // Canonicalize expanded and compressed spellings before prefix checks.
      address = stripIpv6Brackets(new URL(`http://[${address}]/`).hostname).toLowerCase();
    } catch {
      return true;
    }
    // Mapped IPv4 can be written in hexadecimal as well as dotted notation.
    if (address.startsWith("::ffff:")) return true;
  }
  if (isIP(address) === 4) {
    const parts = address.split(".").map(Number);
    const [a, b] = parts;
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      // Benchmark/fake-IP networks can route to local services; do not assume
      // that a proxy-assigned address is safe for untrusted mail content.
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 192 && b === 0 && parts[2] === 2) ||
      (a === 198 && b === 51 && parts[2] === 100) ||
      (a === 203 && b === 0 && parts[2] === 113);
  }
  if (isIP(address) === 6) {
    const first = Number.parseInt(address.split(":")[0] || "0", 16);
    // Only global-unicast space; exclude transition mechanisms which can
    // embed IPv4 destinations and documentation-only addresses.
    return first < 0x2000 || first > 0x3fff || first === 0x2002 ||
      address.startsWith("2001:db8:") || address === "2001:db8::" ||
      address.startsWith("2001:0:") || address.startsWith("2001::");
  }
  return true;
}

function stripIpv6Brackets(value: string): string {
  return value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

async function readLimitedBody(response: Response, limit: number): Promise<Buffer> {
  if (!response.body) {
    throw new RemoteImageError("REMOTE_IMAGE_EMPTY", 422, "远程图片内容为空");
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new RemoteImageError("REMOTE_IMAGE_TOO_LARGE", 413, "远程图片超过 10 MB 限制");
    }
    chunks.push(Buffer.from(value));
  }
  if (total === 0) {
    throw new RemoteImageError("REMOTE_IMAGE_EMPTY", 422, "远程图片内容为空");
  }
  return Buffer.concat(chunks, total);
}

async function validateRasterImage(bytes: Buffer): Promise<string> {
  try {
    const metadata = await sharp(bytes, {
      failOn: "error",
      limitInputPixels: MAX_IMAGE_PIXELS,
      animated: true,
    }).metadata();
    const width = metadata.width ?? 0;
    const height = metadata.height ?? 0;
    const pages = metadata.pages ?? 1;
    const mediaType = metadata.format ? SUPPORTED_MEDIA_TYPES.get(metadata.format) : undefined;
    if (!mediaType) {
      throw new RemoteImageError("REMOTE_IMAGE_FORMAT_UNSUPPORTED", 415, "仅支持 JPEG、PNG、GIF 和 WebP 图片");
    }
    if (width <= 0 || height <= 0 || width * height * pages > MAX_IMAGE_PIXELS) {
      throw new RemoteImageError("REMOTE_IMAGE_DIMENSIONS_INVALID", 422, "远程图片尺寸不安全");
    }
    return mediaType;
  } catch (error) {
    if (error instanceof RemoteImageError) throw error;
    throw new RemoteImageError("REMOTE_IMAGE_INVALID", 422, "远程内容不是有效图片");
  }
}
