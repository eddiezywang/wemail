import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { closeNodeHttpServer } from "../../server/api/close-node-http-server.js";

const DEFAULT_DEV_RENDERER_URL = "http://localhost:5173";
const DEV_RENDERER_ARG_PREFIX = "--wemail-renderer-url=";

export interface ResolveRendererUrlOptions {
  env: { VITE_DEV_SERVER_URL?: string };
  isPackaged: boolean;
  rendererPort?: number;
  argv?: readonly string[];
}

export interface PackagedRendererServer {
  port: number;
  close(): Promise<void>;
}

export function resolveRendererUrlOverride(
  env: { VITE_DEV_SERVER_URL?: string },
  argv: readonly string[] = [],
) {
  const envUrl = env.VITE_DEV_SERVER_URL?.trim();
  if (envUrl) return envUrl;
  const arg = argv.find((value) => value.startsWith(DEV_RENDERER_ARG_PREFIX));
  const argUrl = arg?.slice(DEV_RENDERER_ARG_PREFIX.length).trim();
  return argUrl || undefined;
}

export function resolveRendererUrl({
  env,
  isPackaged,
  rendererPort,
  argv,
}: ResolveRendererUrlOptions) {
  const override = resolveRendererUrlOverride(env, argv);
  if (override) return override;
  if (!isPackaged) return DEFAULT_DEV_RENDERER_URL;
  if (!rendererPort) {
    throw new Error("Packaged renderer server port is required");
  }
  return `http://127.0.0.1:${rendererPort}`;
}

export function shouldStartPackagedRenderer(
  env: { VITE_DEV_SERVER_URL?: string },
  isPackaged: boolean,
  argv: readonly string[] = [],
) {
  return isPackaged && !resolveRendererUrlOverride(env, argv);
}

function getContentType(filePath: string) {
  switch (path.extname(filePath).toLowerCase()) {
    case ".css":
      return "text/css; charset=utf-8";
    case ".html":
      return "text/html; charset=utf-8";
    case ".ico":
      return "image/x-icon";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    default:
      return "application/octet-stream";
  }
}

function resolveClientFile(clientDir: string, requestUrl?: string) {
  if (!requestUrl) return null;
  const url = new URL(requestUrl, "http://127.0.0.1");
  const relativePath = decodeURIComponent(url.pathname).replace(/^\/+/, "");
  if (!relativePath) return null;

  const filePath = path.resolve(clientDir, relativePath);
  const relativeToClient = path.relative(clientDir, filePath);
  if (
    relativeToClient.startsWith("..") ||
    path.isAbsolute(relativeToClient)
  ) {
    return null;
  }
  return filePath;
}

async function tryServeClientFile(
  clientDir: string,
  req: IncomingMessage,
  res: ServerResponse,
) {
  const filePath = resolveClientFile(clientDir, req.url);
  if (!filePath) return false;

  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) return false;
  } catch {
    return false;
  }

  res.statusCode = 200;
  res.setHeader("Content-Type", getContentType(filePath));
  createReadStream(filePath).pipe(res);
  return true;
}

async function tryServeSpaFallback(clientDir: string, res: ServerResponse) {
  const filePath = path.join(clientDir, "index.html");

  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) return false;
  } catch {
    return false;
  }

  res.statusCode = 200;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  createReadStream(filePath).pipe(res);
  return true;
}

export async function startPackagedRendererServer(appPath: string) {
  const clientDir = path.join(appPath, "build", "client");

  const server = http.createServer(async (req, res) => {
    try {
      if (await tryServeClientFile(clientDir, req, res)) return;
      if (await tryServeSpaFallback(clientDir, res)) return;
      res.statusCode = 404;
      res.end("Not found");
    } catch (err) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end(err instanceof Error ? err.message : String(err));
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  const port = typeof address === "object" && address?.port ? address.port : 0;
  if (!port) {
    server.close();
    throw new Error("Packaged renderer server did not bind a port");
  }

  return {
    port,
    close: () => closeNodeHttpServer(server),
  } satisfies PackagedRendererServer;
}
