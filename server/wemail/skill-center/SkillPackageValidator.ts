import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  SkillCompatibility,
  SkillPackageManifest,
  SkillScope,
  WorkflowValueKind,
} from "../../../shared/wemail/skillCenter.js";

const SKILL_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/;
const MAX_FILES = 500;
const MAX_TOTAL_BYTES = 10 * 1024 * 1024;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_SKILL_BYTES = 200 * 1024;
const FORBIDDEN_PERMISSIONS = new Set([
  "shell",
  "process",
  "network.unrestricted",
  "electron.ipc",
  "filesystem.unrestricted",
]);

export interface SkillPackageValidationOptions {
  scope: SkillScope;
  knownTools?: ReadonlySet<string>;
  expectedId?: string;
  expectedVersion?: string;
}

export interface SkillPackageValidationResult {
  valid: boolean;
  manifest?: SkillPackageManifest;
  displayName?: string;
  description?: string;
  compatibility: SkillCompatibility;
  issues: string[];
  warnings: string[];
  files: Array<{ relativePath: string; size: number }>;
  contentHash?: string;
}

export class SkillPackageValidator {
  validateDirectory(
    packageDir: string,
    options: SkillPackageValidationOptions,
  ): SkillPackageValidationResult {
    const root = path.resolve(packageDir);
    const issues: string[] = [];
    const warnings: string[] = [];
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
      return {
        valid: false,
        compatibility: "incompatible",
        issues: ["skill-package-directory-required"],
        warnings,
        files: [],
      };
    }

    const files = scanFiles(root, issues);
    if (files.length > MAX_FILES) issues.push("skill-package-too-many-files");
    const total = files.reduce((sum, file) => sum + file.size, 0);
    if (total > MAX_TOTAL_BYTES) issues.push("skill-package-too-large");
    if (files.some((file) => file.size > MAX_FILE_BYTES)) {
      issues.push("skill-package-file-too-large");
    }

    const skillPath = path.join(root, "SKILL.md");
    if (!fs.existsSync(skillPath)) issues.push("skill-markdown-required");
    const skillMarkdown = fs.existsSync(skillPath)
      ? fs.readFileSync(skillPath, "utf8")
      : "";
    if (Buffer.byteLength(skillMarkdown, "utf8") > MAX_SKILL_BYTES) {
      issues.push("skill-markdown-too-large");
    }
    const frontmatter = parseSkillFrontmatter(skillMarkdown);
    if (!frontmatter) issues.push("skill-frontmatter-invalid");

    let manifest = readManifest(root, issues);
    if (!manifest && frontmatter) {
      manifest = inferredManifest({
        name: frontmatter.name,
        description: frontmatter.description,
        scope: options.scope,
        expectedId: options.expectedId,
        expectedVersion: options.expectedVersion,
      });
      warnings.push("wemail-manifest-inferred");
    }

    if (manifest) {
      validateManifest(manifest, options, issues, warnings);
      if (manifest.entry !== "SKILL.md") issues.push("skill-entry-invalid");
      if (manifest.scope !== options.scope) issues.push("skill-scope-mismatch");
      if (options.expectedId && manifest.id !== options.expectedId) {
        issues.push("skill-id-mismatch");
      }
      if (
        options.expectedVersion &&
        manifest.version !== options.expectedVersion
      ) {
        issues.push("skill-version-mismatch");
      }
      if (files.some((file) => file.relativePath.startsWith("scripts/"))) {
        warnings.push("personal-scripts-are-inert");
      }
    }

    const contentHash = manifest
      ? hashPackageDirectory(root, manifest)
      : undefined;
    if (
      manifest?.contentHash &&
      manifest.contentHash !== "pending" &&
      manifest.contentHash !== contentHash
    ) {
      issues.push("skill-content-hash-mismatch");
    }
    if (manifest && contentHash) manifest = { ...manifest, contentHash };

    const unsupportedTool = warnings.some((warning) =>
      warning.startsWith("unsupported-tool:"),
    );
    const compatibility: SkillCompatibility =
      issues.length > 0
        ? issues.includes("skill-content-hash-mismatch")
          ? "tampered"
          : "incompatible"
        : unsupportedTool || warnings.includes("personal-scripts-are-inert")
          ? "partially_compatible"
          : "compatible";

    return {
      valid: issues.length === 0,
      ...(manifest ? { manifest } : {}),
      ...(frontmatter
        ? {
            displayName: frontmatter.name,
            description: frontmatter.description,
          }
        : {}),
      compatibility,
      issues,
      warnings,
      files,
      ...(contentHash ? { contentHash } : {}),
    };
  }
}

export function hashPackageDirectory(
  packageDir: string,
  manifest?: SkillPackageManifest,
): string {
  const root = path.resolve(packageDir);
  const issues: string[] = [];
  const files = scanFiles(root, issues);
  if (issues.length > 0) {
    throw new Error(`skill-package-hash-failed:${issues.join(",")}`);
  }
  const hash = createHash("sha256");
  for (const file of files.sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  )) {
    hash.update(file.relativePath.replaceAll("\\", "/"));
    hash.update("\0");
    if (file.relativePath === "wemail.skill.json" && manifest) {
      hash.update(
        stableJson({
          ...manifest,
          contentHash: "",
        }),
      );
    } else {
      hash.update(fs.readFileSync(path.join(root, file.relativePath)));
    }
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function parseSkillFrontmatter(
  markdown: string,
): { name: string; description: string; body: string } | null {
  const normalized = markdown.replace(/^\uFEFF/, "");
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(
    normalized,
  );
  if (!match) return null;
  const fields = new Map<string, string>();
  for (const line of match[1]!.split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    fields.set(key, value);
  }
  const name = fields.get("name")?.trim();
  const description = fields.get("description")?.trim();
  if (!name || !description) return null;
  return { name, description, body: match[2] ?? "" };
}

function scanFiles(
  root: string,
  issues: string[],
): Array<{ relativePath: string; size: number }> {
  const files: Array<{ relativePath: string; size: number }> = [];
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute);
      const normalized = relative.replaceAll("\\", "/");
      if (
        !normalized ||
        normalized.startsWith("../") ||
        path.isAbsolute(relative)
      ) {
        issues.push("skill-package-path-invalid");
        continue;
      }
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) {
        issues.push(`skill-package-link-forbidden:${normalized}`);
        continue;
      }
      if (stat.isDirectory()) {
        visit(absolute);
        continue;
      }
      if (!stat.isFile()) {
        issues.push(`skill-package-file-type-invalid:${normalized}`);
        continue;
      }
      files.push({ relativePath: normalized, size: stat.size });
    }
  };
  visit(root);
  return files;
}

function readManifest(
  root: string,
  issues: string[],
): SkillPackageManifest | undefined {
  const file = path.join(root, "wemail.skill.json");
  if (!fs.existsSync(file)) return undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      issues.push("wemail-manifest-invalid");
      return undefined;
    }
    return parsed as SkillPackageManifest;
  } catch {
    issues.push("wemail-manifest-invalid-json");
    return undefined;
  }
}

function inferredManifest(input: {
  name: string;
  description: string;
  scope: SkillScope;
  expectedId?: string;
  expectedVersion?: string;
}): SkillPackageManifest {
  const inferredId =
    input.expectedId ??
    input.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
  return {
    schemaVersion: 1,
    id: inferredId,
    version: input.expectedVersion ?? "1.0.0",
    scope: input.scope,
    entry: "SKILL.md",
    displayName: input.name,
    description: input.description,
    inputKinds: [],
    outputKinds: [],
    dependencies: [],
    toolAllowlist: [],
    requestedPermissions: [],
    reviewPolicy: "recommended",
    contentHash: "pending",
  };
}

function validateManifest(
  manifest: SkillPackageManifest,
  options: SkillPackageValidationOptions,
  issues: string[],
  warnings: string[],
): void {
  if (manifest.schemaVersion !== 1) issues.push("skill-schema-unsupported");
  if (!SKILL_ID.test(manifest.id)) issues.push("skill-id-invalid");
  if (!VERSION.test(manifest.version)) issues.push("skill-version-invalid");
  if (!Array.isArray(manifest.inputKinds)) {
    issues.push("skill-input-kinds-invalid");
  } else if (!manifest.inputKinds.every(isWorkflowValueKind)) {
    issues.push("skill-input-kind-unsupported");
  }
  if (!Array.isArray(manifest.outputKinds)) {
    issues.push("skill-output-kinds-invalid");
  } else if (!manifest.outputKinds.every(isWorkflowValueKind)) {
    issues.push("skill-output-kind-unsupported");
  }
  if (!Array.isArray(manifest.dependencies)) {
    issues.push("skill-dependencies-invalid");
  }
  if (!Array.isArray(manifest.toolAllowlist)) {
    issues.push("skill-tool-allowlist-invalid");
  } else if (options.knownTools) {
    for (const tool of manifest.toolAllowlist) {
      if (!options.knownTools.has(tool)) warnings.push(`unsupported-tool:${tool}`);
    }
  }
  if (!Array.isArray(manifest.requestedPermissions)) {
    issues.push("skill-permissions-invalid");
  } else {
    for (const permission of manifest.requestedPermissions) {
      if (FORBIDDEN_PERMISSIONS.has(permission)) {
        issues.push(`skill-permission-forbidden:${permission}`);
      }
    }
  }
  if (
    manifest.reviewPolicy !== "none" &&
    manifest.reviewPolicy !== "recommended" &&
    manifest.reviewPolicy !== "required"
  ) {
    issues.push("skill-review-policy-invalid");
  }
}

function isWorkflowValueKind(value: unknown): value is WorkflowValueKind {
  return (
    value === "mail-reference" ||
    value === "mail-collection" ||
    value === "attachment-reference" ||
    value === "attachment-collection" ||
    value === "data-selection" ||
    value === "dataset" ||
    value === "analysis-recipe" ||
    value === "analysis-result" ||
    value === "artifact-recipe" ||
    value === "artifact-reference" ||
    value === "delivery-plan" ||
    value === "delivery-receipt" ||
    value === "pipeline-draft" ||
    value === "automation-rule-preview" ||
    value === "skill-draft"
  );
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
