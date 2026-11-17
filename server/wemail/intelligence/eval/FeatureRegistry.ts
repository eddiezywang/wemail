/**
 * FeatureRegistry — central catalog of all eval-spec implementations.
 *
 * Loading order:
 *   1. Built-ins from `features/index.ts` (importStatic, compile-time check).
 *   2. External plugins listed in `eval-plugins.json` allowlist.
 *      External specs must declare `peerDependencies` matching the
 *      framework version, and cannot register over a built-in id unless
 *      `allowOverride: true` in the allowlist entry.
 *
 * Phase 1 ships only the built-in path; the plugin loader is wired but
 * tolerates an empty allowlist. Phase 7 documents the external-plugin
 * contract for business teams.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

import type { AnyEvalSpec, PluginMeta } from "./FeatureSpec.js";
import {
  validateWeights,
  computePromptHash,
  DEFAULT_AXIS_WEIGHTS,
  type AxisWeights,
} from "./FeatureSpec.js";

export const FRAMEWORK_VERSION = "2.0.0";

export interface PluginAllowlistEntry {
  package: string;
  version: string;
  allowOverride?: boolean;
}

export interface PluginAllowlistFile {
  $schema?: string;
  frameworkVersion: string;
  plugins: PluginAllowlistEntry[];
}

export interface RegisteredSpec {
  spec: AnyEvalSpec;
  source: "builtin" | "plugin";
  pluginMeta?: PluginMeta;
}

export class FeatureRegistry {
  private readonly entries = new Map<string, RegisteredSpec>();

  /** Register a built-in spec (compile-time wired in features/index.ts). */
  registerBuiltin(spec: AnyEvalSpec): void {
    this.assertSpecValid(spec, "builtin");
    if (this.entries.has(spec.id)) {
      throw new Error(
        `FeatureRegistry: duplicate built-in spec id '${spec.id}'`,
      );
    }
    this.entries.set(spec.id, { spec, source: "builtin" });
  }

  /** Register an external plugin spec (post-builtins). */
  registerPlugin(spec: AnyEvalSpec, meta: PluginMeta): void {
    this.assertSpecValid(spec, "plugin");
    const existing = this.entries.get(spec.id);
    if (existing && existing.source === "builtin" && !meta.allowOverride) {
      throw new Error(
        `FeatureRegistry: plugin '${meta.packageName}' tried to register id '${spec.id}' which is built-in; set allowOverride=true in eval-plugins.json to permit`,
      );
    }
    if (existing && existing.source === "plugin") {
      throw new Error(
        `FeatureRegistry: id '${spec.id}' already registered by plugin '${existing.pluginMeta?.packageName}'`,
      );
    }
    this.entries.set(spec.id, { spec, source: "plugin", pluginMeta: meta });
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  get(id: string): AnyEvalSpec {
    const e = this.entries.get(id);
    if (!e) throw new Error(`FeatureRegistry: unknown feature '${id}'`);
    return e.spec;
  }

  getEntry(id: string): RegisteredSpec | undefined {
    return this.entries.get(id);
  }

  list(): RegisteredSpec[] {
    return [...this.entries.values()];
  }

  listIds(): string[] {
    return [...this.entries.keys()];
  }

  /** Snapshot of loaded plugins for inclusion in run manifest.json. */
  loadedPlugins(): PluginMeta[] {
    return this.list()
      .filter((e) => e.source === "plugin" && e.pluginMeta)
      .map((e) => e.pluginMeta!);
  }

  /**
   * Build the default registry: register all builtins, then load
   * plugins from `eval-plugins.json` if present.
   */
  static async loadDefault(opts?: {
    cwd?: string;
    skipPlugins?: boolean;
  }): Promise<FeatureRegistry> {
    const registry = new FeatureRegistry();
    const { registerBuiltins } = await import("./features/index.js");
    registerBuiltins(registry);

    if (opts?.skipPlugins) return registry;

    const cwd = opts?.cwd ?? process.cwd();
    const allowlistPath = path.join(cwd, "eval-plugins.json");
    if (!fs.existsSync(allowlistPath)) return registry;

    let allowlist: PluginAllowlistFile;
    try {
      allowlist = JSON.parse(fs.readFileSync(allowlistPath, "utf8")) as PluginAllowlistFile;
    } catch (err) {
      throw new Error(
        `FeatureRegistry: cannot parse ${allowlistPath}: ${(err as Error).message}`,
      );
    }
    if (allowlist.frameworkVersion !== FRAMEWORK_VERSION) {
      throw new Error(
        `FeatureRegistry: eval-plugins.json frameworkVersion=${allowlist.frameworkVersion} does not match runtime ${FRAMEWORK_VERSION}`,
      );
    }
    for (const entry of allowlist.plugins ?? []) {
      await loadPluginEntry(registry, entry, cwd);
    }
    return registry;
  }

  private assertSpecValid(spec: AnyEvalSpec, source: "builtin" | "plugin"): void {
    const specId = (spec as { id?: string }).id;
    if (!specId || typeof specId !== "string") {
      throw new Error(`FeatureRegistry: spec missing id (${source})`);
    }
    const specKind = (spec as { kind?: string }).kind;
    if (specKind !== "single-turn" && specKind !== "agent-runtime") {
      throw new Error(
        `FeatureRegistry: spec '${specId}' has unknown kind '${specKind}'`,
      );
    }
    // Recompute promptHash and verify it matches what the spec advertises.
    const recomputed = computePromptHash({
      systemPrompt: spec.systemPrompt,
      promptVersion: spec.promptVersion,
      jsonSchema: "jsonSchema" in spec ? spec.jsonSchema : undefined,
    });
    if (spec.promptHash !== recomputed) {
      throw new Error(
        `FeatureRegistry: spec '${spec.id}' promptHash mismatch (advertised=${spec.promptHash}, recomputed=${recomputed})`,
      );
    }
    // Validate weights sum to 1.0 (with custom axes).
    const weights: AxisWeights = {
      ...DEFAULT_AXIS_WEIGHTS,
      ...(spec.weights ?? {}),
    };
    const customAxes =
      "scoring" in spec ? spec.scoring.customAxes ?? undefined : undefined;
    const v = validateWeights(weights, customAxes);
    if (!v.ok) {
      throw new Error(`FeatureRegistry: spec '${spec.id}' ${v.reason}`);
    }
  }
}

/**
 * Resolve and load one plugin entry from the allowlist.
 *
 * The plugin is expected to default-export a function
 * `(register: (spec: AnyEvalSpec) => void) => void`. Plugin-side
 * registration goes through the function so the registry can attach
 * PluginMeta. We also verify the plugin's installed version matches
 * the allowlist and that its peerDependency on this framework matches.
 */
async function loadPluginEntry(
  registry: FeatureRegistry,
  entry: PluginAllowlistEntry,
  cwd: string,
): Promise<void> {
  const pkgJsonPath = path.join(cwd, "node_modules", entry.package, "package.json");
  if (!fs.existsSync(pkgJsonPath)) {
    throw new Error(
      `FeatureRegistry: plugin '${entry.package}' not installed (looked at ${pkgJsonPath})`,
    );
  }
  let pkg: { version?: string; peerDependencies?: Record<string, string>; main?: string };
  try {
    pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8")) as typeof pkg;
  } catch (err) {
    throw new Error(
      `FeatureRegistry: cannot parse ${pkgJsonPath}: ${(err as Error).message}`,
    );
  }
  if (pkg.version !== entry.version) {
    throw new Error(
      `FeatureRegistry: plugin '${entry.package}' installed=${pkg.version} but allowlist requires=${entry.version}`,
    );
  }
  // peer dep check — must mention our framework with a compatible major.
  const peer = pkg.peerDependencies?.["@wemail/prompt-eval-framework"];
  if (!peer) {
    throw new Error(
      `FeatureRegistry: plugin '${entry.package}' missing peerDependency on @wemail/prompt-eval-framework`,
    );
  }
  const peerMajor = peer.replace(/^[\^~]/, "").split(".")[0];
  const ourMajor = FRAMEWORK_VERSION.split(".")[0];
  if (peerMajor !== ourMajor) {
    throw new Error(
      `FeatureRegistry: plugin '${entry.package}' peerDep major=${peerMajor}; framework major=${ourMajor}`,
    );
  }

  const requireFromCwd = createRequire(path.join(cwd, "eval-plugins.json"));
  const pluginEntryPath = requireFromCwd.resolve(entry.package);
  const pluginModule = (await import(pathToFileURL(pluginEntryPath).href)) as {
    default?: (register: (spec: AnyEvalSpec) => void) => void;
  };
  if (typeof pluginModule.default !== "function") {
    throw new Error(
      `FeatureRegistry: plugin '${entry.package}' has no default export of the registration function`,
    );
  }
  const collected: AnyEvalSpec[] = [];
  pluginModule.default((spec) => collected.push(spec));
  for (const spec of collected) {
    const specHash = computePromptHash({
      systemPrompt: spec.systemPrompt,
      promptVersion: spec.promptVersion,
      jsonSchema: "jsonSchema" in spec ? spec.jsonSchema : undefined,
    });
    const meta: PluginMeta = {
      packageName: entry.package,
      packageVersion: pkg.version!,
      specHash,
      loadedFrom: pkgJsonPath,
      allowOverride: entry.allowOverride === true,
    };
    registry.registerPlugin(spec, meta);
  }
}
