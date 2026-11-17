import { afterEach, expect, test, vi } from "vitest";
import { waitForMailRefresh } from "./mailRefresh";
import type { CoreHealthResult } from "../../shared/wemail/mailCoreProtocol";
import type { MailReceiptHealth } from "../../shared/wemail/mailSync";

const receipt: MailReceiptHealth = {
  runtimeId: "runtime", generation: 1, requestedVersion: 2, completedVersion: 1, failedVersion: 0,
  stage: "provider", activeStartedAt: 1, lastProgressAt: 1, lastSuccessfulCheckAt: null,
  lastCommittedAt: null, nextCheckAt: null, nextRetryAt: null, consecutiveFailures: 0, lastError: null,
};

function health(value: MailReceiptHealth): CoreHealthResult {
  return {
    protocolVersion: 1, state: "ready", pid: 1, startedAt: "2026-11-04T00:00:00.000Z", uptimeMs: 0,
    accountRuntime: { state: "ready", accountId: "acct-1", threadId: 1, lastHeartbeatAt: 1,
      currentJobId: 1, currentOutboxId: null, receipt: value },
  };
}

afterEach(() => vi.useRealTimers());

test("queued refresh waits for the requested receipt version to complete", async () => {
  vi.useFakeTimers();
  let current = { ...receipt };
  let settled = false;
  const waiting = waitForMailRefresh("acct-1", {
    status: "queued", receiptVersion: 2, runtimeId: "runtime",
  }, async () => health(current)).then((result) => { settled = true; return result; });
  await vi.advanceTimersByTimeAsync(0);
  expect(settled).toBe(false);
  current = { ...current, completedVersion: 2 };
  await vi.advanceTimersByTimeAsync(250);
  await expect(waiting).resolves.toBe(true);
});

test("refresh failure and replaced runtimes do not masquerade as completion", async () => {
  const accepted = { status: "queued" as const, receiptVersion: 2, runtimeId: "runtime" };
  await expect(waitForMailRefresh("acct-1", accepted, async () =>
    health({ ...receipt, failedVersion: 2 }))).rejects.toThrow("本次刷新未完成");
  await expect(waitForMailRefresh("acct-1", accepted, async () =>
    health({ ...receipt, runtimeId: "replacement", completedVersion: 99 }))).rejects.toThrow("正在恢复");
});

test("an observation deadline leaves long catch-up accepted rather than falsely complete", async () => {
  vi.useFakeTimers();
  const waiting = waitForMailRefresh("acct-1", {
    status: "queued", receiptVersion: 2, runtimeId: "runtime",
  }, async () => health(receipt));
  await vi.advanceTimersByTimeAsync(60_000);
  await expect(waiting).resolves.toBe(false);
});

test("authentication failure remains actionable and older queued responses stay accepted", async () => {
  const invalid = health(receipt);
  invalid.accountRuntime!.state = "credential-required";
  await expect(waitForMailRefresh("acct-1", {
    status: "queued", receiptVersion: 2, runtimeId: "runtime",
  }, async () => invalid)).rejects.toMatchObject({ name: "MAIL_CREDENTIAL_INVALID" });
  const read = vi.fn(async () => health(receipt));
  await expect(waitForMailRefresh("acct-1", { status: "queued" }, read)).resolves.toBe(false);
  expect(read).not.toHaveBeenCalled();
});
