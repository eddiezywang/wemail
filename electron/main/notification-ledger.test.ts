import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NotificationDeliveryLedger } from "./notification-ledger.js";

describe("NotificationDeliveryLedger", () => {
  let directory: string;
  let filePath: string;
  let now: number;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-ledger-"));
    filePath = path.join(directory, "notifications.json");
    now = Date.parse("2026-07-26T12:00:00.000Z");
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it("persists delivery keys across instances", () => {
    const ledger = new NotificationDeliveryLedger({
      filePath,
      now: () => now,
    });
    expect(ledger.has("mail:acct-1:mail-1")).toBe(false);

    ledger.record("mail:acct-1:mail-1");

    expect(
      new NotificationDeliveryLedger({ filePath, now: () => now }).has(
        "mail:acct-1:mail-1",
      ),
    ).toBe(true);
  });

  it("expires old keys and bounds retained entries", () => {
    const ledger = new NotificationDeliveryLedger({
      filePath,
      now: () => now,
      ttlMs: 1_000,
      maxEntries: 2,
    });
    ledger.record("one");
    now += 100;
    ledger.record("two");
    now += 100;
    ledger.record("three");

    expect(ledger.has("one")).toBe(false);
    expect(ledger.has("two")).toBe(true);
    expect(ledger.has("three")).toBe(true);

    now += 1_001;
    expect(ledger.has("two")).toBe(false);
    expect(ledger.has("three")).toBe(false);
  });

  it("recovers from a corrupt ledger file", () => {
    fs.writeFileSync(filePath, "{ definitely-not-json", "utf8");
    const ledger = new NotificationDeliveryLedger({
      filePath,
      now: () => now,
    });

    expect(ledger.has("mail-1")).toBe(false);
    expect(() => ledger.record("mail-1")).not.toThrow();
    expect(JSON.parse(fs.readFileSync(filePath, "utf8"))).toMatchObject({
      entries: { "mail-1": now },
    });
  });
});
