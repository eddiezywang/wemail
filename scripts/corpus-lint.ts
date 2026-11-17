#!/usr/bin/env -S node --import tsx
/**
 * Scan every *.json file in a corpus directory for residual PII.
 * Emits a quarantine report for each failure and exits non-zero.
 *
 *   node --import tsx scripts/corpus-lint.ts --dir ./corpus
 *
 * Designed to be run before any eval that involves an external judge —
 * the harness already gates external-judge calls on `_meta.residualScanPassed`,
 * but running this CLI explicitly catches files committed without going
 * through extract-mail-corpus (rare but possible).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { argv, exit } from "node:process";

import { readCorpusSample } from "../server/wemail/intelligence/eval/corpus/SampleManifest.js";
import {
  scanSample,
  renderQuarantineMarkdown,
  type ResidualScanResult,
} from "../server/wemail/intelligence/eval/corpus/PiiResidualScanner.js";

interface CliArgs {
  dir: string;
  quarantineDir: string;
  failFast: boolean;
}

function parseArgs(args: string[]): CliArgs {
  const out: Partial<CliArgs> = { failFast: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--dir") out.dir = args[++i] as string;
    else if (a === "--quarantine-dir") out.quarantineDir = args[++i] as string;
    else if (a === "--fail-fast") out.failFast = true;
    else if (a === "--help" || a === "-h") {
      printHelp();
      exit(0);
    } else if (a) {
      console.error(`unknown arg: ${a}`);
      printHelp();
      exit(2);
    }
  }
  if (!out.dir) {
    console.error("--dir is required");
    exit(2);
  }
  return {
    dir: out.dir,
    quarantineDir: out.quarantineDir ?? "./corpus-quarantine",
    failFast: out.failFast === true,
  };
}

function printHelp(): void {
  console.log(
    [
      "Usage: node --import tsx scripts/corpus-lint.ts [opts]",
      "",
      "  --dir <path>             corpus directory to scan (required)",
      "  --quarantine-dir <path>  where to write hit reports (default ./corpus-quarantine)",
      "  --fail-fast              exit on first hit (default scans all)",
      "",
      "Exit codes: 0 = clean, 1 = hits found, 2 = bad args",
    ].join("\n"),
  );
}

function main(): void {
  const cli = parseArgs(argv.slice(2));
  if (!fs.existsSync(cli.dir)) {
    console.error(`corpus dir not found: ${cli.dir}`);
    exit(2);
  }

  const files = fs
    .readdirSync(cli.dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => path.join(cli.dir, f));
  if (files.length === 0) {
    console.log(`[lint] no *.json files in ${cli.dir}`);
    exit(0);
  }

  let failed = 0;
  for (const file of files) {
    let result: ResidualScanResult;
    let sampleId = path.basename(file, ".json");
    try {
      const sample = readCorpusSample(file);
      sampleId = sample.id;
      result = scanSample(sample);
    } catch (err) {
      console.error(`[lint] ✗ ${file}: ${(err as Error).message}`);
      failed += 1;
      if (cli.failFast) break;
      continue;
    }
    if (result.ok) {
      console.log(`[lint] ✓ ${sampleId}`);
      continue;
    }
    failed += 1;
    fs.mkdirSync(cli.quarantineDir, { recursive: true });
    const reportPath = path.join(cli.quarantineDir, `${sampleId}.report.md`);
    fs.writeFileSync(
      reportPath,
      renderQuarantineMarkdown({ filePath: file, sampleId, result }),
      "utf8",
    );
    console.error(
      `[lint] ✗ ${sampleId}: ${result.hits.length} hits → ${reportPath}`,
    );
    if (cli.failFast) break;
  }

  if (failed > 0) {
    console.error(`\n[lint] ${failed} file(s) failed PII residual scan`);
    exit(1);
  }
  console.log(`\n[lint] ${files.length} file(s) clean`);
}

try {
  main();
} catch (err) {
  console.error("[lint] error:", (err as Error).message);
  exit(1);
}
