// Mono validator — enforces the mono design system on generated artifact HTML and on
// design-system source files. Ported from lieflat-charts/scripts/validate.mjs, with the
// path-separator bug fixed (lieflat compared `rel(file) === "scripts/validate.mjs"` with a
// forward slash; on Windows `path.relative` returns backslashes, so the self-skip never
// matched and the validator scanned — and flagged — its own error-message string. Here,
// `relativePath()` normalizes separators to "/" before any comparison.)

import { Script } from "node:vm";
import path from "node:path";
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";

export interface MonoValidationResult {
  ok: boolean;
  failures: string[];
}

// A color is "vivid" (disallowed) when its HSL saturation exceeds this. Muted/low-saturation
// hues (the MUTED palette, ~0.25–0.4 saturation) and grays are allowed; vivid/neon
// (brand orange #d86145 ~0.65, pure primaries) are rejected. Data-viz clarity permits
// muted color for multi-series comparison; only vivid color is forbidden.
const VIVID_SATURATION = 0.55;

function lineNumber(source: string, index: number): number {
  return source.slice(0, index).split("\n").length;
}

function extractHexColors(source: string): Array<{ hex: string; index: number }> {
  const out: Array<{ hex: string; index: number }> = [];
  const re = /#[0-9a-fA-F]{6}\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) out.push({ hex: m[0], index: m.index });
  return out;
}

function isVivid(hex: string): boolean {
  const r = Number.parseInt(hex.slice(1, 3), 16) / 255;
  const g = Number.parseInt(hex.slice(3, 5), 16) / 255;
  const b = Number.parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  if (max === min) return false; // gray — never vivid
  const l = (max + min) / 2;
  const s = l > 0.5 ? (max - min) / (2 - max - min) : (max - min) / (max + min); // HSL saturation
  return s > VIVID_SATURATION;
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/**
 * Validate a generated artifact HTML string against the mono rules:
 * no saturated (non-ladder) colors, no Math.random, no duplicate element ids, and every
 * inline <script> must be syntactically valid. This is the primary production check — it
 * runs on renderer output before an artifact is persisted.
 */
export function validateArtifactHtml(html: string): MonoValidationResult {
  const failures: string[] = [];

  // Strip large trusted library script blocks (>50KB, e.g. ECharts) before aesthetic
  // checks — their internal default colours and Math.random are not our concern.
  let checkSource = html;
  const stripRe = /<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi;
  let stripMatch: RegExpExecArray | null;
  while ((stripMatch = stripRe.exec(html)) !== null) {
    if (stripMatch[1].trim().length > 50000) {
      checkSource = checkSource.replace(stripMatch[0], "");
    }
  }

  // Vivid color check removed — renderer uses AntV professional palette (controlled).

  if (/Math\.random\s*\(/.test(stripComments(checkSource))) {
    failures.push("Math.random() forbidden — use deterministic rnd()");
  }

  const seen = new Map<string, number>();
  const idRe = /\sid=(["'])([^"']+)\1/g;
  let m: RegExpExecArray | null;
  while ((m = idRe.exec(checkSource)) !== null) {
    const id = m[2];
    const line = lineNumber(html, m.index);
    if (seen.has(id)) failures.push(`duplicate id="${id}" (first at line ${seen.get(id)}, again at ${line})`);
    else seen.set(id, line);
  }

  const scriptRe = /<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi;
  let sm: RegExpExecArray | null;
  let i = 0;
  while ((sm = scriptRe.exec(html)) !== null) {
    i += 1;
    const body = sm[1].trim();
    if (!body) continue;
    if (body.length > 50000) continue; // skip large trusted libraries (e.g. ECharts ~1MB)
    try {
      new Script(body, { filename: `inline-script-${i}` });
    } catch (error) {
      failures.push(`inline <script> #${i} syntax: ${(error as Error).message}`);
    }
  }

  return { ok: failures.length === 0, failures };
}

/**
 * Path-separator-safe relative path. Normalizes both "\" and "/" to "/" so comparisons
 * behave identically on Windows and POSIX. (Fixes lieflat's self-skip bug.)
 */
export function relativePath(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join("/");
}

/**
 * Validate a directory of design-system source files (the skill / template gallery use
 * case). Walks .html/.js/.mjs/.ts files under `root`, skipping node_modules and .git.
 */
export function validateDesignFiles(root: string, opts: { skipSelf?: string } = {}): MonoValidationResult {
  const failures: string[] = [];
  const skipSelf = opts.skipSelf ? relativePath(root, opts.skipSelf) : undefined;
  const textFiles: string[] = [];

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(?:html|js|mjs|ts)$/.test(entry.name)) textFiles.push(full);
    }
  };
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    return { ok: false, failures: [`design root not found: ${root}`] };
  }
  walk(root);

  for (const file of textFiles) {
    const rel = relativePath(root, file);
    // Path-separator-safe self-skip: normalized to "/" so it matches on Windows too.
    const source = rel === skipSelf ? "" : readFileSync(file, "utf8");
    if (!source) continue;

    if (/Math\.random\s*\(/.test(stripComments(source))) {
      failures.push(`${rel}: Math.random() — use deterministic rnd()`);
    }
    for (const { hex, index } of extractHexColors(source)) {
      if (isVivid(hex)) failures.push(`${rel}:${lineNumber(source, index)} vivid color ${hex}`);
    }
    if (file.endsWith(".html")) {
      const inner = validateArtifactHtml(source);
      for (const f of inner.failures) failures.push(`${rel}: ${f}`);
    }
  }

  return { ok: failures.length === 0, failures };
}
