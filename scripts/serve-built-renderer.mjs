import fs from "node:fs";
import http from "node:http";
import path from "node:path";

function getArg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}

const root = path.resolve(getArg("--root", process.cwd()));
const port = Number(getArg("--port", process.env.PORT ?? "4173"));
const clientDir = path.join(root, "build", "client");
const indexPath = path.join(clientDir, "index.html");

if (!fs.existsSync(indexPath)) {
  throw new Error(`Renderer build not found: ${indexPath}. Run npm run build:renderer first.`);
}

const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

function resolveClientPath(requestUrl) {
  const pathname = decodeURIComponent(new URL(requestUrl, "http://127.0.0.1").pathname);
  const relativePath = pathname === "/" ? "index.html" : pathname.slice(1);
  const filePath = path.resolve(clientDir, relativePath);
  const relativeToClient = path.relative(clientDir, filePath);
  if (relativeToClient.startsWith("..") || path.isAbsolute(relativeToClient)) return null;
  return filePath;
}

function sendFile(res, filePath, headOnly = false) {
  res.writeHead(200, {
    "cache-control": "no-store",
    "content-type": contentTypes.get(path.extname(filePath).toLowerCase()) ?? "application/octet-stream",
  });
  if (headOnly) {
    res.end();
    return;
  }
  fs.createReadStream(filePath).on("error", () => res.destroy()).pipe(res);
}

const server = http.createServer((req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405);
    res.end();
    return;
  }
  const candidate = req.url ? resolveClientPath(req.url) : null;
  const filePath = candidate && fs.existsSync(candidate) && fs.statSync(candidate).isFile()
    ? candidate
    : indexPath;
  sendFile(res, filePath, req.method === "HEAD");
});

server.listen(port, "127.0.0.1", () => {
  console.log(`[wemail-renderer] production build listening on http://127.0.0.1:${port}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
