import fs from "node:fs";
import path from "node:path";

const root = process.cwd();

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return walk(absolute);
    return [absolute];
  });
}

const productionUiFiles = walk(path.join(root, "app")).filter(
  (file) => /\.(?:ts|tsx|css)$/.test(file) && !/\.test\.[^.]+$/.test(file),
);

const rules = [
  {
    name: "native browser dialog",
    pattern: /window\.(?:alert|confirm|prompt)\s*\(/g,
    files: productionUiFiles,
  },
  {
    name: "critical text below 12px",
    pattern: /text-\[(?:9|10|11)px\]/g,
    files: productionUiFiles,
  },
  {
    name: "remote Google font",
    pattern: /@import\s+(?:url\()?[^;\n]*fonts\.googleapis\.com/gi,
    files: productionUiFiles,
  },
  {
    name: "raw error message passed to user feedback",
    pattern: /(?:toast\.(?:error|warning|info)|setError)\s*\([\s\S]{0,160}\b(?:error|err|caught)\.message\b/g,
    files: productionUiFiles,
  },
  {
    name: "provider reasoning stored in renderer conversation state",
    pattern: /type:\s*["']reasoning["']/g,
    files: [path.join(root, "shared", "wemail", "conversationState.ts")],
  },
];

const failures = [];
for (const rule of rules) {
  for (const file of rule.files) {
    const source = fs.readFileSync(file, "utf8");
    for (const match of source.matchAll(rule.pattern)) {
      const line = source.slice(0, match.index).split(/\r?\n/).length;
      failures.push(`${path.relative(root, file)}:${line} ${rule.name}`);
    }
  }
}

if (failures.length > 0) {
  console.error("UI information-boundary check failed:\n" + failures.join("\n"));
  process.exit(1);
}

console.log("UI information-boundary check passed.");
