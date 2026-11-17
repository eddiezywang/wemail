import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const projectRoot = path.resolve(import.meta.dirname, "..");

test("Docker image builds statically and runs only dist plus the Node server", async () => {
  const dockerfile = await readFile(path.join(projectRoot, "Dockerfile"), "utf8");
  assert.match(dockerfile, /^FROM node:22-(alpine|slim) AS build/m);
  assert.match(dockerfile, /^RUN npm ci( --\S+)*$/m);
  assert.match(dockerfile, /^RUN npm run build$/m);
  assert.match(dockerfile, /^FROM node:22-(alpine|slim) AS runtime/m);
  assert.match(dockerfile, /^COPY --from=build \/app\/dist \.\/dist$/m);
  assert.match(dockerfile, /^COPY --from=build \/app\/server\.mjs \.\/server\.mjs$/m);
  assert.match(dockerfile, /^USER node$/m);
  assert.match(dockerfile, /^CMD \["node", "server\.mjs"\]$/m);
});

test("Docker context excludes generated and dependency directories", async () => {
  const dockerignore = await readFile(path.join(projectRoot, ".dockerignore"), "utf8");
  for (const entry of [".astro", "dist", "node_modules"]) {
    assert.match(dockerignore, new RegExp(`^${entry.replace(".", "\\.")}$`, "m"));
  }
});
