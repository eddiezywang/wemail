const normalize = (file) => file.replaceAll("\\", "/").replace(/^\.\//, "");

const documentationPattern = /^(?:AGENTS\.md|README(?:\.[^/]*)?|docs\/|openspec\/|.*\.md$)/i;
const packagingPattern = /^(?:package(?:-lock)?\.json|bun\.lock|electron\/tsconfig|electron-builder\.|vite\.config|vitest\.config|react-router\.config|tsconfig|scripts\/(?:package|build-windows|ensure-electron|write-update-policy)|docker\/windows-build|\.github\/workflows\/)/i;

export function classifyChangedFiles(files) {
  const normalized = files.map(normalize).filter(Boolean);
  const result = { docs: false, website: false, renderer: false, server: false, desktop: false, shared: false, packaging: false, unknown: false };
  for (const file of normalized) {
    if (documentationPattern.test(file)) result.docs = true;
    else if (packagingPattern.test(file)) result.packaging = true;
    else if (file.startsWith("website/")) result.website = true;
    else if (file.startsWith("app/") || file.startsWith("tests/renderer/")) result.renderer = true;
    else if (file.startsWith("server/")) result.server = true;
    else if (file.startsWith("electron/") || file.startsWith("tests/e2e/")) result.desktop = true;
    else if (file.startsWith("shared/")) result.shared = true;
    else result.unknown = true;
  }
  return { ...result, docsOnly: normalized.length > 0 && normalized.every((file) => documentationPattern.test(file)) };
}

export function serverTestPaths(files) {
  const paths = new Set();
  for (const original of files) {
    const file = normalize(original);
    if (!file.startsWith("server/")) continue;
    const parts = file.split("/");
    if (parts[1] === "wemail" && parts[2]) paths.add(parts.slice(0, 3).join("/"));
    else if (parts[1]) paths.add(parts.slice(0, 2).join("/"));
    else paths.add("server");
  }
  return [...paths].sort();
}
