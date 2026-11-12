import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  SkillPackageManifest,
  SkillPackageVersion,
  SkillScope,
} from "../../../shared/wemail/skillCenter.js";
import {
  SkillPackageValidator,
  hashPackageDirectory,
} from "./SkillPackageValidator.js";

export interface SkillPackageStoreOptions {
  userDataDir: string;
  resourcesPath?: string;
  developmentRoot?: string;
  now?: () => string;
  knownTools?: ReadonlySet<string>;
}

export class SkillPackageStore {
  readonly personalRoot: string;
  /**
   * Scanned "external" skills root (`<userDataDir>/skills/external`). Drop a
   * package directory (containing SKILL.md) here and `synchronizeExternal()`
   * picks it up — no copy, no staging. This is the lightweight entry the
   * WeCLI install pipeline targets: pm-cli installs wecli-usage, WeMail moves
   * a copy here, and the Skill Center indexes it in place.
   */
  readonly externalRoot: string;
  readonly builtinRoots: string[];
  private readonly now: () => string;
  private readonly validator = new SkillPackageValidator();
  private readonly knownTools?: ReadonlySet<string>;

  constructor(options: SkillPackageStoreOptions) {
    this.personalRoot = path.join(
      path.resolve(options.userDataDir),
      "skills",
      "packages",
      "personal",
    );
    this.externalRoot = path.join(
      path.resolve(options.userDataDir),
      "skills",
      "external",
    );
    this.builtinRoots = resolveBuiltInSkillRoots({
      resourcesPath: options.resourcesPath,
      developmentRoot: options.developmentRoot,
    });
    this.now = options.now ?? (() => new Date().toISOString());
    this.knownTools = options.knownTools;
    fs.mkdirSync(this.personalRoot, { recursive: true });
    fs.mkdirSync(this.externalRoot, { recursive: true });
  }

  discoverBuiltInPackages(): string[] {
    const packages: string[] = [];
    for (const root of this.builtinRoots) {
      if (!fs.existsSync(root)) continue;
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const packageDir = path.join(root, entry.name);
        if (fs.existsSync(path.join(packageDir, "SKILL.md"))) {
          packages.push(packageDir);
        }
      }
    }
    return Array.from(new Set(packages.map((item) => path.resolve(item))));
  }

  /**
   * Scan {@link externalRoot} for package directories (one skill per immediate
   * subdirectory containing SKILL.md). Mirrors {@link discoverBuiltInPackages}
   * but over the single external root.
   */
  discoverExternalPackages(): string[] {
    if (!fs.existsSync(this.externalRoot)) return [];
    const packages: string[] = [];
    for (const entry of fs.readdirSync(this.externalRoot, {
      withFileTypes: true,
    })) {
      if (!entry.isDirectory()) continue;
      const packageDir = path.join(this.externalRoot, entry.name);
      if (fs.existsSync(path.join(packageDir, "SKILL.md"))) {
        packages.push(packageDir);
      }
    }
    return packages.map((item) => path.resolve(item));
  }

  inspect(
    packageDir: string,
    scope: SkillScope,
    expected?: { id?: string; version?: string },
  ) {
    return this.validator.validateDirectory(packageDir, {
      scope,
      knownTools: this.knownTools,
      expectedId: expected?.id,
      expectedVersion: expected?.version,
    });
  }

  installPersonalPackage(sourceDir: string): {
    version: SkillPackageVersion;
    displayName: string;
    description: string;
    warnings: string[];
  } {
    const inspected = this.inspect(sourceDir, "personal");
    if (!inspected.valid || !inspected.manifest) {
      throw new Error(
        `skill-package-invalid:${inspected.issues.join(",") || "unknown"}`,
      );
    }
    const manifestBase: SkillPackageManifest = {
      ...inspected.manifest,
      scope: "personal",
    };
    const skillRoot = this.safePersonalSkillRoot(manifestBase.id);
    const target = this.safePersonalVersionPath(
      manifestBase.id,
      manifestBase.version,
    );
    const staging = path.join(
      skillRoot,
      `.install-${manifestBase.version}-${randomUUID()}`,
    );
    fs.mkdirSync(skillRoot, { recursive: true });

    try {
      fs.cpSync(path.resolve(sourceDir), staging, {
        recursive: true,
        errorOnExist: true,
        force: false,
        dereference: false,
      });
      // Materialize the manifest in the staged copy so the content hash covers
      // the final layout even when the source is frontmatter-only (e.g. a skill
      // installed by pm-cli under ~/.claude/skills). The hash is stamped below.
      fs.writeFileSync(
        path.join(staging, "wemail.skill.json"),
        `${JSON.stringify({ ...manifestBase, contentHash: "pending" }, null, 2)}\n`,
        "utf8",
      );
      const staged = this.inspect(staging, "personal", {
        id: manifestBase.id,
        version: manifestBase.version,
      });
      if (!staged.valid || !staged.manifest || !staged.contentHash) {
        throw new Error(
          `skill-staged-package-invalid:${staged.issues.join(",")}`,
        );
      }
      const manifest: SkillPackageManifest = {
        ...manifestBase,
        contentHash: staged.contentHash,
      };
      fs.writeFileSync(
        path.join(staging, "wemail.skill.json"),
        `${JSON.stringify(manifest, null, 2)}\n`,
        "utf8",
      );

      if (fs.existsSync(target)) {
        const existingHash = hashPackageDirectory(target, manifest);
        if (existingHash !== manifest.contentHash) {
          throw new Error("skill-version-already-exists-with-different-content");
        }
        fs.rmSync(staging, { recursive: true, force: true });
        return {
          version: this.packageVersion(
            target,
            manifest,
            staged.compatibility,
            [...staged.issues, ...staged.warnings],
          ),
          displayName: manifest.displayName ?? staged.displayName ?? manifest.id,
          description: manifest.description ?? staged.description ?? "",
          warnings: staged.warnings,
        };
      }

      fs.renameSync(staging, target);
      return {
        version: this.packageVersion(
          target,
          manifest,
          staged.compatibility,
          [...staged.issues, ...staged.warnings],
        ),
        displayName: manifest.displayName ?? staged.displayName ?? manifest.id,
        description: manifest.description ?? staged.description ?? "",
        warnings: staged.warnings,
      };
    } catch (error) {
      fs.rmSync(staging, { recursive: true, force: true });
      throw error;
    }
  }

  loadBuiltInPackage(packageDir: string): {
    version: SkillPackageVersion;
    displayName: string;
    description: string;
    warnings: string[];
  } {
    return this.loadInPlacePackage(packageDir, "builtin");
  }

  /**
   * Validate + load an external skill in place (no copy). Used by
   * `synchronizeExternal()` for packages dropped into {@link externalRoot}.
   */
  loadExternalPackage(packageDir: string): {
    version: SkillPackageVersion;
    displayName: string;
    description: string;
    warnings: string[];
  } {
    return this.loadInPlacePackage(packageDir, "personal");
  }

  private loadInPlacePackage(
    packageDir: string,
    scope: SkillScope,
  ): {
    version: SkillPackageVersion;
    displayName: string;
    description: string;
    warnings: string[];
  } {
    const inspected = this.inspect(packageDir, scope);
    if (!inspected.valid || !inspected.manifest || !inspected.contentHash) {
      throw new Error(
        `${scope}-skill-package-invalid:${inspected.issues.join(",")}`,
      );
    }
    const manifest = {
      ...inspected.manifest,
      scope,
      contentHash: inspected.contentHash,
    };
    return {
      version: this.packageVersion(
        path.resolve(packageDir),
        manifest,
        inspected.compatibility,
        [...inspected.issues, ...inspected.warnings],
      ),
      displayName: manifest.displayName ?? inspected.displayName ?? manifest.id,
      description: manifest.description ?? inspected.description ?? "",
      warnings: inspected.warnings,
    };
  }

  exportVersion(
    skillId: string,
    version: string,
    destinationDirectory: string,
  ): string {
    const source = this.safePersonalVersionPath(skillId, version);
    if (!fs.existsSync(source)) throw new Error("skill-version-not-found");
    const destinationRoot = path.resolve(destinationDirectory);
    fs.mkdirSync(destinationRoot, { recursive: true });
    const target = path.join(destinationRoot, `${skillId}-${version}`);
    if (fs.existsSync(target)) throw new Error("skill-export-target-exists");
    fs.cpSync(source, target, {
      recursive: true,
      errorOnExist: true,
      force: false,
      dereference: false,
    });
    return target;
  }

  removePersonalVersionFiles(skillId: string, version: string): void {
    const target = this.safePersonalVersionPath(skillId, version);
    if (!fs.existsSync(target)) return;
    fs.rmSync(target, { recursive: true, force: true });
    const skillRoot = this.safePersonalSkillRoot(skillId);
    if (
      fs.existsSync(skillRoot) &&
      fs.readdirSync(skillRoot).filter((name) => !name.startsWith(".install-"))
        .length === 0
    ) {
      fs.rmSync(skillRoot, { recursive: true, force: true });
    }
  }

  private packageVersion(
    packagePath: string,
    manifest: SkillPackageManifest,
    compatibility: SkillPackageVersion["compatibility"],
    compatibilityIssues: string[],
  ): SkillPackageVersion {
    const now = this.now();
    return {
      skillId: manifest.id,
      version: manifest.version,
      scope: manifest.scope,
      packagePath,
      manifest,
      compatibility,
      compatibilityIssues,
      enabled: true,
      active: true,
      installedAt: now,
      createdAt: now,
      updatedAt: now,
    };
  }

  private safePersonalSkillRoot(skillId: string): string {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skillId)) {
      throw new Error("skill-id-invalid");
    }
    const resolved = path.resolve(this.personalRoot, skillId);
    if (!isInside(this.personalRoot, resolved)) {
      throw new Error("skill-path-outside-managed-root");
    }
    return resolved;
  }

  private safePersonalVersionPath(skillId: string, version: string): string {
    if (!/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/.test(version)) {
      throw new Error("skill-version-invalid");
    }
    const root = this.safePersonalSkillRoot(skillId);
    const resolved = path.resolve(root, version);
    if (!isInside(root, resolved)) {
      throw new Error("skill-version-path-outside-managed-root");
    }
    return resolved;
  }
}

export function resolveBuiltInSkillRoots(input: {
  resourcesPath?: string;
  developmentRoot?: string;
}): string[] {
  return [
    input.resourcesPath
      ? path.join(path.resolve(input.resourcesPath), "skills", "builtin")
      : undefined,
    input.developmentRoot
      ? path.join(path.resolve(input.developmentRoot), "skills", "builtin")
      : path.join(process.cwd(), "skills", "builtin"),
  ].filter((value): value is string => !!value);
}

function isInside(root: string, candidate: string): boolean {
  const normalizedRoot = path.resolve(root);
  const normalizedCandidate = path.resolve(candidate);
  return (
    normalizedCandidate === normalizedRoot ||
    normalizedCandidate.startsWith(`${normalizedRoot}${path.sep}`)
  );
}
