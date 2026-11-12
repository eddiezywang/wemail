import { readFileSync, readdirSync } from "node:fs";
import { extname, join, relative } from "node:path";

const root = process.cwd();
const rendererRoot = join(root, "app");
const apiCompositionFile = join(root, "server", "api", "app.ts");
const sourceExtensions = new Set([".ts", ".tsx"]);
const retiredPrefixes = new Set(["/api/intelligence", "/api/v1"]);

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    if (!entry.isFile() || !sourceExtensions.has(extname(entry.name))) return [];
    if (/\.test\.[^.]+$/.test(entry.name)) return [];
    return [path];
  });
}

function apiPrefix(path) {
  const match = path.match(/^\/api\/[A-Za-z0-9_-]+/);
  return match?.[0];
}

const composition = readFileSync(apiCompositionFile, "utf8");
const mountedPrefixes = new Set(
  [...composition.matchAll(/app\.route\(\s*["'](\/api\/[A-Za-z0-9_-]+)/g)].map(
    (match) => match[1],
  ),
);

const failures = [];
for (const file of sourceFiles(rendererRoot)) {
  const source = readFileSync(file, "utf8");
  const localPaths = [...source.matchAll(/["'`](\/api\/[A-Za-z0-9_-]+[^"'`]*)/g)];
  for (const match of localPaths) {
    const path = match[1];
    const prefix = apiPrefix(path);
    if (!prefix) continue;
    if (retiredPrefixes.has(prefix)) {
      failures.push(`${relative(root, file)}: retired local API prefix ${prefix}`);
      continue;
    }
    if (!mountedPrefixes.has(prefix)) {
      failures.push(`${relative(root, file)}: no server route mounted for ${prefix}`);
    }
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log(
    `Local API contract check passed (${mountedPrefixes.size} mounted prefixes).`,
  );
}
