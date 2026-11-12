import assert from "node:assert/strict";
import test from "node:test";
import { BusinessPreferencesCache } from "./business-preferences-cache.js";
import { DEFAULT_BUSINESS_PREFERENCES, type BusinessPreferencesSnapshot } from "../../shared/wemail/businessPreferences.js";
import type { MailDatabaseChangeEvent } from "../../shared/wemail/mailDatabaseProtocol.js";

const snapshot: BusinessPreferencesSnapshot = { stored: true, preferences: { ...DEFAULT_BUSINESS_PREFERENCES } };
const changed: MailDatabaseChangeEvent = {
  type: "mail-database.changed", commitVersion: 1,
  changes: [{ entityType: "setting", entityPublicId: "business-preferences", operation: "update" }],
};
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test("notification decisions read memory and unrelated commits do not reload preferences", async () => {
  let listener!: (event: MailDatabaseChangeEvent) => void;
  let reads = 0;
  const cache = new BusinessPreferencesCache({
    getBusinessPreferences: async () => { reads += 1; return snapshot; },
    onChanged: (fn) => { listener = fn; return () => {}; },
  }, (error) => assert.fail(String(error)));
  assert.equal(cache.get().newMailNotifications, false);
  await cache.start();
  for (let index = 0; index < 100; index += 1) assert.deepEqual(cache.get(), snapshot.preferences);
  listener({ ...changed, changes: [{ entityType: "message", entityPublicId: "mail", operation: "update" }] });
  await flush();
  assert.equal(reads, 1);
  cache.get().notificationContentMode = "count-only";
  assert.equal(cache.get().notificationContentMode, "full");
  cache.dispose();
});

test("a preference commit during a read discards the older snapshot and coalesces invalidations", async () => {
  let listener!: (event: MailDatabaseChangeEvent) => void;
  const first = deferred<BusinessPreferencesSnapshot>();
  const latest = deferred<BusinessPreferencesSnapshot>();
  let reads = 0;
  const cache = new BusinessPreferencesCache({
    getBusinessPreferences: () => ++reads === 1 ? first.promise : latest.promise,
    onChanged: (fn) => { listener = fn; return () => {}; },
  }, (error) => assert.fail(String(error)));
  const started = cache.start();
  listener(changed);
  listener(changed);
  first.resolve(snapshot);
  await flush();
  assert.equal(reads, 2);
  assert.equal(cache.get().newMailNotifications, false);
  latest.resolve({ stored: true, preferences: { ...snapshot.preferences, notificationContentMode: "sender-only" } });
  await started;
  assert.equal(cache.get().notificationContentMode, "sender-only");
  cache.dispose();
});

test("failed refresh disables notifications without polling and a reset event recovers", async () => {
  let listener!: (event: MailDatabaseChangeEvent) => void;
  let reads = 0;
  let fail = false;
  const errors: unknown[] = [];
  const cache = new BusinessPreferencesCache({
    getBusinessPreferences: async () => { reads += 1; if (fail) throw new Error("offline"); return snapshot; },
    onChanged: (fn) => { listener = fn; return () => {}; },
  }, (error) => errors.push(error));
  await cache.start();
  fail = true;
  listener(changed);
  assert.equal(cache.get().newMailNotifications, false);
  await flush();
  assert.equal(cache.get().actionRequiredNotifications, false);
  assert.equal(cache.get().notificationContentMode, "count-only");
  assert.equal(reads, 2);
  assert.equal(errors.length, 1);
  fail = false;
  listener({ ...changed, changes: [], resetRequired: true });
  await flush();
  assert.equal(cache.get().newMailNotifications, true);
  assert.equal(reads, 3);
  cache.dispose();
});

test("dispose unsubscribes and prevents an in-flight snapshot from becoming active", async () => {
  const pending = deferred<BusinessPreferencesSnapshot>();
  let unsubscribed = false;
  const cache = new BusinessPreferencesCache({
    getBusinessPreferences: () => pending.promise,
    onChanged: () => () => { unsubscribed = true; },
  }, (error) => assert.fail(String(error)));
  const started = cache.start();
  cache.dispose();
  pending.resolve(snapshot);
  await started;
  assert.equal(unsubscribed, true);
  assert.equal(cache.get().newMailNotifications, false);
});

test("a later notification retries a transient failure after a cooldown without a polling timer", async (t) => {
  let now = 100;
  t.mock.method(Date, "now", () => now);
  let reads = 0;
  const cache = new BusinessPreferencesCache({
    getBusinessPreferences: async () => {
      reads += 1;
      if (reads === 1) throw new Error("transient");
      return snapshot;
    },
    onChanged: () => () => {},
  }, () => {});
  await cache.start();
  now += 4_999;
  assert.equal(cache.get().newMailNotifications, false);
  await flush();
  assert.equal(reads, 1);
  now += 1;
  assert.equal(cache.get().newMailNotifications, false);
  await flush();
  assert.equal(reads, 2);
  assert.equal(cache.get().newMailNotifications, true);
  cache.dispose();
});
