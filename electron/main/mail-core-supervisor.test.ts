import { expect, test, vi } from "vitest";
import { MAIL_CORE_PROTOCOL_VERSION } from "../../shared/wemail/mailCoreProtocol.js";
import type { MailReceiptHealth } from "../../shared/wemail/mailSync.js";

vi.mock("electron", () => ({ MessageChannelMain: class {}, utilityProcess: {} }));

import { MailCoreSupervisor } from "./mail-core-supervisor.js";

const receipt: MailReceiptHealth = {
  runtimeId: "runtime", generation: 1, requestedVersion: 2, completedVersion: 1, failedVersion: 0,
  stage: "provider", activeStartedAt: 1, lastProgressAt: 1, lastSuccessfulCheckAt: 1,
  lastCommittedAt: 1, nextCheckAt: null, nextRetryAt: null, consecutiveFailures: 0, lastError: null,
};

function setup() {
  const supervisor = new MailCoreSupervisor("unused", () => undefined);
  const control = supervisor as unknown as { handleControl(input: unknown): void; disposeCurrent(): void };
  control.handleControl({ type: "mail-core.ready", protocolVersion: MAIL_CORE_PROTOCOL_VERSION, pid: 1 });
  const publish = () => control.handleControl({
    type: "mail-core.heartbeat", pid: 1, at: 1, receipt: { accountId: "acct-1", health: receipt },
  });
  return { supervisor, control, publish };
}

test("receipt snapshots are validated, account scoped, and stamped at observation", () => {
  const { supervisor, control, publish } = setup();
  publish();
  expect(supervisor.getMailReceipt("acct-1")).toEqual({ ...receipt, observedAt: expect.any(Number) });
  expect(supervisor.getMailReceipt("other")).toBeNull();
  control.handleControl({ type: "mail-core.heartbeat", at: 1, pid: 1,
    receipt: { accountId: "acct-1", health: { completedVersion: "invalid" } } });
  expect(supervisor.getMailReceipt("acct-1")).toBeNull();
});

test("credential and account reloads cannot expose a previous runtime snapshot", () => {
  const { supervisor, publish } = setup();
  publish();
  supervisor.configureAccountCredential(null);
  expect(supervisor.getMailReceipt("acct-1")).toBeNull();
  publish();
  supervisor.reloadAccount();
  expect(supervisor.getMailReceipt("acct-1")).toBeNull();
});

test("disconnection invalidates cached receipt health before a replacement starts", () => {
  const { supervisor, control, publish } = setup();
  publish();
  control.disposeCurrent();
  expect(supervisor.getMailReceipt("acct-1")).toBeNull();
});
