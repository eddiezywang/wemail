import fs from "node:fs/promises";
import path from "node:path";
// Import the Skill protocol submodules directly instead of the pi-coding-agent
// barrel: the barrel pulls in the full agent SDK (pi-ai LLM clients, pi-tui,
// image processing) which the desktop main process does not need and which
// measurably increases resident memory (~45MB in local measurement). The
// `scripts/patch-pi-skill-exports.mjs` postinstall adds the `./dist/*`
// export map entry that makes these subpath imports resolvable.
import {
  formatSkillsForPrompt,
  loadSkills,
  type Skill,
} from "@earendil-works/pi-coding-agent/dist/core/skills.js";
import { createReadTool } from "@earendil-works/pi-coding-agent/dist/core/tools/read.js";
import type {
  SkillPackageVersion,
  SkillSnapshot,
} from "../../../shared/wemail/skillCenter.js";
import type { AgentTool } from "../agent/AgentRuntime.js";
import type { ToolInput } from "../agent/AgentTypes.js";
import { SkillPackageValidator } from "./SkillPackageValidator.js";
import { SkillRegistry, SkillResolver } from "./SkillRuntime.js";

const READABLE_SKILL_EXTENSIONS = new Set([
  ".csv",
  ".js",
  ".json",
  ".md",
  ".mjs",
  ".ps1",
  ".sh",
  ".ts",
  ".txt",
  ".yaml",
  ".yml",
]);

export interface PiSkillResourceLoad {
  skills: Skill[];
  versions: SkillPackageVersion[];
  diagnostics: string[];
}

/**
 * Thin WeMail adapter around pi-coding-agent's native Skill protocol.
 *
 * Pi owns discovery metadata, prompt formatting, and progressive reads. WeMail
 * only chooses the installed version that may be exposed and constrains the
 * native read tool to validated Skill package roots.
 */
export class PiSkillResources {
  private readonly validator = new SkillPackageValidator();

  constructor(
    private readonly registry: SkillRegistry,
    private readonly resolver: SkillResolver,
    private readonly cwd: string,
  ) {}

  load(context?: Record<string, unknown>): PiSkillResourceLoad {
    const versions = this.validatedVersions(context);
    const result = loadSkills({
      cwd: this.cwd,
      agentDir: this.cwd,
      skillPaths: versions.map((version) => version.packagePath),
      includeDefaults: false,
    });
    return {
      skills: result.skills,
      versions,
      diagnostics: result.diagnostics.map((diagnostic) =>
        `${diagnostic.path ?? "skill"}: ${diagnostic.message}`,
      ),
    };
  }

  formatPrompt(context?: Record<string, unknown>): string {
    try {
      const prompt = formatSkillsForPrompt(this.load(context).skills);
      if (context) delete context.skillResolutionIssue;
      return prompt;
    } catch (error) {
      if (context) {
        context.skillResolutionIssue = error instanceof Error
          ? error.message
          : String(error);
      }
      return "";
    }
  }

  resolveSnapshots(context?: Record<string, unknown>): SkillSnapshot[] {
    const pinned = pinnedSnapshotsFromContext(context);
    if (pinned.length > 0) {
      return this.resolver.resolve({ taskBound: pinned }).snapshots;
    }
    const read = skillReadSnapshotsFromContext(context);
    return read.length > 0 ? read : [];
  }

  createReadTool(): AgentTool {
    const nativeRead = createReadTool(this.cwd, { autoResizeImages: false });
    return {
      name: nativeRead.name,
      description: `${nativeRead.description} In WeMail this tool is restricted to files inside enabled Skill packages.`,
      inputSchema: nativeRead.parameters as unknown as Record<string, unknown>,
      handler: async (input, context) => {
        const scopedRead = createReadTool(this.cwd, {
          autoResizeImages: false,
          operations: {
            access: async (filePath) => {
              await this.assertReadablePath(filePath, context.runContext);
              await fs.access(filePath);
            },
            readFile: async (filePath) => {
              await this.assertReadablePath(filePath, context.runContext);
              return fs.readFile(filePath);
            },
          },
        });
        const result = await scopedRead.execute(
          "wemail-skill-read",
          input as never,
          context.signal,
        );
        const text = result.content
          .filter(
            (item): item is { type: "text"; text: string } =>
              item.type === "text",
          )
          .map((item) => item.text)
          .join("\n");
        await this.recordRead(input, context.runContext);
        return text;
      },
      observe: (_output) => "已读取 Skill 资源",
    };
  }

  private validatedVersions(
    context?: Record<string, unknown>,
  ): SkillPackageVersion[] {
    const pinned = pinnedSnapshotsFromContext(context);
    const versions = pinned.length > 0
      ? this.resolver.resolve({ taskBound: pinned }).versions
      : this.registry.listEnabledMetadata();
    for (const version of versions) {
      const checked = this.validator.validateDirectory(version.packagePath, {
        scope: version.scope,
        expectedId: version.skillId,
        expectedVersion: version.version,
      });
      if (!checked.valid || checked.contentHash !== version.manifest.contentHash) {
        throw new Error(`skill-tampered:${version.skillId}`);
      }
    }
    return versions;
  }

  private async assertReadablePath(
    filePath: string,
    context: Record<string, unknown> | undefined,
  ): Promise<void> {
    if (!READABLE_SKILL_EXTENSIONS.has(path.extname(filePath).toLowerCase())) {
      throw new Error("skill-resource-type-not-readable");
    }
    const target = await fs.realpath(path.resolve(filePath));
    const roots = await Promise.all(
      this.validatedVersions(context).map((version) =>
        fs.realpath(version.packagePath),
      ),
    );
    if (!roots.some((root) => isInside(target, root))) {
      throw new Error("skill-resource-access-denied");
    }
  }

  private async recordRead(
    input: ToolInput,
    context: Record<string, unknown> | undefined,
  ): Promise<void> {
    if (!context || typeof input.path !== "string") return;
    const target = await fs.realpath(path.resolve(this.cwd, input.path));
    const versions = this.validatedVersions(context);
    for (const version of versions) {
      const root = await fs.realpath(version.packagePath);
      if (!isInside(target, root)) continue;
      const snapshots = [
        ...skillReadSnapshotsFromContext(context),
        snapshotOf(version),
      ];
      const unique = new Map(
        snapshots.map((snapshot) => [snapshot.skillId, snapshot]),
      );
      context.skillReadSnapshots = Array.from(unique.values());
      context.selectedSkills = Array.from(unique.values()).map((snapshot) => ({
        id: snapshot.skillId,
        version: snapshot.version,
        hash: snapshot.contentHash,
      }));
      return;
    }
  }
}

export function pinnedSnapshotsFromContext(
  context: Record<string, unknown> | undefined,
): SkillSnapshot[] {
  const candidate = [
    context?.skillSnapshots,
    context?.taskBoundSkillSnapshots,
  ].find(Array.isArray);
  return Array.isArray(candidate) ? candidate.filter(isSkillSnapshot) : [];
}

function skillReadSnapshotsFromContext(
  context: Record<string, unknown> | undefined,
): SkillSnapshot[] {
  return Array.isArray(context?.skillReadSnapshots)
    ? context.skillReadSnapshots.filter(isSkillSnapshot)
    : [];
}

function isSkillSnapshot(value: unknown): value is SkillSnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as Partial<SkillSnapshot>;
  return (
    typeof snapshot.skillId === "string" &&
    typeof snapshot.version === "string" &&
    typeof snapshot.contentHash === "string" &&
    (snapshot.scope === "builtin" || snapshot.scope === "personal")
  );
}

function snapshotOf(version: SkillPackageVersion): SkillSnapshot {
  return {
    skillId: version.skillId,
    version: version.version,
    contentHash: version.manifest.contentHash,
    scope: version.scope,
  };
}

function isInside(target: string, root: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}
