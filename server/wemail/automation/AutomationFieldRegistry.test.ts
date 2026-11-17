import assert from "node:assert/strict";
import { test } from "node:test";
import type { MailMessage } from "../../../shared/wemail/mail.js";
import { AutomationFieldRegistry } from "./AutomationFieldRegistry.js";

const message = {
  id: "mail-1",
  receivedAt: "2026-07-20T02:00:00.000Z",
  attachments: [],
} as unknown as MailMessage;

test("native received time resolves as a datetime", async () => {
  const result = await AutomationFieldRegistry.withNativeFields().resolve("mail.receivedAt", {
    message,
    scope: "mail",
  });

  assert.deepEqual(result, {
    status: "ready",
    valueType: "datetime",
    values: ["2026-07-20T02:00:00.000Z"],
  });
});

test("registry rejects duplicate paths and fails closed for unknown fields", async () => {
  const registry = AutomationFieldRegistry.withNativeFields();
  assert.throws(() => registry.register({
    definition: {
      path: "mail.receivedAt",
      label: "duplicate",
      description: "test",
      valueType: "datetime",
      cardinality: "one",
      scope: "mail",
      availability: "immediate",
    },
    async resolve() {
      return { status: "unavailable", reasons: [] };
    },
  }), /duplicate-automation-field:mail\.receivedAt/);

  assert.deepEqual(await registry.resolve("unknown.field", { message }), {
    status: "unavailable",
    reasons: ["unknown-automation-field:unknown.field"],
  });
});

test("registry fails closed when provider results violate their declared type or cardinality", async () => {
  const registry = new AutomationFieldRegistry();
  registry.register({
    definition: {
      path: "test.date", label: "date", description: "test", valueType: "date", cardinality: "one", scope: "mail", availability: "immediate",
    },
    async resolve() {
      return { status: "ready", valueType: "datetime", values: ["2026-07-20T00:00:00.000Z"] };
    },
  });
  registry.register({
    definition: {
      path: "test.single", label: "single", description: "test", valueType: "datetime", cardinality: "one", scope: "mail", availability: "immediate",
    },
    async resolve() {
      return { status: "ready", valueType: "datetime", values: ["2026-07-20T00:00:00.000Z", "2026-07-21T00:00:00.000Z"] };
    },
  });

  assert.deepEqual(await registry.resolve("test.date", { message }), {
    status: "unavailable",
    reasons: ["automation-field-value-type-mismatch:test.date"],
  });
  assert.deepEqual(await registry.resolve("test.single", { message }), {
    status: "unavailable",
    reasons: ["automation-field-cardinality-mismatch:test.single"],
  });
});

test("registry rejects explicit scopes incompatible with the provider definition", async () => {
  const registry = new AutomationFieldRegistry();
  registry.register({
    definition: {
      path: "test.attachment", label: "attachment", description: "test", valueType: "date", cardinality: "many", scope: "attachment", availability: "enriched",
    },
    async resolve() {
      return { status: "ready", valueType: "date", values: ["2026-07-20"] };
    },
  });

  assert.deepEqual(await registry.resolve("test.attachment", { message, scope: "mail" }), {
    status: "unavailable",
    reasons: ["automation-field-scope-mismatch:test.attachment"],
  });
  assert.equal((await registry.resolve("test.attachment", { message })).status, "ready");
});

test("ensure deduplicates dependencies and calls only providers that expose ensure", async () => {
  const registry = new AutomationFieldRegistry();
  const ensured: string[] = [];
  registry.register({
    definition: {
      path: "invoice.issueDate",
      label: "issue date",
      description: "test",
      valueType: "date",
      cardinality: "many",
      scope: "attachment",
      availability: "enriched",
    },
    async resolve() {
      return { status: "unavailable", reasons: [] };
    },
    async ensure(context) {
      ensured.push(`${context.message.id}:${context.scope}`);
    },
  });
  registry.register({
    definition: {
      path: "mail.receivedAt",
      label: "received at",
      description: "test",
      valueType: "datetime",
      cardinality: "one",
      scope: "mail",
      availability: "immediate",
    },
    async resolve() {
      return { status: "unavailable", reasons: [] };
    },
  });

  await registry.ensure([
    { fieldPath: "invoice.issueDate", emailId: message.id },
    { fieldPath: "invoice.issueDate", emailId: "another-email" },
    { fieldPath: "mail.receivedAt", emailId: message.id },
    { fieldPath: "unknown.field", emailId: message.id },
  ], { message, scope: "matchingAttachments" });

  assert.deepEqual(ensured, ["mail-1:matchingAttachments"]);
});
