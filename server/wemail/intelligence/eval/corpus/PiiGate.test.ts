import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { checkCorpusResidualScanGate, isLocalEndpoint } from "./PiiGate.js";
import type { SampleManifest } from "./SampleManifest.js";

function manifestWithCorpus(id: string): SampleManifest {
  return {
    id: "test-manifest",
    createdAt: "2026-05-05T00:00:00.000Z",
    manifestHash: "hash",
    samples: [
      {
        id,
        source: "corpus",
        stratum: "corpus",
        hash: "hash",
      },
    ],
  };
}

test("isLocalEndpoint recognizes loopback URLs only", () => {
  assert.equal(isLocalEndpoint("http://127.0.0.1:8989/v1"), true);
  assert.equal(isLocalEndpoint("http://localhost:8989/v1"), true);
  assert.equal(isLocalEndpoint("http://[::1]:8989/v1"), true);
  assert.equal(isLocalEndpoint("https://judge.example.com/v1"), false);
});

test("checkCorpusResidualScanGate fails closed for remote self-judge corpus without residual scan", () => {
  const corpusDir = mkdtempSync(path.join(tmpdir(), "pii-gate-"));
  writeFileSync(
    path.join(corpusDir, "mail-1.json"),
    JSON.stringify({ id: "mail-1", _meta: { residualScanPassed: false } }),
    "utf8",
  );

  const result = checkCorpusResidualScanGate({
    manifest: manifestWithCorpus("mail-1"),
    corpusDir,
    endpointBaseUrls: [
      "https://remote.example.test/v1",
      "https://remote.example.test/v1",
    ],
    allowExternalCorpus: false,
  });

  assert.equal(result.ok, false);
  assert.equal(result.externalEndpoint, true);
  assert.deepEqual(result.failed, [
    "mail-1 (_meta.residualScanPassed != true - re-run extract-mail-corpus)",
  ]);
});

test("checkCorpusResidualScanGate allows local corpus runs without residual scan", () => {
  const corpusDir = mkdtempSync(path.join(tmpdir(), "pii-gate-local-"));
  mkdirSync(corpusDir, { recursive: true });
  writeFileSync(
    path.join(corpusDir, "mail-1.json"),
    JSON.stringify({ id: "mail-1", _meta: { residualScanPassed: false } }),
    "utf8",
  );

  const result = checkCorpusResidualScanGate({
    manifest: manifestWithCorpus("mail-1"),
    corpusDir,
    endpointBaseUrls: ["http://127.0.0.1:8989/v1"],
    allowExternalCorpus: false,
  });

  assert.equal(result.ok, true);
  assert.equal(result.externalEndpoint, false);
  assert.equal(result.externalCorpusWaived, false);
});
