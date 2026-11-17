import * as fs from "node:fs";
import * as path from "node:path";

import type { SampleManifest } from "./SampleManifest.js";

export interface CorpusResidualScanGateArgs {
  manifest: SampleManifest;
  corpusDir: string;
  endpointBaseUrls: ReadonlyArray<string>;
  allowExternalCorpus: boolean;
}

export interface CorpusResidualScanGateResult {
  ok: boolean;
  externalEndpoint: boolean;
  externalCorpusWaived: boolean;
  failed: string[];
}

export function isLocalEndpoint(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    const hostname = url.hostname.toLowerCase();
    return (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "::1" ||
      hostname === "[::1]"
    );
  } catch {
    return false;
  }
}

export function checkCorpusResidualScanGate(
  args: CorpusResidualScanGateArgs,
): CorpusResidualScanGateResult {
  const externalEndpoint = args.endpointBaseUrls.some((url) => !isLocalEndpoint(url));
  const hasCorpus = args.manifest.samples.some((entry) => entry.source === "corpus");
  const externalCorpusWaived =
    hasCorpus && externalEndpoint && args.allowExternalCorpus;

  if (!hasCorpus || !externalEndpoint || externalCorpusWaived) {
    return {
      ok: true,
      externalEndpoint,
      externalCorpusWaived,
      failed: [],
    };
  }

  const failed: string[] = [];
  for (const entry of args.manifest.samples) {
    if (entry.source !== "corpus") continue;
    const filePath = path.join(args.corpusDir, `${entry.id}.json`);
    try {
      const data = JSON.parse(fs.readFileSync(filePath, "utf8")) as {
        _meta?: { residualScanPassed?: boolean };
      };
      if (data._meta?.residualScanPassed !== true) {
        failed.push(
          `${entry.id} (_meta.residualScanPassed != true - re-run extract-mail-corpus)`,
        );
      }
    } catch (err) {
      failed.push(`${entry.id} (parse error: ${(err as Error).message})`);
    }
  }

  return {
    ok: failed.length === 0,
    externalEndpoint,
    externalCorpusWaived,
    failed,
  };
}
