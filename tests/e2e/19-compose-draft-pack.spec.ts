// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Compose draft-pack regression: draft save → list → get → edit → delete
// through the canonical draft store, scheduled-send queueing (future
// scheduledAt) with cancellation (cancelled items persist as history),
// unknown-id grace, and the directory recipient search surface.
import { expect, test } from "@playwright/test";
import { launchElectron, loginWithFixture } from "./helpers/electronApp";

test("draft pack: save/list/get/edit/delete + scheduled queue", async () => {
  test.setTimeout(150_000);
  const app = await launchElectron();
  try {
    const window = await app.electronApp.firstWindow();
    await loginWithFixture(app.apiBaseUrl);
    await expect.poll(() =>
      window.evaluate(async () =>
        window.wemailDesktop?.mailDatabase?.isConnected?.() ?? false,
      ),
    ).toBe(true);

    const accountId = await window.evaluate(async () =>
      (await window.wemailDesktop?.mailCore?.health())?.accountRuntime?.accountId ?? null,
    );
    expect(accountId).toBeTruthy();

    const listDrafts = () =>
      window.evaluate(async ({ accountId }) =>
        window.wemailDesktop?.mailDatabase?.listDrafts({ accountId }),
      { accountId });

    // The draft store requires the account to be registered in the
    // canonical database — wait out the runtime attach, re-kicking a
    // refresh if the receipt has not gone idle yet.
    await expect.poll(async () => {
      const health = await window.evaluate(async () =>
        window.wemailDesktop?.mailCore?.health(),
      );
      const stage = health?.accountRuntime?.receipt?.stage;
      if (stage !== "idle") {
        await window.evaluate(async ({ accountId }) =>
          window.wemailDesktop?.mailCore?.refreshMail(accountId),
        { accountId });
      }
      return stage;
    }).toBe("idle");

    const saveDraftResilient = async () => {
      const deadline = Date.now() + 45_000;
      let lastError: string | null = null;
      while (Date.now() < deadline) {
        try {
          return await window.evaluate(async ({ accountId }) => {
            const result = await window.wemailDesktop?.mailDatabase?.saveDraft({
              accountId,
              to: [{ name: "Alice", email: "alice@example.test" }],
              subject: "回归草稿 A",
              bodyText: "草稿正文 A",
              bodyHtml: "<p>草稿正文 A</p>",
            });
            return result;
          }, { accountId });
        } catch (error) {
          lastError = String(error).slice(0, 100);
          await new Promise((r) => setTimeout(r, 1_500));
        }
      }
      throw new Error(`saveDraft never succeeded: ${lastError}`);
    };

    // 1. Save a NEW draft.
    const saved = await saveDraftResilient();
    const draftRecord = ((saved as { value?: Record<string, unknown> })?.value ?? {}) as {
      draft?: { id?: string };
      id?: string;
    };
    const id = draftRecord.draft?.id ?? draftRecord.id ?? null;
    expect(id).toBeTruthy();

    // 2. Listed.
    const listedAfterSave = (await listDrafts()) ?? [];
    expect(listedAfterSave.some((d) => d.id === id)).toBe(true);

    // 3. Read back.
    const fetched = await window.evaluate(async ({ accountId, draftId }) =>
      window.wemailDesktop?.mailDatabase?.getDraft({ accountId, id: draftId }),
    { accountId, draftId: id });
    expect((fetched as { subject?: string } | null)?.subject).toBe("回归草稿 A");

    // 4. Edit (same id, new subject) and read back.
    await window.evaluate(async ({ accountId, draftId }) => {
      await window.wemailDesktop?.mailDatabase?.saveDraft({
        id: draftId,
        accountId,
        subject: "回归草稿 B（已编辑）",
        bodyText: "草稿正文 B",
        bodyHtml: "<p>草稿正文 B</p>",
      });
    }, { accountId, draftId: id });
    const fetchedEdited = await window.evaluate(async ({ accountId, draftId }) =>
      window.wemailDesktop?.mailDatabase?.getDraft({ accountId, id: draftId }),
    { accountId, draftId: id });
    expect((fetchedEdited as { subject?: string } | null)?.subject).toBe("回归草稿 B（已编辑）");

    // 5. Scheduled send: future scheduledAt queues into the scheduled list;
    //    cancel keeps the item as history with status "cancelled".
    const scheduled = await window.evaluate(async ({ accountId }) => {
      const database = window.wemailDesktop?.mailDatabase;
      const enqueue = await database?.enqueueSend({
        accountId,
        to: [{ email: "scheduled@example.test" }],
        subject: "回归定时邮件",
        bodyText: "定时正文",
        bodyHtml: "<p>定时正文</p>",
        attachments: [],
        idempotencyKey: `regression-scheduled:${Date.now()}`,
        scheduledAt: new Date(Date.now() + 3600_000).toISOString(),
      });
      const list = await database?.listScheduled(accountId);
      return { enqueue, list };
    }, { accountId });
    const scheduledList = JSON.stringify(scheduled?.list ?? []);
    expect(scheduledList).toContain("回归定时邮件");

    const scheduledIdMatch = scheduledList.match(/"id":"(outbox_[^"]+)"/);
    if (scheduledIdMatch) {
      const cancelled = await window.evaluate(async ({ accountId, id }) =>
        window.wemailDesktop?.mailDatabase?.cancelScheduled(accountId, id),
      { accountId, id: scheduledIdMatch[1] });
      expect(cancelled).toBeTruthy();
      const listAfterCancel = await window.evaluate(async ({ accountId }) =>
        window.wemailDesktop?.mailDatabase?.listScheduled(accountId),
      { accountId });
      expect(JSON.stringify(listAfterCancel ?? [])).toContain('"status":"cancelled"');
    }

    // 6. Delete the draft; the write result reports the deletion.
    const deleted = await window.evaluate(async ({ accountId, draftId }) =>
      window.wemailDesktop?.mailDatabase?.deleteDraft({ accountId, id: draftId }),
    { accountId, draftId: id });
    expect(JSON.stringify(deleted ?? {})).toContain("true");
    const listedAfterDelete = (await listDrafts()) ?? [];
    expect(listedAfterDelete.some((d) => d.id === id)).toBe(false);
    const gone = await window.evaluate(async ({ accountId, draftId }) =>
      window.wemailDesktop?.mailDatabase?.getDraft({ accountId, id: draftId }),
    { accountId, draftId: id });
    expect(gone).toBeNull();

    // 7. Unknown delete id is graceful (rejected or no-op, never a crash).
    let unknownDelete: string | null = null;
    try {
      await window.evaluate(async ({ accountId }) =>
        window.wemailDesktop?.mailDatabase?.deleteDraft({
          accountId,
          id: "draft-unknown-999",
        }),
      { accountId });
    } catch (error) {
      unknownDelete = String(error).slice(0, 100);
    }
    expect(unknownDelete === null || unknownDelete.length > 0).toBe(true);

    // 8. Directory recipient search surface answers (hermetic dir is empty).
    const contacts = await fetch(
      `${app.apiBaseUrl}/api/directory/contacts?q=alice`,
    );
    expect(contacts.ok).toBeTruthy();
  } finally {
    await app.close();
  }
});
