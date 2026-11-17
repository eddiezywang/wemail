import assert from "node:assert/strict";
import test from "node:test";
import {
  describeJsonShape,
  normalizeStructuredJsonText,
  StructuredJsonTextError,
  stripStructuredJsonFence,
} from "./StructuredJsonText.js";

test("structured JSON normalization strips an outer fence and canonicalizes output", () => {
  const result = normalizeStructuredJsonText(
    '```json\n{ "items": [{ "id": 1 }] }\n```',
    {
      type: "object",
      additionalProperties: false,
      required: ["items"],
      properties: {
        items: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["id"],
            properties: { id: { type: "integer", minimum: 1 } },
          },
        },
      },
    },
  );

  assert.equal(result.text, '{"items":[{"id":1}]}');
});

test("structured JSON normalization rejects schema mismatches with a diagnostic detail", () => {
  assert.throws(
    () => normalizeStructuredJsonText('{"ok":"yes","extra":true}', {
      type: "object",
      additionalProperties: false,
      required: ["ok"],
      properties: { ok: { type: "boolean" } },
    }),
    (error: unknown) => {
      assert.ok(error instanceof StructuredJsonTextError);
      assert.equal(error.code, "STRUCTURED_OUTPUT_SCHEMA_MISMATCH");
      assert.equal(error.rawText, '{"ok":"yes","extra":true}');
      assert.match(error.detail, /model output \{ok:str\(3\),extra:bool\}/);
      assert.match(error.detail, /\$\.ok: expected boolean, got string\(3 chars\)/);
      return true;
    },
  );
});

test("extra fields are tolerated even when additionalProperties is false", () => {
  const result = normalizeStructuredJsonText('{"ok":true,"extra":1,"nested":{"a":1}}', {
    type: "object",
    additionalProperties: false,
    required: ["ok"],
    properties: { ok: { type: "boolean" } },
  });
  assert.equal(result.text, '{"ok":true,"extra":1,"nested":{"a":1}}');
});

test("schema mismatch detail pinpoints nested array items and missing fields", () => {
  assert.throws(
    () => normalizeStructuredJsonText('{"todos":[{"title":"a","confidence":"high"}]}', {
      type: "object",
      required: ["todos"],
      properties: {
        todos: {
          type: "array",
          items: {
            type: "object",
            required: ["title", "confidence"],
            properties: {
              title: { type: "string" },
              confidence: { type: "number" },
            },
          },
        },
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof StructuredJsonTextError);
      assert.match(error.detail, /todos\[0\]\.confidence: expected number, got string\(4 chars\)/);
      return true;
    },
  );

  assert.throws(
    () => normalizeStructuredJsonText('{"todos":[{"title":"a"}]}', {
      type: "object",
      required: ["todos"],
      properties: {
        todos: {
          type: "array",
          items: {
            type: "object",
            required: ["title", "confidence"],
            properties: { title: { type: "string" } },
          },
        },
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof StructuredJsonTextError);
      assert.match(error.detail, /todos\[0\]: missing required 'confidence'/);
      return true;
    },
  );
});

test("output shape summary is size-bounded and value-free", () => {
  const big = {
    a: "value-a",
    b: "value-b",
    c: "value-c",
    d: "value-d",
    e: "value-e",
    f: "value-f",
    g: "value-g",
    h: "value-h",
    i: [1, 2, 3, 4, 5],
  };
  // The natural shape of `big` is 59 chars (6 head entries + `,+3`), so use a
  // budget below it to exercise the truncation path, not the pass-through.
  const shape = describeJsonShape(big, 50);
  assert.ok(shape.length <= 51);
  assert.match(shape, /…$/);
  assert.doesNotMatch(shape, /value-/);
});

test("structured JSON fence stripping keeps surrounding prose unchanged", () => {
  const raw = 'Result:\n```json\n{"ok":true}\n```';
  assert.equal(stripStructuredJsonFence(raw), raw);
});
