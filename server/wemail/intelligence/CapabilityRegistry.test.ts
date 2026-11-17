import assert from "node:assert/strict";
import { test } from "node:test";
import type { CapabilityDescriptor } from "./CapabilityDescriptor.js";
import { CapabilityRegistry } from "./CapabilityRegistry.js";

function makeDescriptor(
  overrides: Partial<CapabilityDescriptor> = {},
): CapabilityDescriptor {
  const base: CapabilityDescriptor = {
    type: "summary",
    createProcessor: () => {
      throw new Error("not used");
    },
    lane: { maxAttempts: 2, timeoutMs: 30_000 },
    requiresLlm: true,
    prescreenable: false,
    id: "summary",
    displayName: "邮件摘要",
    promptVersion: 2,
    modelPolicy: { kind: "lane", lane: "summary" },
    qualityGate: "summary-thread-quality",
    safeToAutoRun: true,
    workspaceInputs: [],
  };
  return { ...base, ...overrides };
}

// ── Basic registration ──────────────────────────────────────────────

test("CapabilityRegistry registers a descriptor with new metadata fields", () => {
  const registry = new CapabilityRegistry();
  registry.register(makeDescriptor());
  const descriptor = registry.get("summary");
  assert.ok(descriptor, "should retrieve registered descriptor");
  assert.equal(descriptor.id, "summary");
  assert.equal(descriptor.displayName, "邮件摘要");
  assert.equal(descriptor.promptVersion, 2);
  assert.deepEqual(descriptor.modelPolicy, { kind: "lane", lane: "summary" });
  assert.equal(descriptor.qualityGate, "summary-thread-quality");
  assert.equal(descriptor.safeToAutoRun, true);
  assert.deepEqual(descriptor.workspaceInputs, []);
});

test("CapabilityRegistry rejects duplicate registration", () => {
  const registry = new CapabilityRegistry();
  registry.register(makeDescriptor());
  assert.throws(() => registry.register(makeDescriptor()), /already registered/);
});

test("CapabilityRegistry.has and getAll return registered capabilities", () => {
  const registry = new CapabilityRegistry();
  registry.register(makeDescriptor());
  registry.register(
    makeDescriptor({
      type: "linkExtraction",
      id: "linkExtraction",
      displayName: "链接提取",
      promptVersion: 1,
      modelPolicy: { kind: "deterministic" },
      requiresLlm: false,
      qualityGate: null,
    }),
  );
  assert.equal(registry.has("summary"), true);
  assert.equal(registry.has("linkExtraction"), true);
  assert.equal(registry.has("tags"), false);
  assert.equal(registry.getAll().length, 2);
});

// ── modelPolicy variants ────────────────────────────────────────────

test("CapabilityRegistry accepts deterministic modelPolicy", () => {
  const registry = new CapabilityRegistry();
  registry.register(
    makeDescriptor({
      type: "linkExtraction",
      id: "linkExtraction",
      displayName: "链接提取",
      promptVersion: 1,
      modelPolicy: { kind: "deterministic" },
      requiresLlm: false,
      qualityGate: null,
    }),
  );
  const descriptor = registry.get("linkExtraction");
  assert.ok(descriptor);
  assert.equal(descriptor.modelPolicy.kind, "deterministic");
  assert.equal(descriptor.requiresLlm, false);
});

test("CapabilityRegistry accepts lane modelPolicy variants", () => {
  const registry = new CapabilityRegistry();
  for (const lane of ["summary", "draft", "agent"] as const) {
    const type =
      lane === "summary" ? "summary" : lane === "draft" ? "replyDraft" : "composeMail";
    registry.register(
      makeDescriptor({
        type,
        id: type,
        displayName: type,
        modelPolicy: { kind: "lane", lane },
      }),
    );
  }
  for (const type of ["summary", "replyDraft", "composeMail"] as const) {
    const descriptor = registry.get(type);
    assert.ok(descriptor);
    assert.equal(descriptor.modelPolicy.kind, "lane");
  }
});

// ── qualityGate optional ────────────────────────────────────────────

test("CapabilityRegistry accepts null qualityGate", () => {
  const registry = new CapabilityRegistry();
  registry.register(makeDescriptor({ qualityGate: null }));
  const descriptor = registry.get("summary");
  assert.ok(descriptor);
  assert.equal(descriptor.qualityGate, null);
});

test("CapabilityRegistry accepts non-null qualityGate", () => {
  const registry = new CapabilityRegistry();
  registry.register(makeDescriptor({ qualityGate: "writing-suite" }));
  const descriptor = registry.get("summary");
  assert.ok(descriptor);
  assert.equal(descriptor.qualityGate, "writing-suite");
});
