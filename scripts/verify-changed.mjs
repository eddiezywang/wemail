import { spawnSync } from "node:child_process";
import { classifyChangedFiles, serverTestPaths } from "./change-scope.mjs";

const root = process.cwd();

function gitLines(args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`);
  return result.stdout.split(/\r?\n/).filter(Boolean);
}

function changedFiles() {
  const baseArgument = process.argv.indexOf("--base");
  const base = baseArgument >= 0 ? process.argv[baseArgument + 1] : process.env.WEMAIL_VERIFY_BASE;
  if (base) return gitLines(["diff", "--name-only", "--diff-filter=ACMR", `${base}...HEAD`]);
  return [...new Set([
    ...gitLines(["diff", "--name-only", "--diff-filter=ACMR"]),
    ...gitLines(["diff", "--cached", "--name-only", "--diff-filter=ACMR"]),
    ...gitLines(["ls-files", "--others", "--exclude-standard"]),
  ])];
}

function run(script, extra = []) {
  console.log(`\n[verify:changed] npm run ${script}${extra.length ? ` -- ${extra.join(" ")}` : ""}`);
  const command = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(command, ["run", script, ...(extra.length ? ["--", ...extra] : [])], { cwd: root, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const files = changedFiles();
if (files.length === 0) {
  console.log("[verify:changed] no changed files");
  process.exit(0);
}
const scope = classifyChangedFiles(files);
console.log(`[verify:changed] ${files.length} changed file(s): ${files.join(", ")}`);
if (scope.docsOnly) {
  console.log("[verify:changed] documentation/OpenSpec-only change; no application checks required");
  process.exit(0);
}
if (scope.unknown) run("verify:pr");
else {
  if (scope.website) run("test:website");
  if (scope.renderer || scope.shared) {
    run("typecheck");
    const related = files.filter((file) => /^(?:app|shared|tests\/renderer)\//.test(file));
    if (related.length) run("test:renderer:related", related);
  }
  if (scope.server || scope.shared) {
    run("typecheck:server");
    const paths = scope.shared ? ["server"] : serverTestPaths(files);
    run("test:server:unit", paths.flatMap((entry) => ["--path", entry]));
  }
  if (scope.desktop) run("typecheck:desktop");
  if (scope.packaging) {
    run("test:packaging");
    run("build:desktop");
  }
}
