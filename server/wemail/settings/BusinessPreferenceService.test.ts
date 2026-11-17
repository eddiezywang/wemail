import assert from "node:assert/strict";
import test from "node:test";
import { openOrCreateMailDatabase } from "../database/Database.js";
import { MailDatabaseWriter } from "../database/MailDatabaseWriter.js";
import {
  BusinessPreferenceService,
  DEFAULT_BUSINESS_PREFERENCES,
} from "./BusinessPreferenceService.js";

test("business preference writes commit with a change event and roll back on commit failure", () => {
  const db = openOrCreateMailDatabase(":memory:");
  try {
    const writer = new MailDatabaseWriter(db);
    const saved = writer.saveBusinessPreferences({ newMailNotifications: false });
    assert.equal(saved.value.newMailNotifications, false);
    assert.equal(saved.value.threading, true);
    assert.deepEqual(saved.changes, [{ entityType: "setting", entityPublicId: "business-preferences", operation: "update" }]);
    db.exec("CREATE TRIGGER reject_preference_commit BEFORE INSERT ON db_commits WHEN NEW.source = 'business-preferences' BEGIN SELECT RAISE(ABORT, 'commit-failed'); END");
    assert.throws(() => writer.saveBusinessPreferences({ newMailNotifications: true }), /commit-failed/);
    assert.equal(new BusinessPreferenceService(db).get().newMailNotifications, false);
    assert.equal(Number(db.prepare("SELECT MAX(version) FROM db_commits").pluck().get()), saved.commitVersion);
    assert.throws(() => writer.saveBusinessPreferences({ notificationContentMode: "invalid" as never }));
    assert.throws(() => writer.saveBusinessPreferences({ secret: "invalid" } as never));
  } finally {
    db.close();
  }
});

test("notification preferences default to enabled mail and action-required alerts", () => {
  const db = openOrCreateMailDatabase(":memory:");
  try {
    const service = new BusinessPreferenceService(db);

    assert.equal(DEFAULT_BUSINESS_PREFERENCES.actionRequiredNotifications, true);
    assert.equal(DEFAULT_BUSINESS_PREFERENCES.newMailNotifications, true);
    assert.equal(DEFAULT_BUSINESS_PREFERENCES.notificationSound, false);
    assert.equal(DEFAULT_BUSINESS_PREFERENCES.notificationContentMode, "full");
    assert.deepEqual(service.get(), DEFAULT_BUSINESS_PREFERENCES);
  } finally {
    db.close();
  }
});

test("legacy notification records without a dedicated choice use the enabled default", () => {
  const db = openOrCreateMailDatabase(":memory:");
  try {
    db.prepare(
      `INSERT INTO business_preferences (id, preferences_json, updated_at)
       VALUES ('default', ?, ?)`,
    ).run(
      JSON.stringify({
        desktopNotifications: false,
        notificationSound: true,
      }),
      "2026-07-26T00:00:00.000Z",
    );

    const preferences = new BusinessPreferenceService(db).get();

    assert.equal(preferences.actionRequiredNotifications, true);
    assert.equal(preferences.newMailNotifications, true);
    assert.equal(preferences.notificationSound, true);
    assert.equal(preferences.notificationContentMode, "full");
    assert.equal("desktopNotifications" in preferences, false);
  } finally {
    db.close();
  }
});

test("an explicit dedicated new-mail notification choice remains disabled", () => {
  const db = openOrCreateMailDatabase(":memory:");
  try {
    db.prepare(
      `INSERT INTO business_preferences (id, preferences_json, updated_at)
       VALUES ('default', ?, ?)`,
    ).run(
      JSON.stringify({
        desktopNotifications: true,
        newMailNotifications: false,
      }),
      "2026-07-28T00:00:00.000Z",
    );

    const preferences = new BusinessPreferenceService(db).get();

    assert.equal(preferences.newMailNotifications, false);
  } finally {
    db.close();
  }
});
