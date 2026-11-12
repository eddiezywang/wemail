import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
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
}

export class RemoteImageProxy {
  private readonly fetcher: typeof fetch;
  private readonly resolveHostname: (hostname: string) => Promise<string[]>;
  private readonly trustedHostSuffixes: string[];
  private readonly cache = new Map<string, CacheEntry>();
  private readonly pending = new Map<string, Promise<RemoteImageResult>>();
  private cachedBytes = 0;

  constructor(options: RemoteImageProxyOptions = {}) {
    this.fetcher = options.fetcher ?? fetch;
    this.resolveHostname = options.resolveHostname ?? resolvePublicAddresses;
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
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      let currentUrl = normalizedUrl;
      for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
        await this.assertSafeTarget(currentUrl);
        let response: Response;
        try {
          response = await this.fetcher(currentUrl, {
            method: "GET",
            redirect: "manual",
            signal: controller.signal,
            headers: {
              Accept: "image/webp,image/png,image/jpeg,image/gif;q=0.9,*/*;q=0.1",
              "User-Agent": "WeMail-Remote-Image/1.0",
            },
          });
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
          currentUrl = new URL(location, currentUrl).toString();
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
    } finally {
      clearTimeout(timeout);
    }
  }

  private async assertSafeTarget(rawUrl: string): Promise<void> {
    const url = new URL(normalizeRemoteImageUrl(rawUrl));
    const hostname = stripIpv6Brackets(url.hostname).toLowerCase();
    if (this.isTrustedEnterpriseHost(hostname)) return;
    if (url.port && url.port !== "80" && url.port !== "443") {
      throw new RemoteImageError("REMOTE_IMAGE_PORT_BLOCKED", 403, "远程图片端口不受支持");
    }
    const addresses = await this.resolveHostname(hostname).catch(() => []);
    if (addresses.length === 0 || addresses.some(isBlockedAddress)) {
      throw new RemoteImageError("REMOTE_IMAGE_ADDRESS_BLOCKED", 403, "远程图片地址不允许访问");
    }
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
  const address = stripIpv6Brackets(rawAddress).toLowerCase();
  if (address.startsWith("::ffff:")) return isBlockedAddress(address.slice(7));
  if (isIP(address) === 4) {
    const parts = address.split(".").map(Number);
    const [a, b] = parts;
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      // 198.18.0.0/15 (RFC 2544 benchmarking) is intentionally NOT blocked:
      // fake-ip proxy stacks (Clash/TUN-style) assign addresses from this
      // range to every public hostname, so blocking it breaks remote-image
      // loading for users behind such proxies. It never routes to private
      // hosts, so the SSRF exposure is negligible.
      (a === 192 && b === 0 && parts[2] === 2) ||
      (a === 198 && b === 51 && parts[2] === 100) ||
      (a === 203 && b === 0 && parts[2] === 113);
  }
  if (isIP(address) === 6) {
    return address === "::" || address === "::1" ||
      address.startsWith("fc") || address.startsWith("fd") ||
      /^fe[89ab]/.test(address) || address.startsWith("ff") ||
      address.startsWith("2001:db8:");
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
