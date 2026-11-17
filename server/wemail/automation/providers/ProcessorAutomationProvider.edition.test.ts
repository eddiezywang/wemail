import assert from "node:assert/strict";
import { test } from "node:test";
import type { CanonicalMailRepository } from "../../mail/CanonicalMailRepository.js";
import { ProcessorAutomationProvider } from "./ProcessorAutomationProvider.js";

test("invoice processing is discoverable only when an edition provides it", async () => {
  const mail = {} as CanonicalMailRepository;
  const open = new ProcessorAutomationProvider(mail);
  assert.deepEqual(await open.discover({ capability: "invoice-extract" }), []);
  assert.deepEqual(await open.discover({ capability: "invoice-readiness" }), []);
  const internal = new ProcessorAutomationProvider(mail, undefined, undefined, () => ({
    type: "dataset", schema: { fields: [] }, rows: [], summary: {}, provenance: [],
  }));
  assert.equal((await internal.discover({ capability: "invoice-extract" })).length, 1);
  assert.equal((await internal.discover({ capability: "invoice-readiness" })).length, 1);
});
