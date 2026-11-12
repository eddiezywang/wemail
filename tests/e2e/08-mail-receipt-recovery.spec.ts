import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import type { MailMessage } from "../../shared/wemail/mail";
import { launchElectron, loginWithFixture } from "./helpers/electronApp";

test("isolated receipt completes its requested version and renders newly injected metadata once", async ({}, testInfo) => {
  test.setTimeout(120_000);
  let app = await launchElectron({ rendererUrl: "http://127.0.0.1:14175/" });
  try {
    fs.mkdirSync(path.join(app.dataDir, "mock-inbox"), { recursive: true });
    const window = await app.electronApp.firstWindow();
    await loginWithFixture(app.apiBaseUrl);
    await expect(window.getByTestId("workbench")).toBeVisible();
    await expect.poll(() => window.evaluate(async () => {
      const health = await window.wemailDesktop?.mailCore?.health();
      return health?.accountRuntime?.receipt.stage;
    })).toBe("idle");
    const samples: number[] = [];
    for (let index = 1; index <= 5; index++) {
      const timestamp = new Date().toISOString();
      const message: MailMessage = {
        id: `acct-e2e:INBOX:1:${index}`, accountId: "acct-e2e", folder: "INBOX",
        messageId: `<receipt-${index}@example.test>`, subject: `Receipt acceptance ${index}`,
        from: { email: "sender@example.test" }, to: [{ email: "recipient@example.test" }], cc: [], bcc: [],
        snippet: "Fixture", bodyText: "Fixture", bodyCachedUntil: timestamp, receivedAt: timestamp,
        hasAttachments: false, attachments: [], flags: { seen: false, flagged: false, answered: false, draft: false },
        sync: { uid: index, uidValidity: 1, internalDate: timestamp },
      };
      fs.writeFileSync(path.join(app.dataDir, "mock-inbox", `${index}.json`), JSON.stringify(message));
      const startedAt = performance.now();
      const requests = await window.evaluate(async () => Promise.all([
        window.wemailDesktop!.mailCore!.refreshMail("acct-e2e"),
        window.wemailDesktop!.mailCore!.refreshMail("acct-e2e"),
      ]));
      for (const request of requests) {
        expect(request.status).toBe("queued");
        expect(request.receiptVersion).toBeGreaterThan(0);
        let lastReceipt: unknown = null;
        try {
          await expect.poll(async () => {
            lastReceipt = await window.evaluate(async () =>
              (await window.wemailDesktop!.mailCore!.health()).accountRuntime?.receipt ?? null,
            );
            const receipt = lastReceipt as {
              runtimeId?: string;
              completedVersion?: number;
            } | null;
            return Boolean(
              receipt &&
              receipt.runtimeId === request.runtimeId &&
              (receipt.completedVersion ?? 0) >= request.receiptVersion!,
            );
          }, { timeout: 30_000 }).toBe(true);
        } catch (error) {
          throw new Error(
            `receipt did not reach requested version: request=${JSON.stringify(request)} ` +
            `lastReceipt=${JSON.stringify(lastReceipt)}: ${(error as Error).message}`,
          );
        }
      }
      const row = window.getByTestId("mail-item").filter({ hasText: message.subject });
      await expect(row).toBeVisible();
      await expect(row).toHaveCount(1);
      samples.push(performance.now() - startedAt);
    }
    await expect(window.getByTestId("mail-item")).toHaveCount(5);
    const beforeClick = await window.evaluate(async () =>
      (await window.wemailDesktop!.mailCore!.health()).accountRuntime?.receipt.requestedVersion ?? 0);
    await window.getByRole("button", { name: "手动刷新", exact: true }).click();
    await expect.poll(() => window.evaluate(async (version) =>
      ((await window.wemailDesktop!.mailCore!.health()).accountRuntime?.receipt.completedVersion ?? 0) > version,
    beforeClick)).toBe(true);
    await expect(window.getByRole("button", { name: "手动刷新", exact: true })).toBeEnabled();
    await expect(window.getByTestId("mail-item")).toHaveCount(5);
    const ordered = [...samples].sort((a, b) => a - b);
    const health = await window.evaluate(() => window.wemailDesktop!.mailCore!.health());
    const evidencePath = testInfo.outputPath("isolated-receipt-evidence.json");
    fs.writeFileSync(evidencePath, JSON.stringify({
      provider: "FileInjectedMailProvider", realImap: false, dataDir: app.dataDir,
      samplesMs: samples, p50Ms: ordered[2], p95Ms: ordered[4], maxMs: ordered[4],
      receipt: health.accountRuntime?.receipt, metrics: health.accountRuntime?.metrics,
    }, null, 2));
    await testInfo.attach("isolated-receipt-evidence", { contentType: "application/json", path: evidencePath });
    const dataDir = app.dataDir;
    await app.close();
    app = await launchElectron({ reuseDataDir: dataDir, rendererUrl: "http://127.0.0.1:14175/" });
    const restoredWindow = await app.electronApp.firstWindow();
    await expect(restoredWindow.getByTestId("workbench")).toBeVisible();
    await expect(restoredWindow.getByTestId("mail-item")).toHaveCount(5);
    // Re-open needs the Mail Core bridge connected before a manual refresh
    // can pick up the newly injected fixture.
    await expect
      .poll(() =>
        restoredWindow.evaluate(
          () => window.wemailDesktop?.mailCore?.isConnected() === true,
        ),
      )
      .toBe(true);
    const nextMessage = JSON.parse(fs.readFileSync(path.join(dataDir, "mock-inbox", "5.json"), "utf8")) as MailMessage;
    nextMessage.id = "acct-e2e:INBOX:1:6";
    nextMessage.messageId = "<receipt-6@example.test>";
    nextMessage.subject = "Receipt acceptance after restart";
    nextMessage.sync!.uid = 6;
    fs.writeFileSync(path.join(dataDir, "mock-inbox", "6.json"), JSON.stringify(nextMessage));
    await restoredWindow.getByRole("button", { name: "手动刷新", exact: true }).click();
    await expect(restoredWindow.getByTestId("mail-item").filter({ hasText: nextMessage.subject })).toBeVisible();
    await expect(restoredWindow.getByTestId("mail-item")).toHaveCount(6);
    await expect(restoredWindow.getByRole("button", { name: "手动刷新", exact: true })).toBeEnabled();
  } finally { await app.close(); }
});
