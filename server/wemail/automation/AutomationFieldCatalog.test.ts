import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AUTOMATION_FIELD_DEFINITIONS,
  getAutomationFieldDefinition,
} from "./AutomationFieldCatalog.js";

test("open catalog lists only the native received-time field", () => {
  // P2.6: the invoice.issueDate field (definition + resolver) is an edition
  // module contribution; without the module the catalog (and therefore rule
  // authoring and validation) never offers it. The module's own definition
  // is covered by the edition overlay's suite (allowanceModules.test).
  assert.deepEqual(getAutomationFieldDefinition("mail.receivedAt"), {
    path: "mail.receivedAt",
    label: "收到邮件的时间",
    description: "邮件进入邮箱的精确时间",
    valueType: "datetime",
    cardinality: "one",
    scope: "mail",
    availability: "immediate",
  });
  assert.equal(getAutomationFieldDefinition("invoice.issueDate"), undefined);
  assert.equal(AUTOMATION_FIELD_DEFINITIONS.length, 1);
});
