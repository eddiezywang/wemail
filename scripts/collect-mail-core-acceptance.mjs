import fs from "node:fs/promises";
import path from "node:path";
import { _electron as electron } from "playwright";

const root = path.resolve(process.cwd());
const executablePath = process.env.WEMAIL_ELECTRON_EXE;
if (!executablePath) throw new Error("WEMAIL_ELECTRON_EXE is required");
const outputPath = path.join(root, "workspace/reports/mail-core-three-worker-acceptance.json");
const traceOutputDir = path.join(root, "workspace/reports");
const app = await electron.launch({
  executablePath,
  cwd: root,
  args: ["--no-sandbox", "dist-electron/electron/main/app.js"],
  env: {
    ...process.env,
    VITE_DEV_SERVER_URL: "http://127.0.0.1:5173",
    WEMAIL_DEV_TRACE: "1",
    WEMAIL_TRACE_DURATION_MS: "60000",
    WEMAIL_TRACE_OUTPUT_DIR: traceOutputDir,
  },
  timeout: 60_000,
});

try {
  const window = await app.firstWindow({ timeout: 60_000 });
  await window.waitForLoadState("domcontentloaded");
  const result = await window.evaluate(async () => {
    const desktop = window.wemailDesktop;
    if (!desktop?.mailCore) throw new Error("mailCore bridge unavailable");
    const idleWaitStartedAt = performance.now();
    let health;
    let lastHealthError;
    while (!health && performance.now() - idleWaitStartedAt < 60_000) {
      try {
        health = await desktop.mailCore.health();
      } catch (error) {
        lastHealthError = error;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    if (!health) throw lastHealthError ?? new Error("Mail Core health unavailable");
    while (
      performance.now() - idleWaitStartedAt < 60_000 &&
      (health.accountRuntime?.metrics?.queueDepth > 0 ||
        health.accountRuntime?.metrics?.activeJobKind)
    ) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      health = await desktop.mailCore.health();
    }
    const idleWaitDurationMs = performance.now() - idleWaitStartedAt;
    const baseUrl = await desktop.getApiBaseUrl();
    const current = baseUrl
      ? await fetch(`${baseUrl}/api/account/current`).then((response) => response.json())
      : { account: null };
    const account = current.account;
    const listDurationsMs = [];
    let list = { messages: [] };
    if (account) {
      for (let index = 0; index < 10; index += 1) {
        const listStartedAt = performance.now();
        list = await desktop.mailCore.listMail({
          accountId: account.id,
          accountEmail: account.emailAddress,
          limit: 50,
        });
        listDurationsMs.push(performance.now() - listStartedAt);
      }
    }
    const listDurationMs = listDurationsMs[0] ?? 0;
    const cachedSnapshotDurationsMs = [];
    const cachedSnapshotErrors = [];
    let firstSnapshot = null;
    const firstId = list.messages[0]?.id;
    if (firstId) {
      for (let index = 0; index < 30; index += 1) {
        const startedAt = performance.now();
        try {
          firstSnapshot = await desktop.mailCore.getMailSnapshot(firstId);
          cachedSnapshotDurationsMs.push(performance.now() - startedAt);
        } catch (error) {
          cachedSnapshotErrors.push(error instanceof Error ? error.message : String(error));
        }
      }
    }
    let uncached = null;
    for (const message of list.messages.slice(0, 10)) {
      const startedAt = performance.now();
      let snapshot;
      try {
        snapshot = await desktop.mailCore.getMailSnapshot(message.id);
      } catch {
        continue;
      }
      const metadataFirstScreenMs = performance.now() - startedAt;
      if (snapshot.bodyState !== "missing") continue;
      const ensure = await desktop.mailCore.ensureMailBody(message.id);
      const bodyStartedAt = performance.now();
      let bodyState = snapshot.bodyState;
      while (bodyState === "missing" && performance.now() - bodyStartedAt < 30_000) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        bodyState = (await desktop.mailCore.getMailSnapshot(message.id)).bodyState;
      }
      uncached = {
        id: message.id,
        metadataFirstScreenMs,
        ensureStatus: ensure.status,
        bodyCompletionMs: performance.now() - bodyStartedAt,
        finalBodyState: bodyState,
      };
      break;
    }
    return {
      health,
      finalHealth: await desktop.mailCore.health(),
      idleWaitDurationMs,
      account: account ? { id: account.id, emailAddress: account.emailAddress } : null,
      mailboxListCount: list.messages.length,
      listDurationMs,
      listDurationsMs,
      cachedSnapshotDurationsMs,
      cachedSnapshotErrors,
      cachedBodyState: firstSnapshot?.bodyState ?? null,
      uncached,
      userAgent: navigator.userAgent,
    };
  });
  await new Promise((resolve) => setTimeout(resolve, 62_000));
  const payload = {
    collectedAt: new Date().toISOString(),
    desktopPid: app.process().pid,
    windowVisible: await window.evaluate(() => document.visibilityState === "visible"),
    ...result,
  };
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  process.stdout.write(`${outputPath}\n`);
} finally {
  await app.close().catch(() => undefined);
}
