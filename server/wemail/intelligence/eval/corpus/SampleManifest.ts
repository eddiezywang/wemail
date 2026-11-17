/**
 * Sample manifest — the immutable acceptance anchor for one eval run.
 *
 * A manifest freezes which samples (fixtures + corpus) are eligible
 * for a given run, with a content hash per sample. Baseline and
 * candidate runs MUST use the same manifest (same id + same hash) to
 * be comparable; the harness rejects diffs across mismatched manifests.
 *
 * Stratum bucketing is computed at manifest-build time from sample
 * metadata so the harness doesn't have to re-derive it per run.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import type { MailSampleEntry } from "../../../testing/mailSamples.js";

export type SampleStratum = "fixtures" | "injection" | "corpus";
export type SampleSource = "fixtures" | "corpus";

export interface SampleManifestEntry {
  source: SampleSource;
  id: string;
  /** sha256 of canonicalised sample content (12-char prefix). */
  hash: string;
  /** Acceptance bucket — derived from id/category at build time. */
  stratum: SampleStratum;
}

export interface SampleManifest {
  id: string;
  createdAt: string;
  /** Sha of the sorted entries — stamped into run manifest.json. */
  manifestHash: string;
  samples: SampleManifestEntry[];
}

/* ----------------------- Hashing ----------------------- */

/**
 * Hash a sample by JSON-stringifying its `mail` + `expected` fields
 * with sorted keys so order doesn't perturb the digest.
 */
export function hashSampleContent(sample: MailSampleEntry): string {
  const payload = canonicalize({
    id: sample.id,
    category: sample.category,
    mail: sample.mail,
    expected: sample.expected ?? null,
  });
  return createHash("sha256").update(payload).digest("hex").slice(0, 12);
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`)
    .join(",")}}`;
}

/** Decide which stratum a sample belongs to (acceptance bucket). */
export function bucketStratum(opts: {
  id: string;
  category?: string | undefined;
  source: SampleSource;
}): SampleStratum {
  if (
    opts.id.includes("prompt-injection") ||
    opts.category === "prompt_injection"
  ) {
    return "injection";
  }
  return opts.source === "corpus" ? "corpus" : "fixtures";
}

/** Hash a manifest's entries for the manifest-level digest. */
export function hashManifestEntries(entries: SampleManifestEntry[]): string {
  const sorted = [...entries].sort((a, b) => a.id.localeCompare(b.id));
  const flat = sorted
    .map((e) => `${e.source}:${e.id}:${e.stratum}:${e.hash}`)
    .join("|");
  return createHash("sha256").update(flat).digest("hex").slice(0, 12);
}

/* ----------------------- Build / load ----------------------- */

export interface BuildManifestArgs {
  id: string;
  fixtures?: ReadonlyArray<MailSampleEntry>;
  /** Corpus *.json files, each containing a MailSampleEntry-shaped object. */
  corpusPaths?: ReadonlyArray<string>;
}

export function buildManifest(args: BuildManifestArgs): SampleManifest {
  const samples: SampleManifestEntry[] = [];
  for (const sample of args.fixtures ?? []) {
    samples.push({
      source: "fixtures",
      id: sample.id,
      hash: hashSampleContent(sample),
      stratum: bucketStratum({
        id: sample.id,
        category: sample.category,
        source: "fixtures",
      }),
    });
  }
  for (const corpusPath of args.corpusPaths ?? []) {
    const sample = readCorpusSample(corpusPath);
    samples.push({
      source: "corpus",
      id: sample.id,
      hash: hashSampleContent(sample),
      stratum: bucketStratum({
        id: sample.id,
        category: sample.category,
        source: "corpus",
      }),
    });
  }
  // Detect duplicate ids — manifests must have unique sample ids across sources.
  const seen = new Map<string, string>();
  for (const e of samples) {
    const prior = seen.get(e.id);
    if (prior) {
      throw new Error(
        `buildManifest: duplicate sample id '${e.id}' (sources: ${prior}, ${e.source})`,
      );
    }
    seen.set(e.id, e.source);
  }
  samples.sort((a, b) => a.id.localeCompare(b.id));
  return {
    id: args.id,
    createdAt: new Date().toISOString(),
    manifestHash: hashManifestEntries(samples),
    samples,
  };
}

export function writeManifest(manifest: SampleManifest, filePath: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

export function loadManifest(filePath: string): SampleManifest {
  if (!fs.existsSync(filePath)) {
    throw new Error(`SampleManifest: file not found ${filePath}`);
  }
  let parsed: SampleManifest;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as SampleManifest;
  } catch (err) {
    throw new Error(
      `SampleManifest: cannot parse ${filePath}: ${(err as Error).message}`,
    );
  }
  // Check immutability: recompute manifestHash; mismatch means the file
  // was edited by hand, which violates the immutability contract.
  const recomputed = hashManifestEntries(parsed.samples);
  if (recomputed !== parsed.manifestHash) {
    throw new Error(
      `SampleManifest: ${filePath} manifestHash mismatch (advertised=${parsed.manifestHash}, recomputed=${recomputed}); edit a NEW manifest file rather than mutating an existing one`,
    );
  }
  return parsed;
}

/* ----------------------- Corpus reader ----------------------- */

interface CorpusFileEnvelope extends MailSampleEntry {
  _meta?: {
    warning?: string;
    extractedAt?: string;
    redactionVersion?: string;
    residualScanPassed?: boolean;
    redactionMap?: Record<string, number>;
  };
}

export function readCorpusSample(filePath: string): MailSampleEntry {
  if (!fs.existsSync(filePath)) {
    throw new Error(`readCorpusSample: file not found ${filePath}`);
  }
  let parsed: CorpusFileEnvelope;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as CorpusFileEnvelope;
  } catch (err) {
    throw new Error(
      `readCorpusSample: ${filePath} is not valid JSON: ${(err as Error).message}`,
    );
  }
  if (!parsed.id || !parsed.mail || !parsed.category) {
    throw new Error(
      `readCorpusSample: ${filePath} missing required MailSampleEntry fields (id, category, mail)`,
    );
  }
  // Strip _meta before returning — it's bookkeeping, not eval data.
  // (Phase 4's PiiResidualScanner will surface _meta.residualScanPassed
  // before judge calls.)
  const { _meta: _meta, ...sample } = parsed;
  void _meta;
  return sample;
}

/**
 * Verify all manifest samples can be re-loaded with matching content
 * hashes — proves the run sees the same data the manifest froze.
 */
export function validateManifestAgainstSources(
  manifest: SampleManifest,
  sources: {
    fixtures: ReadonlyMap<string, MailSampleEntry>;
    corpusDir?: string;
  },
): { ok: true } | { ok: false; mismatches: Array<{ id: string; reason: string }> } {
  const mismatches: Array<{ id: string; reason: string }> = [];
  for (const entry of manifest.samples) {
    let sample: MailSampleEntry | undefined;
    if (entry.source === "fixtures") {
      sample = sources.fixtures.get(entry.id);
      if (!sample) {
        mismatches.push({ id: entry.id, reason: "fixture not found" });
        continue;
      }
    } else {
      if (!sources.corpusDir) {
        mismatches.push({ id: entry.id, reason: "corpus dir not provided" });
        continue;
      }
      const corpusFile = path.join(sources.corpusDir, `${entry.id}.json`);
      if (!fs.existsSync(corpusFile)) {
        mismatches.push({ id: entry.id, reason: `corpus file missing: ${corpusFile}` });
        continue;
      }
      try {
        sample = readCorpusSample(corpusFile);
      } catch (err) {
        mismatches.push({ id: entry.id, reason: (err as Error).message });
        continue;
      }
    }
    const recomputed = hashSampleContent(sample);
    if (recomputed !== entry.hash) {
      mismatches.push({
        id: entry.id,
        reason: `hash drift (manifest=${entry.hash}, current=${recomputed})`,
      });
    }
  }
  return mismatches.length === 0 ? { ok: true } : { ok: false, mismatches };
}
