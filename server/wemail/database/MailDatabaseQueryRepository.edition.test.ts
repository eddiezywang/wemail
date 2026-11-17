import assert from "node:assert/strict";
import { test } from "node:test";
import type { MailDatabase } from "./Database.js";
import { queryOptionsForEdition } from "./MailDatabaseQueryRepository.js";
import type { MailAttachment, MailMessage } from "../../../shared/wemail/mail.js";
import type { EditionModules } from "../bootstrap/editionModules.js";
import { OPEN_ALLOWANCE_RECEIPTS, resolveActionExecutionLanePorts } from "../agent/allowancePort.js";

test("disabled edition features explicitly suppress reader contributions", () => {
  const options = queryOptionsForEdition({} as MailDatabase, {});
  assert.deepEqual(options.sceneActionContributors, []);
  assert.equal(options.invoiceStatuses, null);
  assert.equal(options.invoiceCandidateCheck?.({} as MailAttachment, {} as MailMessage), false);
});

test("an explicit empty edition leaves action recovery on no-op ports", () => {
  const ports = resolveActionExecutionLanePorts({} as MailDatabase, {});
  assert.equal(ports.receipts, OPEN_ALLOWANCE_RECEIPTS);
  assert.equal(ports.invoiceStatuses, undefined);
  assert.equal(ports.lookupUploadReceipt, undefined);
});

test("query options honor each feature and the supplied module bundle", () => {
  const contributor = () => [];
  const invoiceCheck = () => true;
  const statusStore = {};
  const modules = { sceneActionContributors: [contributor], allowance: {
    createInvoiceStatusStore: () => statusStore, isInvoiceAttachmentCandidate: invoiceCheck,
  } } as unknown as EditionModules;
  const disabled = queryOptionsForEdition({} as MailDatabase, {}, modules);
  assert.deepEqual(disabled.sceneActionContributors, []);
  assert.equal(disabled.invoiceStatuses, null);
  const enabled = queryOptionsForEdition({} as MailDatabase, { officeSceneDetection: true, allowanceInvoice: true, wecli: true }, modules);
  assert.deepEqual(enabled.sceneActionContributors, [contributor]);
  assert.equal(enabled.invoiceStatuses, statusStore);
  assert.equal(enabled.invoiceCandidateCheck, invoiceCheck);
  const readOnly = queryOptionsForEdition({} as MailDatabase, { allowanceInvoice: true }, modules);
  assert.equal(readOnly.invoiceStatuses, statusStore);
  assert.equal(readOnly.invoiceCandidateCheck?.({} as MailAttachment, {} as MailMessage), false);
});

test("scene actions require all features declared by their edition", () => {
  const contributor = () => [];
  const modules: EditionModules = { featureSceneActionContributors: [{
    requires: ["officeSceneDetection", "wecli"], contributors: [contributor],
  }] };
  assert.deepEqual(queryOptionsForEdition({} as MailDatabase, { officeSceneDetection: true }, modules).sceneActionContributors, []);
  assert.deepEqual(queryOptionsForEdition({} as MailDatabase, { officeSceneDetection: true, wecli: true }, modules).sceneActionContributors, [contributor]);
});
