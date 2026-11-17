import assert from "node:assert/strict";
import test from "node:test";
import { classifyChangedFiles, serverTestPaths } from "../../scripts/change-scope.mjs";

test("documentation-only changes require no application checks", () => {
  assert.equal(classifyChangedFiles(["AGENTS.md", "openspec/changes/example/spec.md"]).docsOnly, true);
});

test("classifies production areas conservatively", () => {
  const result = classifyChangedFiles(["app/routes.ts", "shared/wemail/a.ts", "package.json"]);
  assert.equal(result.renderer, true);
  assert.equal(result.shared, true);
  assert.equal(result.packaging, true);
  assert.equal(result.docsOnly, false);
});

test("selects the nearest stable server domains", () => {
  assert.deepEqual(serverTestPaths(["server/wemail/intelligence/a.ts", "server/wemail/intelligence/b.ts", "server/api/router.ts"]), ["server/api", "server/wemail/intelligence"]);
});
