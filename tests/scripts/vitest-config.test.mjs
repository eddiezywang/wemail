import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("renderer Vitest excludes test files owned by node:test", () => {
  const config = fs.readFileSync(path.join(repoRoot, "vitest.config.ts"), "utf8");
  const nodeTestFiles = [
    "shared/wemail/automationCenter.test.ts",
    "electron/bot-core/channels.test.ts",
  ];

  for (const testFile of nodeTestFiles) {
    const source = fs.readFileSync(path.join(repoRoot, testFile), "utf8");
    assert.match(source, /from "node:test"/);
    assert.match(config, new RegExp(`"${testFile.replaceAll("/", "\\/")}"`));
  }
});
