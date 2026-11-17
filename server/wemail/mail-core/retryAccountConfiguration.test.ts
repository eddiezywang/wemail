import assert from "node:assert/strict";
import test from "node:test";
import { retryAccountConfiguration } from "./retryAccountConfiguration.js";

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

test("account configuration keeps recovering beyond six failed attempts", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let attempts = 0;
  const retries: number[] = [];
  const configured = retryAccountConfiguration(async () => {
    if (++attempts <= 8) throw new Error("database busy");
  }, () => true, (_attempt, delayMs) => retries.push(delayMs));
  for (let i = 0; i < 8; i++) {
    await settle();
    t.mock.timers.tick(30_000);
  }
  assert.equal(await configured, true);
  assert.equal(attempts, 9);
  assert.deepEqual(retries, [2_000, 5_000, 10_000, 20_000, 30_000, 30_000, 30_000, 30_000]);
});

test("superseded account configuration cannot retry or report successful readiness", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let current = true;
  let attempts = 0;
  const configured = retryAccountConfiguration(async () => {
    attempts++;
    throw new Error("old producer closed");
  }, () => current, () => undefined);
  await settle();
  current = false;
  t.mock.timers.tick(30_000);
  assert.equal(await configured, false);
  assert.equal(attempts, 1);

  current = true;
  const lateSuccess = retryAccountConfiguration(async () => {
    current = false;
  }, () => current, () => assert.fail("must not retry"));
  assert.equal(await lateSuccess, false);
});
