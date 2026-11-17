import assert from "node:assert/strict";
import test from "node:test";
import { openOrCreateMailDatabase } from "../database/Database.js";
import { ChannelConnectionRepository } from "./ChannelConnectionRepository.js";
import { IntegrationStatusService } from "./IntegrationStatusService.js";

test("integration status keeps independent mixed cached observations", () => {
  const db = openOrCreateMailDatabase(":memory:");
  const now = () => new Date("2026-07-29T00:00:00.000Z");
  const connections = new ChannelConnectionRepository(db, now);
  connections.upsertObservation({
    entryKey: "wecli",
    integrationId: "wecli",
    state: "connected",
  });
  connections.upsertObservation({
    entryKey: "wecom:profile-1",
    integrationId: "wecom",
    state: "connected",
  });
  const service = new IntegrationStatusService(
    connections,
    { detect: async () => {
      throw new Error("not-used");
    } } as any,
    { check: async () => {
      throw new Error("not-used");
    } },
    now,
  );
  assert.deepEqual(
    service.getCached().entries.map((entry) => [entry.id, entry.state]),
    [
      ["wecli", "connected"],
      ["feishu", "not_configured"],
      ["wecom", "connected"],
    ],
  );
});

test("integration refresh deduplicates concurrent callers and publishes passive changes", async () => {
  const db = openOrCreateMailDatabase(":memory:");
  const connections = new ChannelConnectionRepository(db);
  let checks = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const service = new IntegrationStatusService(
    connections,
    { detect: async () => {
      throw new Error("not-used");
    } } as any,
    {
      check: async () => {
        checks += 1;
        await gate;
        return {
          state: "ready",
          installed: true,
          connected: true,
          checkedAt: "2026-07-29T00:00:00.000Z",
          doctor: { command: "wecli doctor" },
        };
      },
    },
    () => new Date("2026-07-29T00:01:00.000Z"),
  );
  const first = service.refresh();
  const second = service.refresh();
  assert.equal(first, second);
  let passiveState: string | undefined;
  const unsubscribe = service.subscribe((snapshot) => {
    passiveState = snapshot.entries.find((entry) => entry.id === "wecli")?.state;
  });
  release();
  await first;
  assert.equal(checks, 1);
  assert.equal(passiveState, "connected");
  unsubscribe();
});

test("integration refresh surfaces wecli version/daemon/extension as meta", async () => {
  const db = openOrCreateMailDatabase(":memory:");
  const connections = new ChannelConnectionRepository(
    db,
    () => new Date("2026-07-29T00:00:00.000Z"),
  );
  const service = new IntegrationStatusService(
    connections,
    {
      detect: async () => {
        throw new Error("not-used");
      },
    } as any,
    {
      check: async () => ({
        state: "ready" as const,
        installed: true,
        connected: true,
        binary: "C:\\tools\\wecli.exe",
        version: "1.9.97",
        checkedAt: "2026-07-29T00:00:00.000Z",
        daemon: { running: true, port: 19825, version: "1.9.97" },
        extension: { connected: true, version: "1.0.2" },
        doctor: { command: "wecli doctor" },
      }),
    },
    () => new Date("2026-07-29T00:00:00.000Z"),
  );

  await service.refresh();
  const wecli = service
    .getCached()
    .entries.find((entry) => entry.id === "wecli");
  assert.equal(wecli?.state, "connected");
  assert.deepEqual(wecli?.meta, {
    version: "1.9.97",
    binary: "C:\\tools\\wecli.exe",
    daemon: { running: true, port: 19825, version: "1.9.97" },
    extension: { connected: true, version: "1.0.2" },
  });
});
