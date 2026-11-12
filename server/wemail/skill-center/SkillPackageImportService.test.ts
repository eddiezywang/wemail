import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import yazl from "yazl";
import { openOrCreateMailDatabase } from "../database/Database.js";
import { SkillCenterService } from "./SkillCenterService.js";
import {
  SkillPackageImportService,
  validateSkillZipEntry,
} from "./SkillPackageImportService.js";
import { SkillPackageRepository } from "./SkillPackageRepository.js";
import { SkillPackageStore } from "./SkillPackageStore.js";
import { SkillPackageValidator } from "./SkillPackageValidator.js";

function packageFiles(input: {
  id: string;
  version?: string;
  tools?: string[];
  permissions?: string[];
}) {
  return {
    skill: `---\nname: ${input.id}\ndescription: Imported test Skill\n---\n\nFollow this workflow.\n`,
    manifest: JSON.stringify({
      schemaVersion: 1,
      id: input.id,
      version: input.version ?? "1.0.0",
      scope: "personal",
      entry: "SKILL.md",
      inputKinds: [],
      outputKinds: ["pipeline-draft"],
      dependencies: [],
      toolAllowlist: input.tools ?? [],
      requestedPermissions: input.permissions ?? [],
      reviewPolicy: "recommended",
      contentHash: "pending",
    }),
  };
}

function writeFolder(root: string, input: Parameters<typeof packageFiles>[0]) {
  const files = packageFiles(input);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "SKILL.md"), files.skill);
  fs.writeFileSync(path.join(root, "wemail.skill.json"), files.manifest);
}

async function writeZip(
  file: string,
  input: Parameters<typeof packageFiles>[0],
) {
  const files = packageFiles(input);
  const zip = new yazl.ZipFile();
  zip.addBuffer(Buffer.from(files.skill), `${input.id}/SKILL.md`);
  zip.addBuffer(
    Buffer.from(files.manifest),
    `${input.id}/wemail.skill.json`,
  );
  zip.end();
  await new Promise<void>((resolve, reject) => {
    const output = fs.createWriteStream(file);
    zip.outputStream.pipe(output);
    output.on("close", resolve);
    output.on("error", reject);
  });
}

function harness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-import-"));
  const db = openOrCreateMailDatabase(path.join(root, "wemail.sqlite"));
  const repository = new SkillPackageRepository(db);
  const store = new SkillPackageStore({
    userDataDir: path.join(root, "user-data"),
    developmentRoot: root,
    knownTools: new Set(["query_mail", "render_report_preview"]),
  });
  const center = new SkillCenterService(repository, store);
  return {
    root,
    db,
    store,
    center,
    importer: new SkillPackageImportService(center),
  };
}

test("Skill import accepts a safe ZIP and installs from its managed copy", async () => {
  const { root, db, importer } = harness();
  try {
    const zip = path.join(root, "report.zip");
    await writeZip(zip, {
      id: "zip-report",
      tools: ["query_mail"],
    });
    const installed = await importer.importPath(zip);
    assert.equal(installed.skillId, "zip-report");
    assert.equal(installed.compatibility, "compatible");
    assert.ok(installed.packagePath.includes("user-data"));
    fs.rmSync(zip);
    assert.ok(fs.existsSync(path.join(installed.packagePath, "SKILL.md")));
  } finally {
    db.close();
  }
});

test("Skill import preview does not install and confirmation binds the exact hash", async () => {
  const { root, db, importer, center } = harness();
  try {
    const folder = path.join(root, "confirmed-report");
    writeFolder(folder, { id: "confirmed-report" });
    const preview = await importer.previewPath(folder);
    assert.equal(preview.valid, true);
    assert.ok(preview.contentHash);
    assert.equal(center.list().length, 0);
    await assert.rejects(
      () => importer.importConfirmed(folder, "wrong-hash"),
      /confirmation-hash-mismatch/,
    );
    assert.equal(center.list().length, 0);
    const installed = await importer.importConfirmed(
      folder,
      preview.contentHash!,
    );
    assert.equal(installed.manifest.contentHash, preview.contentHash);
    assert.equal(center.list().length, 1);
  } finally {
    db.close();
  }
});

test("Skill ZIP path validation rejects traversal and absolute entries", () => {
  for (const entry of [
    "../escape.txt",
    "nested/../../escape.txt",
    "/absolute.txt",
    "C:/absolute.txt",
    "nested\\windows.txt",
  ]) {
    assert.throws(() => validateSkillZipEntry(entry), /path-invalid/);
  }
});

test("Skill validation reports unsupported tools and keeps scripts inert", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-validate-"));
  writeFolder(root, {
    id: "scripted-report",
    tools: ["unknown_tool"],
  });
  fs.mkdirSync(path.join(root, "scripts"));
  fs.writeFileSync(path.join(root, "scripts", "run.js"), "process.exit(0)");
  const result = new SkillPackageValidator().validateDirectory(root, {
    scope: "personal",
    knownTools: new Set(["query_mail"]),
  });
  assert.equal(result.valid, true);
  assert.equal(result.compatibility, "partially_compatible");
  assert.ok(result.warnings.includes("unsupported-tool:unknown_tool"));
  assert.ok(result.warnings.includes("personal-scripts-are-inert"));
});

test("Skill validation rejects forbidden execution permissions", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-forbidden-"));
  writeFolder(root, {
    id: "unsafe-report",
    permissions: ["shell", "filesystem.unrestricted"],
  });
  const result = new SkillPackageValidator().validateDirectory(root, {
    scope: "personal",
  });
  assert.equal(result.valid, false);
  assert.ok(
    result.issues.some((issue) => issue === "skill-permission-forbidden:shell"),
  );
});

test("Skill validation rejects symbolic links", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-link-"));
  writeFolder(root, { id: "linked-report" });
  try {
    fs.symlinkSync(path.join(root, "SKILL.md"), path.join(root, "linked.md"));
  } catch (error) {
    // Windows without developer mode cannot create symlinks; POSIX runners
    // (and developer-mode Windows) exercise the real security check.
    context.skip(`symlink creation unavailable: ${(error as Error).message}`);
    return;
  }
  // A real symlink is refused by the package scanner. Depending on where the
  // scan happens the validator either returns `valid: false` with a
  // `link-forbidden` issue, or refuses to hash the package at all and throws
  // the same issue. Both are the intended security policy — never accept the
  // link and never weaken the validator to make hashing succeed.
  let result: ReturnType<SkillPackageValidator["validateDirectory"]>;
  try {
    result = new SkillPackageValidator().validateDirectory(root, {
      scope: "personal",
    });
  } catch (error) {
    assert.match(String((error as Error).message), /link-forbidden/);
    return;
  }
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) => issue.includes("link-forbidden")));
});
