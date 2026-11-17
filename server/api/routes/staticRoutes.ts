import { Hono } from "hono";
import { readFileSync, existsSync } from "node:fs";
import { resolve, extname } from "node:path";

const app = new Hono();

const CONTENT_TYPES: Record<string, string> = {
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2",
};

// Serve vendored front-end assets (e.g. echarts.min.js) from known locations.
// Only safe filenames; no path traversal.
app.get("/static/:name", (c) => {
  const name = c.req.param("name");
  if (!/^[\w.()-]+$/.test(name)) return c.text("Not Found", 404);
  const candidates = [
    resolve(process.cwd(), "node_modules", "echarts", "dist", name),
    resolve(process.cwd(), "server", "public", name),
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      const body = readFileSync(p);
      const ct = CONTENT_TYPES[extname(name)] ?? "application/octet-stream";
      return new Response(body, {
        headers: {
          "Content-Type": ct,
          "Cache-Control": "private, max-age=86400, immutable",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }
  }
  return c.text("Not Found", 404);
});

export default app;
