import { copyFile, mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MARKDOWN_EXTENSIONS = new Set([".md", ".mdx"]);

export async function collectMarkdownSources(sourceDir) {
  const files = [];

  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolute);
      } else if (entry.isFile() && MARKDOWN_EXTENSIONS.has(path.extname(entry.name))) {
        files.push(absolute);
      }
    }
  }

  await visit(path.resolve(sourceDir));
  return files;
}

export function resolveRawDestination(sourceDir, outDir, sourceFile) {
  const sourceRoot = path.resolve(sourceDir);
  const source = path.resolve(sourceFile);
  const relative = path.relative(sourceRoot, source);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
    throw new Error(`Source is outside the public content root: ${sourceFile}`);
  }

  const outputRoot = path.resolve(outDir);
  const destination = path.resolve(outputRoot, relative);
  if (!destination.startsWith(`${outputRoot}${path.sep}`)) {
    throw new Error(`Raw destination escaped output root: ${sourceFile}`);
  }
  return destination;
}

export function assertUniqueDestinations(destinations) {
  const seen = new Set();
  for (const destination of destinations) {
    const key = path.resolve(destination).toLowerCase();
    if (seen.has(key)) {
      throw new Error(`Raw Markdown destination collision: ${destination}`);
    }
    seen.add(key);
  }
}

export async function exportRawMarkdown({ sourceDir, distDir }) {
  const outputStats = await stat(distDir).catch(() => null);
  if (!outputStats?.isDirectory()) {
    throw new Error(`Astro output directory does not exist: ${distDir}`);
  }

  const outDir = path.join(distDir, "raw");
  const sources = await collectMarkdownSources(sourceDir);
  const destinations = sources.map((source) =>
    resolveRawDestination(sourceDir, outDir, source),
  );
  assertUniqueDestinations(destinations);

  for (let index = 0; index < sources.length; index += 1) {
    await mkdir(path.dirname(destinations[index]), { recursive: true });
    await copyFile(sources[index], destinations[index]);
  }

  return {
    count: sources.length,
    files: destinations.map((destination) => path.relative(distDir, destination)),
  };
}

const currentFile = fileURLToPath(import.meta.url);
const invokedFile = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedFile === currentFile) {
  const projectRoot = path.resolve(path.dirname(currentFile), "..");
  const result = await exportRawMarkdown({
    sourceDir: path.join(projectRoot, "src", "content", "docs"),
    distDir: path.join(projectRoot, "dist"),
  });
  process.stdout.write(`Exported ${result.count} raw Markdown/MDX files.\n`);
}
