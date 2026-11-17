import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { openOrCreateMailDatabase } from "../database/Database.js";
import {
  SkillPackageRepository,
  SkillVersionReferencedError,
} from "./SkillPackageRepository.js";
import { SkillPackageStore } from "./SkillPackageStore.js";
import { SkillCenterService } from "./SkillCenterService.js";

function writePackage(
  root: string,
  input: {
    id: string;
    version: string;
    scope?: "builtin" | "personal";
    protected?: boolean;
    body?: string;
  },
) {
  const directory = path.join(root, input.id);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, "SKILL.md"),
    `---\nname: ${input.id}\ndescription: Test ${input.id}\n---\n\n${input.body ?? "Follow the workflow."}\n`,
  );
  fs.writeFileSync(
    path.join(directory, "wemail.skill.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        id: input.id,
        version: input.version,
        scope: input.scope ?? "personal",
        entry: "SKILL.md",
        protected: input.protected ?? false,
        inputKinds: [],
        outputKinds: ["pipeline-draft"],
        dependencies: [],
        toolAllowlist: [],
        requestedPermissions: [],
        reviewPolicy: "recommended",
        contentHash: "pending",
      },
      null,
      2,
    ),
  );
  return directory;
}

function harness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-skills-"));
  const userData = path.join(root, "user-data");
  const db = openOrCreateMailDatabase(path.join(root, "wemail.sqlite"));
  const packages = new SkillPackageRepository(
    db,
    () => "2026-07-29T00:00:00.000Z",
  );
  const store = new SkillPackageStore({
    userDataDir: userData,
    developmentRoot: root,
    now: () => "2026-07-29T00:00:00.000Z",
  });
  return {
    root,
    db,
    packages,
    store,
    service: new SkillCenterService(packages, store),
  };
}

test("Skill Center installs immutable personal versions and supports rollback", () => {
  const { root, db, service } = harness();
  try {
    const first = writePackage(path.join(root, "imports-v1"), {
      id: "daily-report",
      version: "1.0.0",
    });
    service.installPersonalFromDirectory(first);
    const second = writePackage(path.join(root, "imports-v2"), {
      id: "daily-report",
      version: "2.0.0",
      body: "Use the accepted chart recipe.",
    });
    service.installPersonalFromDirectory(second);

    const summary = service.list().find((item) => item.id === "daily-report");
    assert.deepEqual(summary?.versions, ["1.0.0", "2.0.0"]);
    assert.equal(summary?.activeVersion, "2.0.0");
    service.activateVersion("daily-report", "1.0.0");
    assert.equal(
      service.list().find((item) => item.id === "daily-report")?.activeVersion,
      "1.0.0",
    );
  } finally {
    db.close();
  }
});

test("Skill Center detects managed package tampering", () => {
  const { root, db, service } = harness();
  try {
    const source = writePackage(path.join(root, "imports"), {
      id: "safe-report",
      version: "1.0.0",
    });
    const installed = service.installPersonalFromDirectory(source);
    fs.appendFileSync(path.join(installed.packagePath, "SKILL.md"), "\nchanged");

    const inspected = service.inspect("safe-report", "1.0.0");
    assert.equal(inspected.compatibility, "tampered");
    assert.throws(
      () => service.activateVersion("safe-report", "1.0.0"),
      /not-activatable/,
    );
  } finally {
    db.close();
  }
});

test("Skill Center preserves versions referenced by automation rules", () => {
  const { root, db, packages, service } = harness();
  try {
    const source = writePackage(path.join(root, "imports"), {
      id: "referenced-report",
      version: "1.0.0",
    });
    service.installPersonalFromDirectory(source);
    packages.addUsage({
      skillId: "referenced-report",
      skillVersion: "1.0.0",
      referenceType: "automation_rule",
      referenceId: "rule-1",
    });

    assert.throws(
      () => service.deletePersonalVersion("referenced-report", "1.0.0"),
      SkillVersionReferencedError,
    );
    assert.ok(service.inspect("referenced-report", "1.0.0"));
  } finally {
    db.close();
  }
});

test("personal package cannot shadow a protected built-in Skill", () => {
  const { root, db, packages, store, service } = harness();
  try {
    const builtinRoot = path.join(root, "skills", "builtin");
    const builtin = writePackage(builtinRoot, {
      id: "wemail-skill-authoring",
      version: "1.0.0",
      scope: "builtin",
      protected: true,
    });
    const loaded = store.loadBuiltInPackage(builtin);
    packages.registerVersion({
      version: loaded.version,
      displayName: loaded.displayName,
      description: loaded.description,
      source: "application",
      protected: true,
    });

    const personal = writePackage(path.join(root, "imports"), {
      id: "wemail-skill-authoring",
      version: "2.0.0",
    });
    assert.throws(
      () => service.installPersonalFromDirectory(personal),
      /scope-cannot-change|protected/,
    );
  } finally {
    db.close();
  }
});

test("built-in application upgrade preserves personal Skill versions", () => {
  const { root, db, service } = harness();
  try {
    const builtinRoot = path.join(root, "skills", "builtin");
    const builtin = writePackage(builtinRoot, {
      id: "wemail-data-selection",
      version: "1.0.0",
      scope: "builtin",
    });
    service.synchronizeBuiltIns();
    const personal = writePackage(path.join(root, "imports"), {
      id: "my-mail-scope",
      version: "1.0.0",
    });
    service.installPersonalFromDirectory(personal);

    fs.writeFileSync(
      path.join(builtin, "wemail.skill.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          id: "wemail-data-selection",
          version: "2.0.0",
          scope: "builtin",
          entry: "SKILL.md",
          inputKinds: [],
          outputKinds: ["data-selection"],
          dependencies: [],
          toolAllowlist: [],
          requestedPermissions: [],
          reviewPolicy: "recommended",
          contentHash: "pending",
        },
        null,
        2,
      ),
    );
    service.synchronizeBuiltIns();

    assert.deepEqual(
      service
        .list()
        .find((skill) => skill.id === "wemail-data-selection")?.versions,
      ["1.0.0", "2.0.0"],
    );
    assert.deepEqual(
      service.list().find((skill) => skill.id === "my-mail-scope")?.versions,
      ["1.0.0"],
    );
  } finally {
    db.close();
  }
});

test("failed conflicting install leaves no staging directory", () => {
  const { root, db, service } = harness();
  try {
    const first = writePackage(path.join(root, "imports-a"), {
      id: "stable-report",
      version: "1.0.0",
      body: "First body.",
    });
    const installed = service.installPersonalFromDirectory(first);
    const second = writePackage(path.join(root, "imports-b"), {
      id: "stable-report",
      version: "1.0.0",
      body: "Different body.",
    });
    assert.throws(
      () => service.installPersonalFromDirectory(second),
      /different-content/,
    );
    const versionRoot = path.dirname(installed.packagePath);
    assert.deepEqual(
      fs.readdirSync(versionRoot).filter((name) => name.startsWith(".install-")),
      [],
    );
    assert.equal(
      fs.readFileSync(path.join(installed.packagePath, "SKILL.md"), "utf8")
        .includes("First body."),
      true,
    );
  } finally {
    db.close();
  }
});

test("Skill Center exposes the installed package structure with its markdown", () => {
  const { root, db, service } = harness();
  try {
    const source = writePackage(path.join(root, "structure-import"), {
      id: "structured-report",
      version: "1.0.0",
      body: "# Structured report\n\nFollow the documented workflow.",
    });
    fs.mkdirSync(path.join(source, "references"), { recursive: true });
    fs.writeFileSync(
      path.join(source, "references", "guide.md"),
      "# Guide\n",
    );
    service.installPersonalFromDirectory(source);

    const content = service.readSkillMarkdown("structured-report");
    assert.equal(content.markdown.includes("# Structured report"), true);
    assert.deepEqual(content.entries, [
      { path: "SKILL.md", kind: "file" },
      { path: "references", kind: "directory" },
      { path: "references/guide.md", kind: "file" },
      { path: "wemail.skill.json", kind: "file" },
    ]);
  } finally {
    db.close();
  }
});

test("synchronizeExternal indexes skills dropped into the external root in place", () => {
  const { db, store, service } = harness();
  try {
    writePackage(store.externalRoot, {
      id: "wecli-usage",
      version: "1.0.0",
    });
    // Not visible until synchronised.
    assert.equal(
      service.list().find((skill) => skill.id === "wecli-usage"),
      undefined,
    );
    service.synchronizeExternal();
    const summary = service.list().find((skill) => skill.id === "wecli-usage");
    assert.ok(summary, "external skill should be listed after sync");
    assert.equal(summary?.scope, "personal");
    assert.equal(summary?.source, "manual");
    assert.equal(summary?.activeVersion, "1.0.0");
    // Idempotent: a second sync does not duplicate the package row.
    service.synchronizeExternal();
    assert.equal(
      service.list().filter((skill) => skill.id === "wecli-usage").length,
      1,
    );
  } finally {
    db.close();
  }
});

test("synchronizeExternal skips malformed external packages without failing", () => {
  const { db, store, service } = harness();
  try {
    // A directory with SKILL.md but a broken manifest should be ignored.
    const broken = path.join(store.externalRoot, "broken-skill");
    fs.mkdirSync(broken, { recursive: true });
    fs.writeFileSync(path.join(broken, "SKILL.md"), "# broken\n");
    fs.writeFileSync(
      path.join(broken, "wemail.skill.json"),
      "{ not valid json",
    );
    // A valid sibling still syncs.
    writePackage(store.externalRoot, {
      id: "good-external",
      version: "1.2.0",
    });
    service.synchronizeExternal();
    assert.ok(service.list().find((skill) => skill.id === "good-external"));
    assert.equal(
      service.list().find((skill) => skill.id === "broken-skill"),
      undefined,
    );
  } finally {
    db.close();
  }
});
