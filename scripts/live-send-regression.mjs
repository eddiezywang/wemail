#!/usr/bin/env node
// Live-only regression: real SMTP outbound through the running WeMail
// instance. NOT part of the hermetic suite — it sends a real email.
//
// Usage:
//   node scripts/live-send-regression.mjs <recipient@example.com> --confirm-real-send
//
// Requirements: WeMail running with --remote-debugging-port=9223 and a
// logged-in account. Verification: poll the app's Sent folder via
// mailDatabase.listFolders (the server APPENDs the sent copy on success).
import { chromium } from "playwright";

const args = process.argv.slice(2);
const recipient = args.find((a) => !a.startsWith("--"));
if (!recipient || !args.includes("--confirm-real-send")) {
  console.error(
    "Usage: node scripts/live-send-regression.mjs <recipient> --confirm-real-send\n" +
      "This sends a REAL email through the logged-in account.",
  );
  process.exit(1);
}

const browser = await chromium.connectOverCDP("http://127.0.0.1:9223");
const page = browser
  .contexts()[0]
  .pages()
  .find((p) => p.url().match(/^http:\/\/127\.0\.0\.1:\d+\/$/)) ?? browser.contexts()[0].pages()[0];

const connected = await page.evaluate(
  async () => window.wemailDesktop?.mailDatabase?.isConnected?.() ?? false,
);
if (!connected) {
  console.error("[fail] canonical mail database unavailable");
  process.exit(1);
}

const stamp = new Date().toISOString();
const idem = `live-regression:${stamp}`;
const accountId = await page.evaluate(async () => {
  const health = await window.wemailDesktop.mailCore.health();
  return health?.accountRuntime?.accountId ?? null;
});
if (!accountId) {
  console.error("[fail] no active account");
  process.exit(1);
}

const committed = await page.evaluate(
  async ({ accountId, recipient, idem }) => {
    const database = window.wemailDesktop.mailDatabase;
    return await database.enqueueSend({
      accountId,
      to: [{ name: "WeMail Regression", email: recipient }],
      subject: `[WeMail 回归] 真实 SMTP 出站验证 ${idem.slice(-19)}`,
      bodyText: "WeMail 回归测试验证邮件（真实 SMTP 出站）。收到即代表发送链路健康。",
      bodyHtml: "<p>WeMail 回归测试验证邮件（真实 SMTP 出站）。收到即代表发送链路健康。</p>",
      attachments: [],
      idempotencyKey: idem,
    });
  },
  { accountId, recipient, idem },
);
console.log("enqueued:", JSON.stringify({
  accountId,
  outboxId: committed?.value?.outboxId,
  messageIdHeader: committed?.value?.messageIdHeader,
}));

// Wait for the server-side Sent APPEND to sync into the canonical folders.
let sentFolder = null;
for (let attempt = 0; attempt < 12; attempt++) {
  await new Promise((r) => setTimeout(r, 15_000));
  const folders = await page.evaluate(async () => {
    const arr = (await window.wemailDesktop.mailDatabase.listFolders(accountId)) ?? [];
    return arr.filter((f) => /sent/i.test(f.id) || /已发送|Sent/i.test(f.name ?? ""));
  });
  sentFolder = folders.find((f) => (f.totalCount ?? 0) > 0) ?? null;
  if (sentFolder) break;
}
console.log(
  sentFolder
    ? `sent-copy folder synced: ${sentFolder.id} (${sentFolder.name}) totalCount=${sentFolder.totalCount}`
    : "[warn] Sent folder copy not observed within timeout — check the recipient inbox and the app's Sent folder manually",
);
await browser.close();
