import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { selectServerTests } from "./test-selection.mjs";

const root = process.cwd();
const tests = [];
const options = { paths: [] };
let listOnly = false;

for (let index = 2; index < process.argv.length; index += 1) {
  const argument = process.argv[index];
  if (argument === "--scope") options.scope = process.argv[++index];
  else if (argument === "--path") options.paths.push(path.resolve(root, process.argv[++index]));
  else if (argument === "--shard") options.shard = process.argv[++index];
  else if (argument === "--list") listOnly = true;
  else throw new Error(`Unknown argument '${argument}'`);
}

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full);
    } else if (entry.isFile() && (entry.name.endsWith(".test.ts") || entry.name.endsWith(".live.ts"))) {
      tests.push(full);
    }
  }
}

walk(path.join(root, "server"));
const selectedTests = selectServerTests(tests, options);

if (listOnly) {
  for (const selectedTest of selectedTests) console.log(path.relative(root, selectedTest).replaceAll("\\", "/"));
  process.exit(0);
}
if (selectedTests.length === 0) {
  console.log("No server tests matched the requested selection.");
  process.exit(0);
}
console.log(`[server-tests] running ${selectedTests.length} file(s)`);

const result = spawnSync(process.execPath, [
  "--import",
  "tsx",
  "--test",
  "--test-force-exit",
  "--test-concurrency",
  process.env.WEMAIL_TEST_CONCURRENCY ?? "4",
  ...selectedTests,
], {
  cwd: root,
  stdio: "inherit",
});

process.exit(result.status ?? 1);
