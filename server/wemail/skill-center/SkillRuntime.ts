import type {
  SkillPackageVersion,
  SkillSnapshot,
  WorkflowValueKind,
} from "../../../shared/wemail/skillCenter.js";
import { SkillPackageRepository } from "./SkillPackageRepository.js";

export interface SkillSelectionRequest {
  explicit?: Array<{ skillId: string; version?: string }>;
  taskBound?: SkillSnapshot[];
}

export interface ResolvedSkillSet {
  versions: SkillPackageVersion[];
  snapshots: SkillSnapshot[];
  rootSkillIds: string[];
}

export class SkillRegistry {
  constructor(private readonly packages: SkillPackageRepository) {}

  listEnabledMetadata(): SkillPackageVersion[] {
    return this.packages
      .listVersions()
      .filter(
        (version) =>
          version.enabled &&
          version.active &&
          version.compatibility !== "incompatible" &&
          version.compatibility !== "tampered",
      );
  }

  active(skillId: string): SkillPackageVersion | null {
    const version = this.packages.getActiveVersion(skillId);
    return version?.enabled ? version : null;
  }

  exact(skillId: string, version: string): SkillPackageVersion | null {
    const found = this.packages.getVersion(skillId, version);
    return found?.enabled ? found : null;
  }
}

export class SkillResolver {
  constructor(private readonly registry: SkillRegistry) {}

  resolve(request: SkillSelectionRequest): ResolvedSkillSet {
    const roots = new Map<string, SkillPackageVersion>();

    // A task-bound snapshot is immutable and outranks later activation changes.
    for (const snapshot of request.taskBound ?? []) {
      const found = this.registry.exact(snapshot.skillId, snapshot.version);
      if (!found || found.manifest.contentHash !== snapshot.contentHash) {
        throw new Error(`skill-task-snapshot-stale:${snapshot.skillId}`);
      }
      roots.set(snapshot.skillId, found);
    }
    // Explicit invocation is authoritative.
    for (const selected of request.explicit ?? []) {
      const found = selected.version
        ? this.registry.exact(selected.skillId, selected.version)
        : this.registry.active(selected.skillId);
      if (!found) throw new Error(`skill-not-available:${selected.skillId}`);
      roots.set(selected.skillId, found);
    }

    const resolved = new Map<string, SkillPackageVersion>();
    const visiting = new Set<string>();
    const visit = (version: SkillPackageVersion) => {
      const key = `${version.skillId}@${version.version}`;
      if (visiting.has(key)) throw new Error(`skill-dependency-cycle:${key}`);
      const previous = resolved.get(version.skillId);
      if (previous && previous.version !== version.version) {
        throw new Error(`skill-version-conflict:${version.skillId}`);
      }
      if (previous) return;
      if (
        version.compatibility === "incompatible" ||
        version.compatibility === "tampered"
      ) {
        throw new Error(`skill-incompatible:${key}`);
      }
      visiting.add(key);
      for (const dependency of version.manifest.dependencies) {
        const child = dependency.version
          ? this.registry.exact(dependency.skillId, dependency.version)
          : this.registry.active(dependency.skillId);
        if (!child) {
          if (dependency.optional) continue;
          throw new Error(`skill-dependency-missing:${dependency.skillId}`);
        }
        validateDependencyKinds(version, child);
        visit(child);
      }
      visiting.delete(key);
      resolved.set(version.skillId, version);
    };
    for (const version of roots.values()) visit(version);

    const versions = Array.from(resolved.values());
    return {
      versions,
      rootSkillIds: Array.from(roots.keys()),
      snapshots: versions.map((version) => ({
        skillId: version.skillId,
        version: version.version,
        contentHash: version.manifest.contentHash,
        scope: version.scope,
      })),
    };
  }
}

function validateDependencyKinds(
  parent: SkillPackageVersion,
  dependency: SkillPackageVersion,
): void {
  // Orchestrator Skills compose sibling stages into a pipeline rather than
  // consuming each dependency's output directly.
  if (parent.manifest.outputKinds.includes("pipeline-draft")) return;
  if (
    parent.manifest.inputKinds.length === 0 ||
    dependency.manifest.outputKinds.length === 0
  ) {
    return;
  }
  const accepted = new Set<WorkflowValueKind>(parent.manifest.inputKinds);
  if (!dependency.manifest.outputKinds.some((kind) => accepted.has(kind))) {
    throw new Error(
      `skill-dependency-kind-mismatch:${dependency.skillId}->${parent.skillId}`,
    );
  }
}
