import { Hono } from "hono";
import {
  RemoteImageError,
  RemoteImageProxy,
  type RemoteImageResult,
} from "../../wemail/mail/RemoteImageProxy.js";

export interface RemoteImageGateway {
  fetchImage(url: string): Promise<RemoteImageResult>;
}

export function buildRemoteImageRoutes(
  gateway: RemoteImageGateway = new RemoteImageProxy(),
): Hono {
  const router = new Hono();

  router.get("/remote-images", async (c) => {
    const url = c.req.query("url")?.trim();
    if (!url) {
      return c.json({ ok: false, code: "REMOTE_IMAGE_URL_REQUIRED", error: "缺少远程图片地址" }, 400);
    }
    try {
      const image = await gateway.fetchImage(url);
      const headers = new Headers({
        "Cache-Control": "private, max-age=86400",
        "Content-Type": image.mediaType,
        "Content-Length": String(image.bytes.byteLength),
        "Content-Disposition": "inline",
        "X-Content-Type-Options": "nosniff",
        ETag: image.etag,
      });
      if (matchesEtag(c.req.header("if-none-match"), image.etag)) {
        return new Response(null, { status: 304, headers });
      }
      return new Response(new Uint8Array(image.bytes), { status: 200, headers });
    } catch (error) {
      if (error instanceof RemoteImageError) {
        return c.json({ ok: false, code: error.code, error: error.message }, error.status);
      }
      return c.json({ ok: false, code: "REMOTE_IMAGE_FETCH_FAILED", error: "远程图片加载失败" }, 502);
    }
  });

  return router;
}

function matchesEtag(ifNoneMatch: string | undefined, etag: string): boolean {
  if (!ifNoneMatch) return false;
  return ifNoneMatch.split(",").some((value) => {
    const candidate = value.trim();
    return candidate === "*" || candidate === etag || candidate === `W/${etag}`;
  });
}
