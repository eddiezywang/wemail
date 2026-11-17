/**
 * FeatureRegistry — Phase 1 unit tests.
 *
 * Verifies the registry contract that the harness depends on:
 *   - built-in registration succeeds for all 5 shipped specs
 *   - duplicate / unknown-id / bad-hash / bad-weights specs are rejected
 *   - plugin loader tolerates missing eval-plugins.json
 *   - listIds reflects exactly what's registered
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { FeatureRegistry, FRAMEWORK_VERSION } from "./FeatureRegistry.js";
import { computePromptHash } from "./FeatureSpec.js";
import type { SingleTurnPromptSpec } from "./SingleTurnPromptSpec.js";

function dummySpec(overrides: Partial<SingleTurnPromptSpec> = {}): SingleTurnPromptSpec {
  const base = {
    kind: "single-turn" as const,
    id: "dummy",
    description: "test",
    promptVersion: "1",
    systemPrompt: "you are a test",
    jsonSchema: { type: "object" },
    buildUserMessage: () => "user msg",
    parseOutput: (raw: string) => ({ ok: true as const, data: raw }),
    scoring: {
      format: () => ({ score: 3, notes: [] }),
      accuracy: () => ({ score: 3, notes: [] }),
      qualityRubric: "rubric",
    },
    ...overrides,
  };
  const promptHash =
    base.promptHash ??
    computePromptHash({
      systemPrompt: base.systemPrompt,
      promptVersion: base.promptVersion,
      jsonSchema: base.jsonSchema,
    });
  return { ...base, promptHash } as SingleTurnPromptSpec;
}

test("FeatureRegistry: loadDefault registers all built-in specs", async () => {
  const reg = await FeatureRegistry.loadDefault({ skipPlugins: true });
  const ids = reg.listIds();
  for (const expected of [
    "summary",
    "tags",
    "replyDraft",
    "replyDecision",
    "linkExtraction",
    "todoExtraction",
    "piPlanner",
    "curatorSafety",
  ]) {
    assert.ok(
      ids.includes(expected),
      `expected built-in '${expected}' to be registered (got ${ids.join(", ")})`,
    );
  }
  assert.equal(reg.get("summary").kind, "single-turn");
});

test("FeatureRegistry: rejects duplicate built-in id", () => {
  const reg = new FeatureRegistry();
  reg.registerBuiltin(dummySpec({ id: "dup-test" }));
  assert.throws(
    () => reg.registerBuiltin(dummySpec({ id: "dup-test" })),
    /duplicate built-in spec id 'dup-test'/,
  );
});

test("FeatureRegistry: rejects spec with bad promptHash", () => {
  const reg = new FeatureRegistry();
  const spec: SingleTurnPromptSpec = {
    ...dummySpec({ id: "bad-hash" }),
    promptHash: "deadbeef0000",
  };
  assert.throws(
    () => reg.registerBuiltin(spec),
    /promptHash mismatch/,
  );
});

test("FeatureRegistry: rejects spec whose weights do not sum to 1.0", () => {
  const reg = new FeatureRegistry();
  const spec = dummySpec({
    id: "bad-weights",
    weights: { format: 0.5, accuracy: 0.5, quality: 0.5, safety: 0.5 },
  });
  assert.throws(
    () => reg.registerBuiltin(spec),
    /axis weights must sum to 1.0/,
  );
});

test("FeatureRegistry: rejects spec missing id", () => {
  const reg = new FeatureRegistry();
  const spec = dummySpec({ id: undefined });
  assert.throws(() => reg.registerBuiltin(spec), /spec missing id/);
});

test("FeatureRegistry: rejects spec with unknown kind", () => {
  const reg = new FeatureRegistry();
  // @ts-expect-error -- forcing a junk kind through
  const spec = dummySpec({ kind: "magic" });
  assert.throws(
    () => reg.registerBuiltin(spec),
    /unknown kind 'magic'/,
  );
});

test("FeatureRegistry: get() throws on unknown id", () => {
  const reg = new FeatureRegistry();
  assert.throws(() => reg.get("nope"), /unknown feature 'nope'/);
});

test("FeatureRegistry: tolerates missing eval-plugins.json (cwd without one)", async () => {
  // Use a tmp dir with no eval-plugins.json — should still load builtins.
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const cwd = mkdtempSync(path.join(tmpdir(), "eval-cwd-"));
  const reg = await FeatureRegistry.loadDefault({ cwd });
  assert.ok(reg.has("summary"));
});

test("FeatureRegistry: rejects eval-plugins.json with mismatched frameworkVersion", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const cwd = mkdtempSync(path.join(tmpdir(), "eval-cwd-bad-ver-"));
  writeFileSync(
    path.join(cwd, "eval-plugins.json"),
    JSON.stringify({ frameworkVersion: "99.0.0", plugins: [] }),
    "utf8",
  );
  await assert.rejects(
    FeatureRegistry.loadDefault({ cwd }),
    /frameworkVersion=99\.0\.0 does not match runtime/,
  );
});

test("FeatureRegistry: loads an allowlisted plugin from the configured cwd", async () => {
  const { mkdirSync, mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const cwd = mkdtempSync(path.join(tmpdir(), "eval-cwd-plugin-"));
  const packageName = "wemail-probe-plugin";
  const pluginDir = path.join(cwd, "node_modules", packageName);
  mkdirSync(pluginDir, { recursive: true });

  const systemPrompt = "plugin prompt";
  const jsonSchema = { type: "object" };
  const promptHash = computePromptHash({
    systemPrompt,
    promptVersion: "1",
    jsonSchema,
  });
  writeFileSync(
    path.join(pluginDir, "package.json"),
    JSON.stringify({
      name: packageName,
      version: "1.0.0",
      type: "module",
      main: "index.mjs",
      peerDependencies: {
        "@wemail/prompt-eval-framework": `^${FRAMEWORK_VERSION}`,
      },
    }),
    "utf8",
  );
  writeFileSync(
    path.join(pluginDir, "index.mjs"),
    `
export default function register(registerSpec) {
  registerSpec({
    kind: "single-turn",
    id: "pluginEcho",
    description: "probe plugin",
    promptVersion: "1",
    systemPrompt: ${JSON.stringify(systemPrompt)},
    promptHash: ${JSON.stringify(promptHash)},
    jsonSchema: ${JSON.stringify(jsonSchema)},
    buildUserMessage: () => "user",
    parseOutput: (raw) => ({ ok: true, data: raw }),
    scoring: {
      format: () => ({ score: 3, notes: [] }),
      accuracy: () => ({ score: 3, notes: [] }),
      qualityRubric: "quality"
    }
  });
}
`,
    "utf8",
  );
  writeFileSync(
    path.join(cwd, "eval-plugins.json"),
    JSON.stringify({
      frameworkVersion: FRAMEWORK_VERSION,
      plugins: [{ package: packageName, version: "1.0.0" }],
    }),
    "utf8",
  );

  const reg = await FeatureRegistry.loadDefault({ cwd });
  const entry = reg.getEntry("pluginEcho");
  assert.equal(entry?.source, "plugin");
  assert.equal(entry?.pluginMeta?.loadedFrom, path.join(pluginDir, "package.json"));
});

test("FeatureRegistry: FRAMEWORK_VERSION is exported and is a string", () => {
  assert.equal(typeof FRAMEWORK_VERSION, "string");
  assert.ok(/^\d+\.\d+\.\d+$/.test(FRAMEWORK_VERSION));
});
