// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Workbench mutation regression: star/seen flags, delete, and unknown-id
// isolation flow through `mailDatabase.mutateMail` (canonical remote
// mutations, idempotency-keyed). Flags verify via getMailSnapshot;
// deletion verifies via the workbench list. Mutations need no LLM.
// Folder move requires a second provider folder — verified on the live
// instance instead.
import { expect, test } from "@playwright/test";
import { launchElectron, loginWithFixture } from "./helpers/electronApp";

const INBOX = ["mail-001-question.json", "mail-002-notification.json"];
const ACCOUNT_FIXTURE = "acct-e2e";

test("workbench mutations: flags, delete, unknown-id isolation", async () => {
  test.setTimeout(180_000);
  const app = await launchElectron({
    rendererUrl: "http://127.0.0.1:14175/",
    inboxFixtures: INBOX,
  });
  try {
    const window = await app.electronApp.firstWindow();
    await loginWithFixture(app.apiBaseUrl);
    await expect(window.getByTestId("workbench")).toBeVisible();
    await expect.poll(() =>
      window.evaluate(async () =>
        (await window.wemailDesktop?.mailCore?.health())?.accountRuntime?.accountId ?? null,
      ),
    ).toBe("acct-e2e");
    const accountId = await window.evaluate(async () =>
      (await window.wemailDesktop?.mailCore?.health())?.accountRuntime?.accountId ?? null,
    );
    const refresh = await window.evaluate(
      async ({ accountId }) => window.wemailDesktop?.mailCore?.refreshMail(accountId),
      { accountId },
    );
    expect(refresh?.status).toBe("queued");
    await expect(window.getByTestId("mail-item")).toHaveCount(2, { timeout: 20_000 });

    // Canonical ids from the DOM rows (data-id is the canonical email id).
    const ids: string[] = [];
    for (const row of await window.getByTestId("mail-item").all()) {
      const dataId = await row.getAttribute("data-id");
      expect(dataId).toBeTruthy();
      ids.push(dataId!);
    }
    expect(new Set(ids).size).toBe(2);

    const mutate = (emailId: string, mutation: unknown) =>
      window.evaluate(
        async ({ accountId, emailId, mutation, idempotencyKey }) =>
          window.wemailDesktop?.mailDatabase?.mutateMail(
            {
              accountId,
              emailId,
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              mutation: mutation as never,
            },
            idempotencyKey,
          ),
        {
          accountId,
          emailId,
          mutation,
          idempotencyKey: `regression:${emailId}:${Date.now()}:${Math.random()}`,
        },
      );

    const flagsOf = (emailId: string) =>
      window.evaluate(async ({ accountId, emailId }) => {
        const snap = await window.wemailDesktop?.mailDatabase?.getMailSnapshot(emailId);
        return (snap?.message as { flags?: { seen?: boolean; flagged?: boolean } })?.flags ?? null;
      }, { accountId, emailId });

    // 1. Star + read → snapshot flags reflect it.
    const star = await mutate(ids[0], { type: "flags", patch: { flagged: true, seen: true } });
    expect(star?.value?.status ?? star?.status).toBe("applied");
    await expect.poll(async () => {
      const flags = await flagsOf(ids[0]);
      return `${flags?.seen}/${flags?.flagged}`;
    }).toBe("true/true");

    // 2. Mark unread again.
    await mutate(ids[0], { type: "flags", patch: { seen: false } });
    await expect.poll(async () => (await flagsOf(ids[0]))?.seen).toBe(false);

    // 3. Delete the second message → it leaves the workbench list.
    //    (trash needs a trash folder, which the fixture provider lacks)
    const removed = await mutate(ids[1], { type: "delete" });
    expect(removed?.value?.status ?? removed?.status).toBe("applied");
    await expect
      .poll(async () => window.getByTestId("mail-item").count(), { timeout: 15_000 })
      .toBe(1);
    await expect(
      window.getByTestId("mail-item").filter({ hasText: "Quick question" }),
    ).toBeVisible();

    // 4. Unknown message id → structured rejection, runtime intact.
    let unknownError: string | null = null;
    try {
      await mutate("acct-e2e/INBOX/x-999", { type: "flags", patch: { seen: true } });
    } catch (error) {
      unknownError = String(error).slice(0, 120);
    }
    expect(unknownError).toBeTruthy();
    await expect.poll(() =>
      window.evaluate(async ({ accountId }) =>
        window.wemailDesktop?.mailDatabase?.isConnected?.() ?? false,
      { accountId }),
    ).toBe(true);
    await expect.poll(() =>
      window.evaluate(async ({ accountId }) =>
        (await window.wemailDesktop?.mailCore?.health())?.accountRuntime?.accountId ?? null,
      { accountId }),
    ).toBe("acct-e2e");
  } finally {
    await app.close();
  }
});
