import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CONTENT_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".ico", "image/x-icon"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
  [".md", "text/markdown; charset=utf-8"],
  [".mdx", "text/markdown; charset=utf-8"],
]);

export function contentTypeFor(filePath) {
  return CONTENT_TYPES.get(path.extname(filePath).toLowerCase())
    ?? "application/octet-stream";
}

export function cacheControlFor(requestPath) {
  if (requestPath.startsWith("/_astro/")) {
    return "public, max-age=31536000, immutable";
  }
  if (/\.(?:html|md|mdx)$/i.test(requestPath) || requestPath.endsWith("/")) {
    return "public, max-age=0, must-revalidate";
  }
  return "public, max-age=3600";
}

function responseHeaders(filePath, requestPath) {
  const headers = {
    "Content-Type": contentTypeFor(filePath),
    "Cache-Control": cacheControlFor(requestPath),
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
  };
  if (/\.(?:md|mdx)$/i.test(filePath)) {
    headers["Content-Disposition"] = "inline";
  }
  return headers;
}

function safeRequestSegments(requestUrl) {
  const rawPath = (requestUrl ?? "/").split(/[?#]/, 1)[0] || "/";
  let decoded;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    const error = new Error("Malformed request path");
    error.statusCode = 400;
    throw error;
  }
  if (decoded.includes("\0")) {
    const error = new Error("Forbidden path");
    error.statusCode = 403;
    throw error;
  }
  const normalized = decoded.replaceAll("\\", "/");
  const segments = normalized.split("/").filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    const error = new Error("Forbidden path");
    error.statusCode = 403;
    throw error;
  }
  return segments;
}

export async function resolveRequestFile(rootDir, requestUrl) {
  const root = path.resolve(rootDir);
  const segments = safeRequestSegments(requestUrl);
  let candidate = path.resolve(root, ...segments);
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
    const error = new Error("Forbidden path");
    error.statusCode = 403;
    throw error;
  }

  let candidateStats = await stat(candidate).catch(() => null);
  if (candidateStats?.isDirectory()) {
    candidate = path.join(candidate, "index.html");
    candidateStats = await stat(candidate).catch(() => null);
  }
  if (!candidateStats?.isFile()) return null;
  const realRoot = await realpath(root);
  const realCandidate = await realpath(candidate);
  if (realCandidate !== realRoot && !realCandidate.startsWith(`${realRoot}${path.sep}`)) {
    const error = new Error("Forbidden path");
    error.statusCode = 403;
    throw error;
  }
  return realCandidate;
}

export function createStaticServer({ rootDir }) {
  const root = path.resolve(rootDir);
  return http.createServer(async (request, response) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");

    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { Allow: "GET, HEAD" });
      response.end("Method Not Allowed\n");
      return;
    }

    const requestPath = (request.url ?? "/").split(/[?#]/, 1)[0] || "/";
    if (requestPath === "/healthz") {
      response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      response.end(request.method === "HEAD" ? undefined : "ok\n");
      return;
    }

    try {
      const filePath = await resolveRequestFile(root, request.url);
      if (!filePath) {
        response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        response.end(request.method === "HEAD" ? undefined : "Not Found\n");
        return;
      }
      response.writeHead(200, responseHeaders(filePath, requestPath));
      if (request.method === "HEAD") {
        response.end();
        return;
      }
      const stream = createReadStream(filePath);
      stream.on("error", () => response.destroy());
      stream.pipe(response);
    } catch (error) {
      const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
      const body = statusCode === 400 ? "Bad Request\n"
        : statusCode === 403 ? "Forbidden\n"
          : "Internal Server Error\n";
      response.writeHead(statusCode, { "Content-Type": "text/plain; charset=utf-8" });
      response.end(request.method === "HEAD" ? undefined : body);
    }
  });
}

const currentFile = fileURLToPath(import.meta.url);
const invokedFile = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedFile === currentFile) {
  const rootDir = path.resolve(process.env.DIST_DIR ?? path.join(path.dirname(currentFile), "dist"));
  const port = Number.parseInt(process.env.PORT ?? "4321", 10);
  const server = createStaticServer({ rootDir });
  server.listen(port, "0.0.0.0", () => {
    process.stdout.write(`WeMail docs listening on http://0.0.0.0:${port}\n`);
  });
  const shutdown = () => server.close(() => process.exit(0));
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}
