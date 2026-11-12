#!/usr/bin/env -S node --import tsx
/**
 * Freeze a sample manifest from fixtures + corpus directory.
 *
 *   node --import tsx scripts/manifest-build.ts \
 *     --id 2026-05-04-prod \
 *     --include-fixtures \
 *     --corpus-dir ./corpus \
 *     --out eval-reports/_manifests/2026-05-04-prod.json
 *
 * The output is the immutable acceptance anchor for any subsequent
 * eval run; baseline + candidate runs MUST reference the same manifest
 * to be comparable. Editing the file by hand breaks the manifestHash
 * check at load time — create a new file with a new id instead.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { argv, exit } from "node:process";

import { mailSamples } from "../server/wemail/testing/mailSamples.js";
import {
  buildManifest,
  writeManifest,
} from "../server/wemail/intelligence/eval/corpus/SampleManifest.js";

interface CliArgs {
  id: string;
  includeFixtures: boolean;
  corpusDir: string | undefined;
  out: string;
}

function parseArgs(args: string[]): CliArgs {
  const out: Partial<CliArgs> = { includeFixtures: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--id") out.id = args[++i] as string;
    else if (a === "--include-fixtures") out.includeFixtures = true;
    else if (a === "--corpus-dir") out.corpusDir = args[++i] as string;
    else if (a === "--out") out.out = args[++i] as string;
    else if (a === "--help" || a === "-h") {
      printHelp();
      exit(0);
    } else if (a) {
      console.error(`unknown arg: ${a}`);
      printHelp();
      exit(2);
    }
  }
  if (!out.id) {
    console.error("--id is required");
    exit(2);
  }
  if (!out.out) {
    console.error("--out is required");
    exit(2);
  }
  if (!out.includeFixtures && !out.corpusDir) {
    console.error("must specify --include-fixtures and/or --corpus-dir");
    exit(2);
  }
  return out as CliArgs;
}

function printHelp(): void {
  console.log(
    [
      "Usage: node --import tsx scripts/manifest-build.ts [opts]",
      "",
      "  --id <label>            required (e.g. 2026-05-04-prod)",
      "  --include-fixtures      include all built-in mailSamples",
      "  --corpus-dir <path>     include all *.json under this dir",
      "  --out <path>            output manifest path (committed)",
    ].join("\n"),
  );
}

function main(): void {
  const cli = parseArgs(argv.slice(2));

  const fixtures = cli.includeFixtures ? mailSamples : [];
  const corpusPaths: string[] = [];
  if (cli.corpusDir) {
    if (!fs.existsSync(cli.corpusDir)) {
      console.error(`corpus dir not found: ${cli.corpusDir}`);
      exit(2);
    }
    for (const entry of fs.readdirSync(cli.corpusDir)) {
      if (entry.endsWith(".json")) {
        corpusPaths.push(path.join(cli.corpusDir, entry));
      }
    }
  }

  const manifest = buildManifest({
    id: cli.id,
    fixtures,
    corpusPaths,
  });

  writeManifest(manifest, cli.out);
  console.log(`[manifest] wrote ${cli.out}`);
  console.log(
    `[manifest] id=${manifest.id} samples=${manifest.samples.length} hash=${manifest.manifestHash}`,
  );
  const counts = manifest.samples.reduce<Record<string, number>>((acc, s) => {
    acc[s.stratum] = (acc[s.stratum] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`[manifest] strata: ${JSON.stringify(counts)}`);
}

try {
  main();
} catch (err) {
  console.error("[manifest] error:", (err as Error).message);
  exit(1);
}
