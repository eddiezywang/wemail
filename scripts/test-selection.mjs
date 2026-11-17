import path from "node:path";

export const serverTestScopes = ["unit", "integration", "acceptance", "evaluation", "live"];

function normalize(file) {
  return file.replaceAll("\\", "/");
}

export function classifyServerTest(file) {
  const normalized = normalize(file).toLowerCase();
  if (/\.live(?:\.test)?\.ts$/.test(normalized)) return "live";
  if (/\.acceptance\.test\.ts$|(^|\/)acceptance(\/|$)/.test(normalized)) return "acceptance";
  if (/\.(?:eval|evaluation)\.test\.ts$|(^|\/)eval(?:uation)?s?(\/|$)/.test(normalized)) return "evaluation";
  if (/\.(?:integration|workspace)\.test\.ts$/.test(normalized)) return "integration";
  return "unit";
}

export function parseShard(value) {
  if (!value) return null;
  const match = /^(\d+)\/(\d+)$/.exec(value);
  if (!match) throw new Error(`Invalid shard '${value}'; expected index/total`);
  const index = Number(match[1]);
  const total = Number(match[2]);
  if (index < 1 || total < 1 || index > total) throw new Error(`Invalid shard '${value}'`);
  return { index, total };
}

export function selectServerTests(files, options = {}) {
  const scope = options.scope ?? "all";
  if (scope !== "all" && !serverTestScopes.includes(scope)) throw new Error(`Unknown server test scope '${scope}'`);
  const prefixes = (options.paths ?? []).map((entry) => normalize(path.resolve(entry)).toLowerCase());
  const shard = typeof options.shard === "string" ? parseShard(options.shard) : options.shard;
  const selected = files
    .map((file) => path.resolve(file))
    .filter((file) => file.endsWith(".test.ts") || file.endsWith(".live.ts"))
    .filter((file) => scope === "all" || classifyServerTest(file) === scope)
    .filter((file) => prefixes.length === 0 || prefixes.some((prefix) => normalize(file).toLowerCase().startsWith(prefix)))
    .sort((left, right) => normalize(left).localeCompare(normalize(right)));
  if (!shard) return selected;
  return selected.filter((_, index) => index % shard.total === shard.index - 1);
}
