import type {
  SkillContentEntry,
  SkillContentResponse,
  SkillPackageVersion,
  SkillSummary,
} from "../../../shared/wemail/skillCenter.js";
import { SkillPackageRepository } from "./SkillPackageRepository.js";
import { SkillPackageStore } from "./SkillPackageStore.js";

export class SkillCenterService {
  constructor(
    private readonly packages: SkillPackageRepository,
    private readonly store: SkillPackageStore,
  ) {}

  /** The scanned external-skills root (see SkillPackageStore.externalRoot). */
  get externalRoot(): string {
    return this.store.externalRoot;
  }

  synchronizeBuiltIns(): SkillSummary[] {
    const skillIds: string[] = [];
    for (const packageDir of this.store.discoverBuiltInPackages()) {
      const loaded = this.store.loadBuiltInPackage(packageDir);
      skillIds.push(loaded.version.skillId);
      this.packages.registerVersion({
        version: loaded.version,
        displayName: loaded.displayName,
        description: loaded.description,
        source: "application",
        protected: loaded.version.manifest.protected,
      });
    }
    this.packages.removeUnreferencedApplicationPackagesExcept(skillIds);
    return this.list();
  }

  /**
   * Index skills dropped into the external root (`<userDataDir>/skills/external`)
   * into the cache, in place — no copy/staging. Idempotent: a package whose
   * skillId+version is already registered is skipped. Invalid packages are
   * skipped (best-effort), never fatal, so a bad external folder can't break
   * the Skill Center.
   *
   * Registered as `source: "manual"` (the DB CHECK on skill_packages.source
   * allows application/import/agent/manual; "discovered" would need a
   * migration, so we reuse the "manual" bucket for externally-placed skills).
   */
  synchronizeExternal(): SkillSummary[] {
    for (const packageDir of this.store.discoverExternalPackages()) {
      try {
        const loaded = this.store.loadExternalPackage(packageDir);
        if (
          this.packages.getVersion(
            loaded.version.skillId,
            loaded.version.version,
          )
        ) {
          continue;
        }
        this.packages.registerVersion({
          version: loaded.version,
          displayName: loaded.displayName,
          description: loaded.description,
          source: "manual",
        });
      } catch {
        // A malformed external package is ignored; the rest still sync.
      }
    }
    return this.list();
  }

  installPersonalFromDirectory(
    sourceDirectory: string,
    source: "import" | "agent" | "manual" = "import",
  ): SkillPackageVersion {
    const installed = this.store.installPersonalPackage(sourceDirectory);
    try {
      return this.packages.registerVersion({
        version: installed.version,
        displayName: installed.displayName,
        description: installed.description,
        source,
      });
    } catch (error) {
      if (!this.packages.getVersion(
        installed.version.skillId,
        installed.version.version,
      )) {
        this.store.removePersonalVersionFiles(
          installed.version.skillId,
          installed.version.version,
        );
      }
      throw error;
    }
  }

  list(): SkillSummary[] {
    return this.packages.list();
  }

  inspect(skillId: string, version?: string): SkillPackageVersion {
    const found = version
      ? this.packages.getVersion(skillId, version)
      : this.packages.getActiveVersion(skillId);
    if (!found) throw new Error("skill-version-not-found");
    return this.verify(found);
  }

  readSkillMarkdown(
    skillId: string,
    version?: string,
  ): SkillContentResponse {
    const selected = this.inspect(skillId, version);
    const file = path.join(selected.packagePath, selected.manifest.entry);
    return {
      skillId: selected.skillId,
      version: selected.version,
      contentHash: selected.manifest.contentHash,
      markdown: fs.readFileSync(file, "utf8"),
      entries: listPackageEntries(selected.packagePath),
    };
  }

  setEnabled(skillId: string, enabled: boolean): SkillSummary {
    return this.packages.setEnabled(skillId, enabled);
  }

  activateVersion(skillId: string, version: string): SkillSummary {
    const selected = this.packages.getVersion(skillId, version);
    if (!selected) throw new Error("skill-version-not-found");
    const verified = this.verify(selected);
    if (
      verified.compatibility === "tampered" ||
      verified.compatibility === "incompatible"
    ) {
      throw new Error("skill-version-not-activatable");
    }
    return this.packages.activateVersion(skillId, version);
  }

  exportPersonalVersion(
    skillId: string,
    version: string,
    destinationDirectory: string,
  ): string {
    const selected = this.packages.getVersion(skillId, version);
    if (!selected) throw new Error("skill-version-not-found");
    if (selected.scope !== "personal") {
      throw new Error("builtin-skill-export-requires-personal-copy");
    }
    this.verify(selected);
    return this.store.exportVersion(
      skillId,
      version,
      destinationDirectory,
    );
  }

  deletePersonalVersion(skillId: string, version: string): void {
    this.packages.deletePersonalVersion(skillId, version);
    this.store.removePersonalVersionFiles(skillId, version);
  }

  private verify(version: SkillPackageVersion): SkillPackageVersion {
    const checked = this.store.inspect(
      version.packagePath,
      version.scope,
      { id: version.skillId, version: version.version },
    );
    if (
      !checked.valid ||
      checked.contentHash !== version.manifest.contentHash
    ) {
      return {
        ...version,
        compatibility: "tampered",
        compatibilityIssues: Array.from(
          new Set([
            ...version.compatibilityIssues,
            ...checked.issues,
            "skill-content-hash-mismatch",
          ]),
        ),
      };
    }
    return version;
  }
}
import fs from "node:fs";
import path from "node:path";

function listPackageEntries(root: string): SkillContentEntry[] {
  const entries: SkillContentEntry[] = [];

  const visit = (directory: string, relativeDirectory: string) => {
    const children = fs
      .readdirSync(directory, { withFileTypes: true })
      .filter((entry) => !entry.isSymbolicLink())
      .sort((left, right) => {
        if (left.name === "SKILL.md") return -1;
        if (right.name === "SKILL.md") return 1;
        if (left.isDirectory() !== right.isDirectory()) {
          return left.isDirectory() ? -1 : 1;
        }
        return left.name.localeCompare(right.name);
      });

    for (const child of children) {
      const relativePath = relativeDirectory
        ? path.posix.join(relativeDirectory, child.name)
        : child.name;
      entries.push({
        path: relativePath,
        kind: child.isDirectory() ? "directory" : "file",
      });
      if (child.isDirectory()) {
        visit(path.join(directory, child.name), relativePath);
      }
    }
  };

  visit(root, "");
  return entries;
}
