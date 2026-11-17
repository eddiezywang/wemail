import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { openOrCreateMailDatabase } from "../database/Database.js";
import { SkillCenterService } from "./SkillCenterService.js";
import { SkillPackageRepository } from "./SkillPackageRepository.js";
import { SkillPackageStore } from "./SkillPackageStore.js";
import {
  SkillRegistry,
  SkillResolver,
} from "./SkillRuntime.js";
import { PiSkillResources } from "./PiSkillResources.js";
import type { SkillPackageVersion } from "../../../shared/wemail/skillCenter.js";

function harness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-builtins-"));
  const db = openOrCreateMailDatabase(path.join(root, "wemail.sqlite"));
  const packages = new SkillPackageRepository(db);
  const store = new SkillPackageStore({
    userDataDir: path.join(root, "user-data"),
    developmentRoot: process.cwd(),
  });
  const center = new SkillCenterService(packages, store);
  return { root, db, packages, store, center };
}

test("all product Skill packages validate and expose matching UI metadata", () => {
  const { root, db, packages, store, center } = harness();
  try {
    const discovered = store.discoverBuiltInPackages();
    assert.equal(discovered.length, 7);
    for (const packagePath of discovered) {
      const checked = store.inspect(packagePath, "builtin");
      assert.equal(checked.valid, true, checked.issues.join(","));
      assert.ok(checked.displayName);
      assert.ok(checked.description);
      assert.ok(fs.existsSync(path.join(packagePath, "agents", "openai.yaml")));
    }
    const template = store.loadBuiltInPackage(discovered[0]!);
    packages.registerVersion({
      version: {
        ...template.version,
        skillId: "obsolete-builtin",
        manifest: { ...template.version.manifest, id: "obsolete-builtin" },
      },
      displayName: "Obsolete",
      description: "",
      source: "application",
    });
    const summaries = center.synchronizeBuiltIns();
    assert.equal(summaries.length, 7);
    assert.ok(summaries.every((summary) => summary.protected));
    assert.ok(summaries.every((summary) => summary.compatibility === "compatible"));
    assert.ok(!summaries.some((summary) => summary.id === "obsolete-builtin"));
    assert.equal(
      summaries.find((summary) => summary.id === "wemail-insight-report")?.displayName,
      "洞察报告",
    );
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("automation Skill resolves typed dependencies without preloading bodies", () => {
  const { root, db, packages, center } = harness();
  try {
    center.synchronizeBuiltIns();
    const resolver = new SkillResolver(new SkillRegistry(packages));
    const resolved = resolver.resolve({
      explicit: [{ skillId: "wemail-automation-authoring" }],
    });
    assert.deepEqual(
      resolved.versions.map((version) => version.skillId),
      [
        "wemail-data-selection",
        "wemail-data-analysis",
        "wemail-insight-report",
        "wemail-delivery-planning",
        "wemail-automation-authoring",
      ],
    );
    assert.ok(
      !resolved.versions.some(
        (version) => version.skillId === "wemail-skill-authoring",
      ),
    );
    assert.deepEqual(resolved.rootSkillIds, ["wemail-automation-authoring"]);
    const resources = new PiSkillResources(
      new SkillRegistry(packages),
      resolver,
      process.cwd(),
    );
    const prompt = resources.formatPrompt({
      skillSnapshots: [resolved.snapshots.at(-1)],
    });
    assert.match(prompt, /<available_skills>/);
    assert.match(prompt, /wemail-automation-authoring/);
    assert.match(prompt, /wemail-data-selection/);
    assert.doesNotMatch(prompt, /wemail-skill-authoring/);
    assert.doesNotMatch(prompt, /# 自动化规则配置/);
    assert.doesNotMatch(prompt, /states\.md/);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("task-bound hashes outrank later active versions and stale snapshots fail", () => {
  const { root, db, packages, center } = harness();
  try {
    center.synchronizeBuiltIns();
    const resolver = new SkillResolver(new SkillRegistry(packages));
    const active = packages.getActiveVersion("wemail-data-selection")!;
    const resolved = resolver.resolve({
      taskBound: [{
        skillId: active.skillId,
        version: active.version,
        contentHash: active.manifest.contentHash,
        scope: active.scope,
      }],
    });
    assert.equal(resolved.versions[0]?.manifest.contentHash, active.manifest.contentHash);
    assert.throws(
      () =>
        resolver.resolve({
          taskBound: [{
            skillId: active.skillId,
            version: active.version,
            contentHash: "stale",
            scope: active.scope,
          }],
        }),
      /skill-task-snapshot-stale/,
    );
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("each built-in Skill carries its forward behavior contract", () => {
  const expected: Record<string, RegExp[]> = {
    "wemail-data-selection": [/maxMessages/, /日历日/, /样本/],
    "wemail-data-analysis": [/analysis-result/, /分位数/, /coverage/, /token/],
    "wemail-insight-report": [/指标/, /来源/, /publish_design_artifact/, /青瓷蓝/],
    "wemail-delivery-planning": [/消息中心/, /飞书/, /部分成功/],
    "wemail-automation-authoring": [/一次性执行/, /最终确认/, /回读/],
    "wemail-skill-authoring": [/脱敏/, /内容哈希/, /安装/],
    "wemail-local-claude-code": [/start_local_claude_code/, /stream-json/, /taskId/],
  };
  for (const [skillId, patterns] of Object.entries(expected)) {
    const body = fs.readFileSync(
      path.join(process.cwd(), "skills", "builtin", skillId, "SKILL.md"),
      "utf8",
    );
    patterns.forEach((pattern) => assert.match(body, pattern));
  }
});

test("pi native Skill metadata stays resident and read loads files on demand", async () => {
  const { root, db, packages, center } = harness();
  try {
    center.synchronizeBuiltIns();
    const registry = new SkillRegistry(packages);
    const resources = new PiSkillResources(
      registry,
      new SkillResolver(registry),
      process.cwd(),
    );
    const discovered = resources.load();
    const automation = discovered.skills.find(
      (skill) => skill.name === "wemail-automation-authoring",
    );
    assert.ok(automation);
    assert.equal("body" in automation, false);
    const prompt = resources.formatPrompt();
    assert.match(prompt, /Use the read tool/);
    assert.match(prompt, /<location>.*SKILL\.md<\/location>/);
    assert.doesNotMatch(prompt, /# 自动化规则配置/);

    const read = resources.createReadTool();
    const runContext: Record<string, unknown> = {};
    const body = await read.handler(
      { path: automation.filePath },
      { runContext },
    );
    assert.match(String(body), /# 自动化规则配置/);
    assert.deepEqual(
      (runContext.skillReadSnapshots as Array<{ skillId: string }>).map(
        (snapshot) => snapshot.skillId,
      ),
      ["wemail-automation-authoring"],
    );

    const reference = await read.handler(
      { path: path.join(automation.baseDir, "references", "states.md") },
      { runContext },
    );
    assert.match(String(reference), /阻塞|需输入/);
    await assert.rejects(
      read.handler(
        { path: path.join(process.cwd(), "package.json") },
        { runContext },
      ),
      /skill-resource-access-denied/,
    );
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("built-in Skill instructions stay within the resource budget", () => {
  const maxSkillBodyBytes = 16_000;
  const maxReferenceBytes = 128 * 1024;
  const maxTotalBytes = 256 * 1024;
  const builtinRoot = path.join(process.cwd(), "skills", "builtin");
  const skillDirectories = fs.readdirSync(builtinRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory());
  let totalBytes = 0;
  for (const directory of skillDirectories) {
    const root = path.join(builtinRoot, directory.name);
    const bodyBytes = fs.statSync(path.join(root, "SKILL.md")).size;
    assert.ok(bodyBytes < maxSkillBodyBytes, `${directory.name} SKILL.md is too large`);
    totalBytes += bodyBytes;
    const referencesRoot = path.join(root, "references");
    if (!fs.existsSync(referencesRoot)) continue;
    for (const reference of fs.readdirSync(referencesRoot)) {
      const referenceBytes = fs.statSync(path.join(referencesRoot, reference)).size;
      assert.ok(referenceBytes < maxReferenceBytes, `${directory.name}/${reference} is too large`);
      totalBytes += referenceBytes;
    }
  }
  assert.ok(totalBytes < maxTotalBytes, "built-in Skill resource collection is too large");
});

test("resolver rejects dependency cycles and conflicting exact versions", () => {
  const versions = new Map<string, SkillPackageVersion>();
  const make = (
    skillId: string,
    version: string,
    dependencies: SkillPackageVersion["manifest"]["dependencies"],
  ): SkillPackageVersion => ({
    skillId,
    version,
    scope: "personal",
    packagePath: process.cwd(),
    manifest: {
      schemaVersion: 1,
      id: skillId,
      version,
      scope: "personal",
      entry: "SKILL.md",
      inputKinds: [],
      outputKinds: ["pipeline-draft"],
      dependencies,
      toolAllowlist: [],
      requestedPermissions: [],
      reviewPolicy: "none",
      contentHash: `${skillId}-${version}`,
    },
    compatibility: "compatible",
    compatibilityIssues: [],
    enabled: true,
    active: true,
    installedAt: "2026-07-29T00:00:00.000Z",
    createdAt: "2026-07-29T00:00:00.000Z",
    updatedAt: "2026-07-29T00:00:00.000Z",
  });
  versions.set("a@1.0.0", make("a", "1.0.0", [{ skillId: "b", version: "1.0.0" }]));
  versions.set("b@1.0.0", make("b", "1.0.0", [{ skillId: "a", version: "1.0.0" }]));
  const cycleRegistry = {
    active: (id: string) => versions.get(`${id}@1.0.0`) ?? null,
    exact: (id: string, version: string) => versions.get(`${id}@${version}`) ?? null,
  };
  assert.throws(
    () =>
      new SkillResolver(cycleRegistry as never).resolve({
        explicit: [{ skillId: "a", version: "1.0.0" }],
      }),
    /skill-dependency-cycle/,
  );

  versions.clear();
  versions.set("root-a@1.0.0", make("root-a", "1.0.0", [{ skillId: "shared", version: "1.0.0" }]));
  versions.set("root-b@1.0.0", make("root-b", "1.0.0", [{ skillId: "shared", version: "2.0.0" }]));
  versions.set("shared@1.0.0", make("shared", "1.0.0", []));
  versions.set("shared@2.0.0", make("shared", "2.0.0", []));
  const conflictRegistry = {
    active: (id: string) => versions.get(`${id}@1.0.0`) ?? null,
    exact: (id: string, version: string) => versions.get(`${id}@${version}`) ?? null,
  };
  assert.throws(
    () =>
      new SkillResolver(conflictRegistry as never).resolve({
        explicit: [
          { skillId: "root-a", version: "1.0.0" },
          { skillId: "root-b", version: "1.0.0" },
        ],
      }),
    /skill-version-conflict/,
  );
});
