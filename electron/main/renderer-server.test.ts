import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  resolveRendererUrl,
  startPackagedRendererServer,
  type PackagedRendererServer,
} from "./renderer-server.js";

const tempDirs: string[] = [];
const servers: PackagedRendererServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(
    tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

async function makePackagedApp({
  indexHtml = "<!doctype html><main>spa fallback</main>",
  serverBuild = "throw new Error('server build should not be imported');",
} = {}) {
  const appPath = await fs.mkdtemp(path.join(os.tmpdir(), "wemail-renderer-"));
  tempDirs.push(appPath);
  await fs.mkdir(path.join(appPath, "build", "client", "assets"), {
    recursive: true,
  });
  await fs.mkdir(path.join(appPath, "build", "server"), { recursive: true });
  await fs.writeFile(path.join(appPath, "build", "client", "index.html"), indexHtml);
  await fs.writeFile(
    path.join(appPath, "build", "client", "assets", "entry.js"),
    "console.log('entry');",
  );
  await fs.writeFile(path.join(appPath, "build", "server", "index.js"), serverBuild);
  return appPath;
}

function get(url: string) {
  return new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          resolve({ statusCode: res.statusCode ?? 0, body });
        });
      })
      .on("error", reject);
  });
}

describe("renderer server", () => {
  it("uses an explicit dev server url when provided", () => {
    expect(
      resolveRendererUrl({
        env: { VITE_DEV_SERVER_URL: "http://localhost:5174" },
        isPackaged: true,
        rendererPort: 49152,
      }),
    ).toBe("http://localhost:5174");
  });

  it("uses the desktop launch argument when the environment is unavailable", () => {
    expect(
      resolveRendererUrl({
        env: {},
        argv: ["--wemail-renderer-url=http://127.0.0.1:5173"],
        isPackaged: true,
        rendererPort: 49152,
      }),
    ).toBe("http://127.0.0.1:5173");
  });

  it("uses the Vite dev server for unpackaged desktop runs", () => {
    expect(
      resolveRendererUrl({
        env: {},
        isPackaged: false,
        rendererPort: 49152,
      }),
    ).toBe("http://localhost:5173");
  });

  it("uses the packaged renderer server for packaged desktop runs", () => {
    expect(
      resolveRendererUrl({
        env: {},
        isPackaged: true,
        rendererPort: 49152,
      }),
    ).toBe("http://127.0.0.1:49152");
  });

  it("serves the SPA fallback for app routes without importing the server build", async () => {
    const appPath = await makePackagedApp();
    const server = await startPackagedRendererServer(appPath);
    servers.push(server);

    const response = await get(`http://127.0.0.1:${server.port}/digests`);

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("spa fallback");
  });

  it("still serves packaged client assets directly", async () => {
    const appPath = await makePackagedApp();
    const server = await startPackagedRendererServer(appPath);
    servers.push(server);

    const response = await get(`http://127.0.0.1:${server.port}/assets/entry.js`);

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("entry");
  });
});
