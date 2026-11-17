/**
 * SampleManifest — Phase 2 unit tests for the immutable acceptance anchor.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import { mailSamples } from "../../../testing/mailSamples.js";
import {
  bucketStratum,
  buildManifest,
  hashManifestEntries,
  hashSampleContent,
  loadManifest,
  readCorpusSample,
  validateManifestAgainstSources,
  writeManifest,
} from "./SampleManifest.js";

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("hashSampleContent: stable across call order", () => {
  const sample = mailSamples[0]!;
  const a = hashSampleContent(sample);
  const b = hashSampleContent(sample);
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{12}$/);
});

test("hashSampleContent: changes when mail body changes", () => {
  const sample = mailSamples[0]!;
  const mutated = {
    ...sample,
    mail: { ...sample.mail, subject: `${sample.mail.subject} [edited]` },
  };
  assert.notEqual(hashSampleContent(sample), hashSampleContent(mutated));
});

test("bucketStratum: prompt-injection id → injection bucket", () => {
  assert.equal(
    bucketStratum({ id: "prompt-injection-html-comment", source: "fixtures" }),
    "injection",
  );
  assert.equal(
    bucketStratum({ id: "x", category: "prompt_injection", source: "fixtures" }),
    "injection",
  );
  assert.equal(
    bucketStratum({ id: "regular", source: "fixtures" }),
    "fixtures",
  );
  assert.equal(bucketStratum({ id: "x", source: "corpus" }), "corpus");
});

test("buildManifest: includes fixtures + computes hash", () => {
  const m = buildManifest({
    id: "test-fixtures",
    fixtures: mailSamples.slice(0, 5),
  });
  assert.equal(m.samples.length, 5);
  assert.match(m.manifestHash, /^[0-9a-f]{12}$/);
  // recompute = original
  assert.equal(hashManifestEntries(m.samples), m.manifestHash);
});

test("buildManifest: rejects duplicate sample ids", () => {
  const dup = { ...mailSamples[0]!, id: mailSamples[1]!.id };
  assert.throws(
    () =>
      buildManifest({
        id: "test-dup",
        fixtures: [mailSamples[1]!, dup],
      }),
    /duplicate sample id/,
  );
});

test("loadManifest: round-trips and detects hand-edits", () => {
  const dir = tmpDir("manifest-rt-");
  const file = path.join(dir, "m.json");
  const m = buildManifest({
    id: "test-rt",
    fixtures: mailSamples.slice(0, 3),
  });
  writeManifest(m, file);
  const loaded = loadManifest(file);
  assert.equal(loaded.id, m.id);
  assert.equal(loaded.manifestHash, m.manifestHash);

  // Hand-edit: bump a hash to mismatch the manifestHash
  const tampered = JSON.parse(fs.readFileSync(file, "utf8")) as typeof m;
  tampered.samples[0]!.hash = "deadbeef0000";
  fs.writeFileSync(file, JSON.stringify(tampered, null, 2), "utf8");
  assert.throws(() => loadManifest(file), /manifestHash mismatch/);
});

test("validateManifestAgainstSources: detects content drift", () => {
  const m = buildManifest({
    id: "test-drift",
    fixtures: mailSamples.slice(0, 2),
  });
  // Same fixtures map → ok
  const fxMap = new Map(mailSamples.map((s) => [s.id, s] as const));
  assert.deepEqual(validateManifestAgainstSources(m, { fixtures: fxMap }), {
    ok: true,
  });

  // Mutate one fixture in the map → drift detected
  const mutatedSample = {
    ...mailSamples[0]!,
    mail: { ...mailSamples[0]!.mail, subject: "MUTATED" },
  };
  const driftMap = new Map(fxMap);
  driftMap.set(mutatedSample.id, mutatedSample);
  const result = validateManifestAgainstSources(m, { fixtures: driftMap });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.mismatches[0]!.id, mutatedSample.id);
    assert.match(result.mismatches[0]!.reason, /hash drift/);
  }
});

test("readCorpusSample: strips _meta and validates required fields", () => {
  const dir = tmpDir("corpus-read-");
  const file = path.join(dir, "corp-001.json");
  const envelope = {
    _meta: { warning: "REDACTED", residualScanPassed: true },
    id: "corp-001",
    category: "notification",
    mail: { subject: "Hi", from: { email: "x@example.test", name: "X" } },
    expected: { categoryId: "notification" },
  };
  fs.writeFileSync(file, JSON.stringify(envelope), "utf8");
  const sample = readCorpusSample(file);
  assert.equal(sample.id, "corp-001");
  assert.equal((sample as unknown as Record<string, unknown>)._meta, undefined);

  // Invalid: missing id
  const bad = path.join(dir, "bad.json");
  fs.writeFileSync(bad, JSON.stringify({ category: "x", mail: {} }), "utf8");
  assert.throws(() => readCorpusSample(bad), /missing required/);
});
