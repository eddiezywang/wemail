import assert from "node:assert/strict";
import test from "node:test";
import type { MailProvider } from "./MailProvider.js";
import { LazyMailProviderResource } from "./LazyMailProviderResource.js";

test("lazy mail provider creates on first use and releases after idle", async () => {
  let now = 1_000;
  let created = 0;
  let disconnected = 0;
  const resource = new LazyMailProviderResource(
    () => {
      created += 1;
      return { disconnect: async () => { disconnected += 1; } } as MailProvider;
    },
    5_000,
    () => now,
  );

  assert.equal(resource.isActive(), false);
  const first = resource.get();
  assert.equal(resource.get(), first);
  assert.equal(created, 1);
  assert.equal(await resource.releaseIfIdle(), false);

  now += 6_000;
  assert.equal(await resource.releaseIfIdle(true), false);
  assert.equal(await resource.releaseIfIdle(), true);
  assert.equal(disconnected, 1);
  assert.equal(resource.isActive(), false);

  assert.notEqual(resource.get(), first);
  assert.equal(created, 2);
  await resource.close();
  assert.equal(disconnected, 2);
});
