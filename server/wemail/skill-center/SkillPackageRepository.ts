import { randomUUID } from "node:crypto";
import type {
  SkillPackageVersion,
  SkillSummary,
  SkillUsageReference,
} from "../../../shared/wemail/skillCenter.js";
import type { MailDatabase } from "../database/Database.js";

interface PackageRow {
  id: string;
  scope: SkillSummary["scope"];
  display_name: string;
  description: string;
  source: SkillSummary["source"];
  active_version: string;
  enabled: number;
  protected: number;
  created_at: string;
  updated_at: string;
}

interface VersionRow {
  skill_id: string;
  version: string;
  scope: SkillPackageVersion["scope"];
  package_path: string;
  manifest_json: string;
  content_hash: string;
  compatibility: SkillPackageVersion["compatibility"];
  compatibility_issues_json: string;
  installed_at: string;
  created_at: string;
  updated_at: string;
}

export class SkillVersionReferencedError extends Error {
  constructor(readonly references: SkillUsageReference[]) {
    super("skill-version-is-referenced");
    this.name = "SkillVersionReferencedError";
  }
}

export class SkillPackageRepository {
  constructor(
    private readonly db: MailDatabase,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  registerVersion(input: {
    version: SkillPackageVersion;
    displayName: string;
    description: string;
    source: SkillSummary["source"];
    protected?: boolean;
    activate?: boolean;
  }): SkillPackageVersion {
    const now = this.now();
    this.db.transaction(() => {
      const existing = this.db
        .prepare("SELECT * FROM skill_packages WHERE id = ?")
        .get(input.version.skillId) as PackageRow | undefined;
      if (existing && existing.scope !== input.version.scope) {
        throw new Error("skill-scope-cannot-change");
      }
      if (
        existing?.protected &&
        input.version.scope === "personal"
      ) {
        throw new Error("protected-skill-cannot-be-shadowed");
      }
      if (!existing) {
        this.db
          .prepare(
            `INSERT INTO skill_packages (
              id, scope, display_name, description, source, active_version,
              enabled, protected, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            input.version.skillId,
            input.version.scope,
            input.displayName,
            input.description,
            input.source,
            input.version.version,
            input.version.enabled ? 1 : 0,
            input.protected ? 1 : 0,
            now,
            now,
          );
      } else {
        this.db
          .prepare(
            `UPDATE skill_packages SET
              display_name = ?, description = ?, source = ?,
              active_version = ?, enabled = ?, protected = ?, updated_at = ?
             WHERE id = ?`,
          )
          .run(
            input.displayName,
            input.description,
            input.source,
            input.activate === false
              ? existing.active_version
              : input.version.version,
            input.version.enabled ? 1 : 0,
            existing.protected || input.protected ? 1 : 0,
            now,
            input.version.skillId,
          );
      }

      this.db
        .prepare(
          `INSERT INTO skill_versions (
            skill_id, version, scope, package_path, manifest_json, content_hash,
            compatibility, compatibility_issues_json, installed_at, created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(skill_id, version) DO UPDATE SET
            package_path = excluded.package_path,
            manifest_json = excluded.manifest_json,
            content_hash = excluded.content_hash,
            compatibility = excluded.compatibility,
            compatibility_issues_json = excluded.compatibility_issues_json,
            updated_at = excluded.updated_at`,
        )
        .run(
          input.version.skillId,
          input.version.version,
          input.version.scope,
          input.version.packagePath,
          JSON.stringify(input.version.manifest),
          input.version.manifest.contentHash,
          input.version.compatibility,
          JSON.stringify(input.version.compatibilityIssues),
          input.version.installedAt,
          input.version.createdAt,
          now,
        );

      this.db
        .prepare(
          "DELETE FROM skill_dependencies WHERE skill_id = ? AND skill_version = ?",
        )
        .run(input.version.skillId, input.version.version);
      const insertDependency = this.db.prepare(
        `INSERT INTO skill_dependencies (
          skill_id, skill_version, dependency_skill_id, dependency_version, optional
        ) VALUES (?, ?, ?, ?, ?)`,
      );
      for (const dependency of input.version.manifest.dependencies) {
        insertDependency.run(
          input.version.skillId,
          input.version.version,
          dependency.skillId,
          dependency.version ?? null,
          dependency.optional ? 1 : 0,
        );
      }
    })();
    return this.getVersion(input.version.skillId, input.version.version)!;
  }

  getVersion(skillId: string, version: string): SkillPackageVersion | null {
    const packageRow = this.db
      .prepare("SELECT * FROM skill_packages WHERE id = ?")
      .get(skillId) as PackageRow | undefined;
    const row = this.db
      .prepare(
        "SELECT * FROM skill_versions WHERE skill_id = ? AND version = ?",
      )
      .get(skillId, version) as VersionRow | undefined;
    return packageRow && row ? mapVersion(packageRow, row) : null;
  }

  getActiveVersion(skillId: string): SkillPackageVersion | null {
    const row = this.db
      .prepare("SELECT active_version FROM skill_packages WHERE id = ?")
      .get(skillId) as { active_version: string } | undefined;
    return row ? this.getVersion(skillId, row.active_version) : null;
  }

  listVersions(skillId?: string): SkillPackageVersion[] {
    const packageRows = this.db
      .prepare(
        skillId
          ? "SELECT * FROM skill_packages WHERE id = ?"
          : "SELECT * FROM skill_packages ORDER BY id",
      )
      .all(...(skillId ? [skillId] : [])) as PackageRow[];
    const rows = this.db
      .prepare(
        skillId
          ? "SELECT * FROM skill_versions WHERE skill_id = ? ORDER BY created_at, version"
          : "SELECT * FROM skill_versions ORDER BY skill_id, created_at, version",
      )
      .all(...(skillId ? [skillId] : [])) as VersionRow[];
    const packagesById = new Map(packageRows.map((row) => [row.id, row]));
    return rows.flatMap((row) => {
      const packageRow = packagesById.get(row.skill_id);
      return packageRow ? [mapVersion(packageRow, row)] : [];
    });
  }

  list(): SkillSummary[] {
    const packages = this.db
      .prepare("SELECT * FROM skill_packages ORDER BY scope, display_name, id")
      .all() as PackageRow[];
    const versions = this.db
      .prepare(
        "SELECT skill_id, version, manifest_json, compatibility FROM skill_versions ORDER BY created_at, version",
      )
      .all() as Array<
      Pick<
        VersionRow,
        "skill_id" | "version" | "manifest_json" | "compatibility"
      >
    >;
    const usageCounts = this.db
      .prepare(
        "SELECT skill_id, COUNT(*) AS count FROM skill_usage_references GROUP BY skill_id",
      )
      .all() as Array<{ skill_id: string; count: number }>;
    const countById = new Map(
      usageCounts.map((row) => [row.skill_id, row.count]),
    );
    return packages.map((row) => {
      const rows = versions.filter((version) => version.skill_id === row.id);
      const active =
        rows.find((version) => version.version === row.active_version) ??
        rows.at(-1);
      const manifest = parseJson<
        SkillPackageVersion["manifest"] | undefined
      >(active?.manifest_json ?? "", undefined);
      return {
        id: row.id,
        scope: row.scope,
        displayName: row.display_name,
        description: row.description,
        activeVersion: row.active_version,
        enabled: !!row.enabled,
        protected: !!row.protected,
        compatibility: active?.compatibility ?? "incompatible",
        requestedPermissions: manifest?.requestedPermissions ?? [],
        toolAllowlist: manifest?.toolAllowlist ?? [],
        versions: rows.map((version) => version.version),
        usageCount: countById.get(row.id) ?? 0,
        source: row.source,
      };
    });
  }

  removeUnreferencedApplicationPackagesExcept(
    skillIds: readonly string[],
  ): string[] {
    const retained = new Set(skillIds);
    const obsolete = (this.db
      .prepare("SELECT id FROM skill_packages WHERE source = 'application'")
      .all() as Array<{ id: string }>)
      .map((row) => row.id)
      .filter((skillId) => !retained.has(skillId));
    const removed: string[] = [];
    this.db.transaction(() => {
      for (const skillId of obsolete) {
        if (this.listUsage(skillId).length > 0) continue;
        this.db.prepare("DELETE FROM skill_packages WHERE id = ?").run(skillId);
        removed.push(skillId);
      }
    })();
    return removed;
  }

  setEnabled(skillId: string, enabled: boolean): SkillSummary {
    const existing = this.requirePackage(skillId);
    if (existing.protected && !enabled) {
      throw new Error("protected-skill-cannot-be-disabled");
    }
    this.db
      .prepare(
        "UPDATE skill_packages SET enabled = ?, updated_at = ? WHERE id = ?",
      )
      .run(enabled ? 1 : 0, this.now(), skillId);
    return this.list().find((skill) => skill.id === skillId)!;
  }

  activateVersion(skillId: string, version: string): SkillSummary {
    this.requirePackage(skillId);
    if (!this.getVersion(skillId, version)) {
      throw new Error("skill-version-not-found");
    }
    this.db
      .prepare(
        "UPDATE skill_packages SET active_version = ?, updated_at = ? WHERE id = ?",
      )
      .run(version, this.now(), skillId);
    return this.list().find((skill) => skill.id === skillId)!;
  }

  addUsage(input: Omit<SkillUsageReference, "id" | "createdAt">) {
    const reference: SkillUsageReference = {
      ...input,
      id: `skill-usage-${randomUUID()}`,
      createdAt: this.now(),
    };
    this.db
      .prepare(
        `INSERT INTO skill_usage_references (
          id, skill_id, skill_version, reference_type, reference_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(skill_id, skill_version, reference_type, reference_id)
        DO NOTHING`,
      )
      .run(
        reference.id,
        reference.skillId,
        reference.skillVersion,
        reference.referenceType,
        reference.referenceId,
        reference.createdAt,
      );
    return reference;
  }

  listUsage(skillId: string, version?: string): SkillUsageReference[] {
    const rows = version
      ? this.db
          .prepare(
            `SELECT * FROM skill_usage_references
             WHERE skill_id = ? AND skill_version = ? ORDER BY created_at, id`,
          )
          .all(skillId, version)
      : this.db
          .prepare(
            `SELECT * FROM skill_usage_references
             WHERE skill_id = ? ORDER BY created_at, id`,
          )
          .all(skillId);
    return (rows as Array<Record<string, unknown>>).map(mapUsage);
  }

  removeUsage(
    skillId: string,
    version: string,
    referenceType: SkillUsageReference["referenceType"],
    referenceId: string,
  ): void {
    this.db
      .prepare(
        `DELETE FROM skill_usage_references
         WHERE skill_id = ? AND skill_version = ?
           AND reference_type = ? AND reference_id = ?`,
      )
      .run(skillId, version, referenceType, referenceId);
  }

  deletePersonalVersion(skillId: string, version: string): void {
    const packageRow = this.requirePackage(skillId);
    if (packageRow.scope !== "personal") {
      throw new Error("builtin-skill-cannot-be-deleted");
    }
    const references = this.listUsage(skillId, version);
    if (references.length > 0) {
      throw new SkillVersionReferencedError(references);
    }
    const remaining = this.db.transaction(() => {
      this.db
        .prepare(
          "DELETE FROM skill_versions WHERE skill_id = ? AND version = ?",
        )
        .run(skillId, version);
      const rows = this.db
        .prepare(
          "SELECT version FROM skill_versions WHERE skill_id = ? ORDER BY created_at, version",
        )
        .all(skillId) as Array<{ version: string }>;
      if (rows.length === 0) {
        this.db.prepare("DELETE FROM skill_packages WHERE id = ?").run(skillId);
        return [];
      }
      if (packageRow.active_version === version) {
        this.db
          .prepare(
            "UPDATE skill_packages SET active_version = ?, updated_at = ? WHERE id = ?",
          )
          .run(rows.at(-1)!.version, this.now(), skillId);
      }
      return rows;
    })();
    void remaining;
  }

  private requirePackage(skillId: string): PackageRow {
    const row = this.db
      .prepare("SELECT * FROM skill_packages WHERE id = ?")
      .get(skillId) as PackageRow | undefined;
    if (!row) throw new Error("skill-not-found");
    return row;
  }
}

function mapVersion(
  packageRow: PackageRow,
  row: VersionRow,
): SkillPackageVersion {
  return {
    skillId: row.skill_id,
    version: row.version,
    scope: row.scope,
    packagePath: row.package_path,
    manifest: parseJson(row.manifest_json, undefined)!,
    compatibility: row.compatibility,
    compatibilityIssues: parseJson(row.compatibility_issues_json, []),
    enabled: !!packageRow.enabled,
    active: packageRow.active_version === row.version,
    installedAt: row.installed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapUsage(row: Record<string, unknown>): SkillUsageReference {
  return {
    id: String(row.id),
    skillId: String(row.skill_id),
    skillVersion: String(row.skill_version),
    referenceType:
      row.reference_type as SkillUsageReference["referenceType"],
    referenceId: String(row.reference_id),
    createdAt: String(row.created_at),
  };
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
