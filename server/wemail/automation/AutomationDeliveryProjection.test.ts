import assert from "node:assert/strict";
import test from "node:test";
import { openOrCreateMailDatabase } from "../database/Database.js";
import { projectAutomationDeliveries } from "./AutomationDeliveryProjection.js";

test("projects the Bot delivery ledger as the user-facing delivery outcome", () => {
  const db = openOrCreateMailDatabase(":memory:");
  db.pragma("foreign_keys = OFF");
  db.prepare(
    `INSERT INTO channel_deliveries (
      id, connection_id, profile_id, bot_uuid, platform, target_type,
      target_id, purpose, text, state, sequence, attempts, max_attempts,
      automation_run_id, created_at, updated_at, sent_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "delivery-wecom",
    "connection-1",
    "profile-1",
    "bot-1",
    "wecom",
    "person",
    "user-1",
    "automation",
    "daily report",
    "sent",
    0,
    1,
    3,
    "run-1",
    "2026-07-31T00:00:00.000Z",
    "2026-07-31T00:00:01.000Z",
    "2026-07-31T00:00:01.000Z",
  );

  assert.deepEqual(projectAutomationDeliveries(db, "run-1"), [
    {
      destination: "wecom_bot",
      status: "succeeded",
      outputId: "delivery-wecom",
    },
  ]);
  db.close();
});

test("keeps a queued delivery pending instead of reporting it as delivered", () => {
  const db = openOrCreateMailDatabase(":memory:");
  db.pragma("foreign_keys = OFF");
  db.prepare(
    `INSERT INTO channel_deliveries (
      id, connection_id, profile_id, bot_uuid, platform, target_type,
      target_id, purpose, text, state, sequence, attempts, max_attempts,
      automation_run_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "delivery-feishu",
    "connection-1",
    "profile-1",
    "bot-1",
    "feishu",
    "group",
    "group-1",
    "automation",
    "daily report",
    "retrying",
    0,
    1,
    3,
    "run-2",
    "2026-07-31T00:00:00.000Z",
    "2026-07-31T00:00:01.000Z",
  );

  assert.deepEqual(projectAutomationDeliveries(db, "run-2"), [
    {
      destination: "feishu_bot",
      status: "pending",
      outputId: "delivery-feishu",
    },
  ]);
  db.close();
});
