import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { _electron as electron } from "playwright";

const root = path.resolve(process.cwd());
const executablePath = process.env.WEMAIL_ELECTRON_EXE;
if (!executablePath) throw new Error("WEMAIL_ELECTRON_EXE is required");

const durationSeconds = Number(process.env.WEMAIL_SAMPLE_DURATION_SECONDS ?? 1800);
const intervalSeconds = Number(process.env.WEMAIL_SAMPLE_INTERVAL_SECONDS ?? 5);
const reportDir = path.join(root, "workspace/reports");
const durationMinutes = Math.max(1, Math.round(durationSeconds / 60));
const artifactPrefix = `wemail-interactive-${durationMinutes}m`;
const actionsPath = path.join(reportDir, `${artifactPrefix}-actions.json`);
const resourcesPath = path.join(reportDir, `${artifactPrefix}-processes.json`);
const resourcesRelativePath = `workspace/reports/${artifactPrefix}-processes.json`;
const summaryPath = path.join(reportDir, `${artifactPrefix}-summary.md`);
const startupLog = path.join(process.env.APPDATA ?? "", "wemail/data/startup.log");
const actionTimeoutMs = Number(process.env.WEMAIL_ACTION_TIMEOUT_MS ?? 120_000);
const continuityToleranceMs = Math.max(intervalSeconds * 3_000, 30_000);
const rendererUrl = "http://127.0.0.1:5173";

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function withTimeout(operation, timeoutMs, label) {
  let timer;
  return Promise.race([
    operation,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs}ms`)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function terminateProcessTree(pid) {
  if (process.platform !== "win32") return;
  await new Promise((resolve) => {
    const killer = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
    });
    killer.once("error", resolve);
    killer.once("exit", resolve);
  });
}

async function isRendererHealthy() {
  return fetch(rendererUrl, { signal: AbortSignal.timeout(3_000) })
    .then((response) => response.ok)
    .catch(() => false);
}

async function waitForRenderer(rendererProcess) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (rendererProcess.exitCode != null) {
      throw new Error(`Built renderer exited with code ${rendererProcess.exitCode}`);
    }
    if (await isRendererHealthy()) return;
    await sleep(500);
  }
  throw new Error(`Built renderer did not become healthy: ${rendererUrl}`);
}

function percentile(values, quantile) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * quantile))];
}

function summarizeActions(actions, kind) {
  const matching = actions.filter((action) => action.kind === kind);
  const successful = matching.filter((action) => action.ok);
  const durations = successful.map((action) => action.durationMs);
  return {
    attempts: matching.length,
    successes: successful.length,
    failures: matching.length - successful.length,
    p50Ms: percentile(durations, 0.5),
    p95Ms: percentile(durations, 0.95),
    maxMs: durations.length > 0 ? Math.max(...durations) : null,
  };
}

function compactHealth(health, phase) {
  const worker = (runtime) => runtime ? {
    state: runtime.state,
    metrics: runtime.metrics ?? null,
  } : null;
  return {
    at: new Date().toISOString(),
    phase,
    uptimeMs: health.uptimeMs,
    dbWriter: worker(health.dbWriter),
    imap: worker(health.accountRuntime),
    ai: health.intelligenceRuntime ? {
      state: health.intelligenceRuntime.state,
      metrics: health.intelligenceRuntime.metrics ?? null,
      circuitBreaker: health.intelligenceRuntime.circuitBreaker ?? null,
    } : null,
    snapshot: health.snapshotRuntime ?? null,
    maintenance: health.maintenanceRuntime ?? null,
  };
}

function formatMiB(bytes) {
  return bytes == null ? "n/a" : `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

function formatNumber(value, digits = 1) {
  return value == null ? "n/a" : Number(value).toFixed(digits);
}

async function waitForAgentSettlement(page, priorAnswers, priorLastAnswer, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const stopVisible = await page.getByTestId("agent-stop").isVisible().catch(() => false);
    const answers = page.getByTestId("agent-final-answer");
    const answerCount = await answers.count().catch(() => priorAnswers);
    const lastAnswer = answerCount > 0
      ? await answers.last().innerText().catch(() => priorLastAnswer)
      : "";
    const answerChanged = answerCount > priorAnswers || lastAnswer !== priorLastAnswer;
    if (!stopVisible && answerChanged && lastAnswer.trim()) return;
    await sleep(500);
  }
  throw new Error(`Agent response did not settle within ${timeoutMs}ms`);
}

await fs.mkdir(reportDir, { recursive: true });
await Promise.all([actionsPath, resourcesPath, summaryPath].map(
  (reportPath) => fs.rm(reportPath, { force: true }),
));
let rendererProcess = null;
if (!await isRendererHealthy()) {
  rendererProcess = spawn(process.execPath, [
    path.join(root, "scripts/serve-built-renderer.mjs"),
    "--root", root,
    "--port", "5173",
  ], { cwd: root, stdio: "ignore" });
  await waitForRenderer(rendererProcess);
}
const app = await electron.launch({
  executablePath,
  cwd: root,
  args: ["--no-sandbox", "dist-electron/electron/main/app.js"],
  env: {
    ...process.env,
    VITE_DEV_SERVER_URL: rendererUrl,
    WEMAIL_DEV_TRACE: "1",
    WEMAIL_TRACE_DURATION_MS: String(Math.min(durationSeconds * 1000, 60_000)),
    WEMAIL_TRACE_OUTPUT_DIR: reportDir,
  },
  timeout: 60_000,
});

const desktopPid = app.process().pid;
let applicationClosed = false;
let pageClosed = false;
app.once("close", () => { applicationClosed = true; });
const sampler = spawn("pwsh.exe", [
  "-NoProfile",
  "-ExecutionPolicy", "Bypass",
  "-File", path.join(root, "scripts/measure-mail-core-performance.ps1"),
  "-DesktopPid", String(desktopPid),
  "-DurationSeconds", String(durationSeconds),
  "-IntervalSeconds", String(intervalSeconds),
  "-OutputPath", resourcesRelativePath,
], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });

let samplerOutput = "";
let samplerError = "";
let samplerFailure = null;
sampler.stdout.on("data", (chunk) => { samplerOutput += chunk.toString(); });
sampler.stderr.on("data", (chunk) => { samplerError += chunk.toString(); });
const samplerDone = new Promise((resolve, reject) => {
  sampler.once("error", reject);
  sampler.once("exit", (code) => code === 0
    ? resolve()
    : reject(new Error(`Resource sampler exited ${code}: ${samplerError}`)));
}).catch((error) => {
  samplerFailure = error instanceof Error ? error.message : String(error);
});

const actions = [];
const healthSamples = [];
let phase = "startup";
let healthTimer;
let continuityTimer;
let lastContinuityPulseAt = Date.now();
let maximumEventLoopGapMs = 0;
let runError = null;

async function writeActionCheckpoint() {
  await fs.writeFile(actionsPath, `${JSON.stringify({
    version: 1,
    collectedAt: new Date().toISOString(),
    durationSeconds,
    intervalSeconds,
    desktopPid,
    runError,
    actions,
    healthSamples,
  }, null, 2)}\n`, "utf8");
}

async function recordAction(kind, operation) {
  const startedAt = Date.now();
  let fatalError = null;
  phase = kind;
  try {
    const details = await withTimeout(operation(), actionTimeoutMs, kind);
    actions.push({ at: new Date(startedAt).toISOString(), kind, ok: true, durationMs: Date.now() - startedAt, ...details });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    actions.push({
      at: new Date(startedAt).toISOString(),
      kind,
      ok: false,
      durationMs: Date.now() - startedAt,
      error: message,
    });
    if (applicationClosed || pageClosed || /Target page, context or browser has been closed/i.test(message)) {
      fatalError = error;
    }
  } finally {
    phase = "idle";
    await writeActionCheckpoint();
  }
  if (fatalError) throw fatalError;
}

try {
  const page = await app.firstWindow({ timeout: 60_000 });
  page.once("close", () => { pageClosed = true; });
  page.setDefaultTimeout(15_000);
  page.setDefaultNavigationTimeout(15_000);
  await page.waitForLoadState("domcontentloaded");
  await page.locator("[data-testid='workbench']").waitFor({ state: "visible", timeout: 60_000 });
  await page.locator("[data-testid='mail-item']").first().waitFor({ state: "visible", timeout: 60_000 });
  await page.bringToFront();

  healthTimer = setInterval(() => {
    void page.evaluate(async () => window.wemailDesktop?.mailCore?.health())
      .then((health) => {
        if (health) healthSamples.push(compactHealth(health, phase));
      })
      .catch(() => undefined);
  }, intervalSeconds * 1000);
  continuityTimer = setInterval(() => {
    const now = Date.now();
    maximumEventLoopGapMs = Math.max(maximumEventLoopGapMs, now - lastContinuityPulseAt);
    lastContinuityPulseAt = now;
  }, 1_000);

  const startedAt = Date.now();
  const deadline = startedAt + durationSeconds * 1000;
  const schedule = [];
  for (let offset = 15; offset < durationSeconds; offset += 45) schedule.push({ offset, kind: "mailOpen" });
  for (let offset = 30; offset < durationSeconds; offset += 90) schedule.push({ offset, kind: "categorySwitch" });
  for (let offset = 60; offset < durationSeconds; offset += 120) schedule.push({ offset, kind: "search" });
  for (let offset = 120; offset < durationSeconds; offset += 300) schedule.push({ offset, kind: "agentChat" });
  schedule.sort((left, right) => left.offset - right.offset || left.kind.localeCompare(right.kind));

  let mailIndex = 0;
  let searchIndex = 0;
  for (const item of schedule) {
    const scheduledAt = startedAt + item.offset * 1000;
    const waitMs = scheduledAt - Date.now();
    if (waitMs > 0) await sleep(waitMs);
    if (maximumEventLoopGapMs > continuityToleranceMs) {
      throw new Error(`Sampling continuity lost: event loop gap ${maximumEventLoopGapMs}ms`);
    }
    if (Date.now() >= deadline) break;

    if (item.kind === "mailOpen") {
      await recordAction(item.kind, async () => {
        await page.keyboard.press("Escape");
        await page.locator(".wm-overlay-fade[data-state='open']")
          .waitFor({ state: "hidden", timeout: 3_000 })
          .catch(() => undefined);
        let rows = page.locator("[data-testid='mail-item']");
        let count = await rows.count();
        if (count === 0) {
          // Empty categories are valid. Use the real SPA navigation link so
          // the built static server does not receive a deep-link request.
          const allMail = page.locator("a[data-folder='all-mail']").first();
          await allMail.waitFor({ state: "visible", timeout: 15_000 });
          await allMail.click();
          await page.waitForFunction(
            () => window.location.pathname === "/folder/all-mail" && !new URL(window.location.href).searchParams.get("category"),
            null,
            { timeout: 15_000 },
          );
          await page.locator("[data-testid='workbench']").waitFor({ state: "visible", timeout: 15_000 });
          await page.locator("[data-testid='mail-item']").first().waitFor({ state: "visible", timeout: 15_000 });
          rows = page.locator("[data-testid='mail-item']");
          count = await rows.count();
        }
        if (count === 0) throw new Error("No visible mail rows");
        const row = rows.nth(mailIndex % Math.min(count, 10));
        mailIndex += 1;
        const emailId = await row.getAttribute("data-id");
        await row.click();
        const panel = page.locator("[data-testid='email-panel-shell']");
        await panel.waitFor({ state: "visible", timeout: 15_000 });
        if (emailId) await page.waitForFunction((id) => document.querySelector("[data-testid='email-panel-shell']")?.getAttribute("data-email-id") === id, emailId, { timeout: 15_000 });
        await page.locator("[data-testid='email-body-content'], [data-testid='email-body-loading']").first().waitFor({ state: "visible", timeout: 15_000 });
        return { rowIndex: (mailIndex - 1) % Math.min(count, 10) };
      });
    } else if (item.kind === "categorySwitch") {
      await recordAction(item.kind, async () => {
        await page.keyboard.press("Escape");
        await page.locator(".wm-overlay-fade[data-state='open']")
          .waitFor({ state: "hidden", timeout: 3_000 })
          .catch(() => undefined);
        const categories = page.locator("[data-folder^='category:']");
        const categoryCount = await categories.count();
        let visibleCategory = null;
        for (let index = 0; index < categoryCount; index += 1) {
          const candidate = categories.nth(index);
          if (await candidate.isVisible().catch(() => false)) {
            visibleCategory = candidate;
            break;
          }
        }
        const categoryId = visibleCategory
          ? (await visibleCategory.getAttribute("data-folder"))?.slice("category:".length) ?? "important"
          : "important";
        if (visibleCategory) {
          await visibleCategory.click();
        } else {
          await page.goto(`${rendererUrl}/folder/all-mail?category=${encodeURIComponent(categoryId)}`);
        }
        await page.waitForFunction(
          (expected) => new URL(window.location.href).searchParams.get("category") === expected,
          categoryId,
          { timeout: 15_000 },
        );
        await page.locator("[data-testid='workbench']").waitFor({ state: "visible", timeout: 15_000 });
        await page.waitForTimeout(250);
        return {
          categoryId,
          visibleRows: await page.locator("[data-testid='mail-item']").count(),
          usedVisibleLink: visibleCategory !== null,
        };
      });
    } else if (item.kind === "search") {
      await recordAction(item.kind, async () => {
        const terms = ["会议", "通知", "项目"];
        const term = terms[searchIndex % terms.length];
        searchIndex += 1;
        const input = page.getByRole("searchbox");
        await input.fill(term);
        await input.press("Enter");
        await page.waitForFunction((query) => new URL(window.location.href).searchParams.get("q") === query, term, { timeout: 15_000 });
        await page.waitForTimeout(750);
        const resultCount = await page.locator("[data-testid='mail-item']").count();
        const clear = page.getByRole("button", { name: "清除搜索" });
        if (await clear.isVisible().catch(() => false)) await clear.click();
        await page.waitForFunction(() => !new URL(window.location.href).searchParams.get("q"), null, { timeout: 15_000 });
        return { resultCount };
      });
    } else if (item.kind === "agentChat") {
      await recordAction(item.kind, async () => {
        let input = page.locator(
          "textarea[aria-label='向 WeMail AI 发送消息'], textarea[aria-label='Chat message input']",
        ).first();
        if (!await input.isVisible().catch(() => false)) {
          const launcher = page.getByRole("button", { name: "打开 WeMail AI" });
          await launcher.waitFor({ state: "visible", timeout: 15_000 });
          await launcher.click();
          input = page.locator(
            "textarea[aria-label='向 WeMail AI 发送消息'], textarea[aria-label='Chat message input']",
          ).first();
        }
        await input.waitFor({ state: "visible", timeout: 15_000 });
        const answers = page.getByTestId("agent-final-answer");
        const priorAnswers = await answers.count();
        const priorLastAnswer = priorAnswers > 0
          ? await answers.last().innerText().catch(() => "")
          : "";
        await input.fill("请只用一句话回复：WeMail 性能采样对话正常。不要调用任何工具。");
        await page.getByTestId("agent-send").click();
        await waitForAgentSettlement(page, priorAnswers, priorLastAnswer, 90_000);
        return {};
      });
    }
  }

  const remainingMs = deadline - Date.now();
  if (remainingMs > 0) await sleep(remainingMs);
} catch (error) {
  runError = error instanceof Error ? error.message : String(error);
} finally {
  if (healthTimer) clearInterval(healthTimer);
  if (continuityTimer) clearInterval(continuityTimer);
  if (runError && sampler.exitCode == null) sampler.kill();
  await samplerDone;
  let closed = false;
  await Promise.race([
    app.close().then(() => { closed = true; }).catch(() => undefined),
    sleep(15_000),
  ]);
  if (!closed) {
    await terminateProcessTree(desktopPid);
  }
  await terminateProcessTree(desktopPid);
  if (rendererProcess?.exitCode == null) rendererProcess.kill();
}

await writeActionCheckpoint();
if (!await fs.stat(resourcesPath).then(() => true).catch(() => false)) {
  throw new Error(`Resource report missing. Sampler error: ${samplerError || samplerFailure || "unknown"}`);
}
const resourceReport = JSON.parse(await fs.readFile(resourcesPath, "utf8"));
const sampleTimes = resourceReport.samples.map((sample) => Date.parse(sample.at));
const maximumSampleGapMs = sampleTimes.slice(1).reduce(
  (maximum, value, index) => Math.max(maximum, value - sampleTimes[index]),
  0,
);
const wallDurationMs = Date.parse(resourceReport.completedAt) - Date.parse(resourceReport.startedAt);
const continuity = {
  valid: runError == null
    && maximumSampleGapMs <= continuityToleranceMs
    && maximumEventLoopGapMs <= continuityToleranceMs
    && wallDurationMs <= durationSeconds * 1000 + continuityToleranceMs,
  wallDurationMs,
  maximumSampleGapMs,
  maximumEventLoopGapMs,
  toleranceMs: continuityToleranceMs,
};
const actionSummary = {
  mailOpen: summarizeActions(actions, "mailOpen"),
  categorySwitch: summarizeActions(actions, "categorySwitch"),
  search: summarizeActions(actions, "search"),
  agentChat: summarizeActions(actions, "agentChat"),
};
const payload = {
  version: 1,
  collectedAt: new Date().toISOString(),
  durationSeconds,
  intervalSeconds,
  desktopPid,
  startupLog,
  runError,
  samplerOutput: samplerOutput.trim(),
  samplerError: [samplerError.trim(), samplerFailure].filter(Boolean).join("\n") || null,
  continuity,
  actionSummary,
  actions,
  healthSamples,
};
await fs.writeFile(actionsPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

const total = resourceReport.summary.total;
const mailCore = resourceReport.summary.mailCore;
const workerRestarts = healthSamples.reduce((result, sample) => ({
  dbWriter: Math.max(result.dbWriter, sample.dbWriter?.metrics?.restartCount ?? 0),
  imap: Math.max(result.imap, sample.imap?.metrics?.restartCount ?? 0),
  ai: Math.max(result.ai, sample.ai?.metrics?.restartCount ?? 0),
}), { dbWriter: 0, imap: 0, ai: 0 });
const markdown = `# WeMail ${durationMinutes} 分钟交互性能采样\n\n` +
  `- 时间：${resourceReport.startedAt} 至 ${resourceReport.completedAt}\n` +
  `- 时长：${durationSeconds} 秒；资源采样：${resourceReport.sampleCount} 个（间隔 ${intervalSeconds} 秒）\n` +
  `- 连续性：${continuity.valid ? "有效" : "无效"}（墙钟 ${(continuity.wallDurationMs / 1000).toFixed(1)} 秒，最大采样间隔 ${(continuity.maximumSampleGapMs / 1000).toFixed(1)} 秒，事件循环最大间隔 ${(continuity.maximumEventLoopGapMs / 1000).toFixed(1)} 秒）\n` +
  `- 行为：邮件详情 ${actionSummary.mailOpen.attempts} 次、分类切换 ${actionSummary.categorySwitch.attempts} 次、搜索 ${actionSummary.search.attempts} 次、Agent 聊天 ${actionSummary.agentChat.attempts} 次\n` +
  `- 运行错误：${runError ?? "无"}\n\n` +
  `## 交互耗时\n\n` +
  `| 行为 | 成功/总数 | P50 | P95 | 最大 |\n|---|---:|---:|---:|---:|\n` +
  `| 点击邮件详情 | ${actionSummary.mailOpen.successes}/${actionSummary.mailOpen.attempts} | ${formatNumber(actionSummary.mailOpen.p50Ms)} ms | ${formatNumber(actionSummary.mailOpen.p95Ms)} ms | ${formatNumber(actionSummary.mailOpen.maxMs)} ms |\n` +
  `| 切换分类 | ${actionSummary.categorySwitch.successes}/${actionSummary.categorySwitch.attempts} | ${formatNumber(actionSummary.categorySwitch.p50Ms)} ms | ${formatNumber(actionSummary.categorySwitch.p95Ms)} ms | ${formatNumber(actionSummary.categorySwitch.maxMs)} ms |\n` +
  `| 搜索并返回 | ${actionSummary.search.successes}/${actionSummary.search.attempts} | ${formatNumber(actionSummary.search.p50Ms)} ms | ${formatNumber(actionSummary.search.p95Ms)} ms | ${formatNumber(actionSummary.search.maxMs)} ms |\n` +
  `| Agent 完整回复 | ${actionSummary.agentChat.successes}/${actionSummary.agentChat.attempts} | ${formatNumber(actionSummary.agentChat.p50Ms)} ms | ${formatNumber(actionSummary.agentChat.p95Ms)} ms | ${formatNumber(actionSummary.agentChat.maxMs)} ms |\n\n` +
  `## Electron 总资源\n\n` +
  `| 指标 | 平均/P50 | P95 | 最大 |\n|---|---:|---:|---:|\n` +
  `| Working Set | ${formatMiB(total.workingSetBytes.p50)} | ${formatMiB(total.workingSetBytes.p95)} | ${formatMiB(total.workingSetBytes.max)} |\n` +
  `| Private Bytes | ${formatMiB(total.privateBytes.p50)} | ${formatMiB(total.privateBytes.p95)} | ${formatMiB(total.privateBytes.max)} |\n` +
  `| CPU | ${formatNumber(total.cpuPercent.average)}% | ${formatNumber(total.cpuPercent.p95)}% | ${formatNumber(total.cpuPercent.max)}% |\n` +
  `| 线程 | ${formatNumber(total.threads.p50, 0)} | ${formatNumber(total.threads.p95, 0)} | ${formatNumber(total.threads.max, 0)} |\n` +
  `| 句柄 | ${formatNumber(total.handles.p50, 0)} | ${formatNumber(total.handles.p95, 0)} | ${formatNumber(total.handles.max, 0)} |\n\n` +
  `## Mail Core\n\n` +
  `- Working Set P95 / 最大：${formatMiB(mailCore?.workingSetBytes?.p95)} / ${formatMiB(mailCore?.workingSetBytes?.max)}\n` +
  `- Private Bytes P95 / 最大：${formatMiB(mailCore?.privateBytes?.p95)} / ${formatMiB(mailCore?.privateBytes?.max)}\n` +
  `- Worker 最大重启次数：DB Writer ${workerRestarts.dbWriter}，IMAP ${workerRestarts.imap}，AI ${workerRestarts.ai}\n` +
  `- Health 样本：${healthSamples.length}\n\n` +
  `## 产物\n\n` +
  `- 行为与 Worker health：${path.relative(root, actionsPath)}\n` +
  `- 逐进程资源：${path.relative(root, resourcesPath)}\n`;
await fs.writeFile(summaryPath, markdown, "utf8");
process.stdout.write(`${JSON.stringify({ actionsPath, resourcesPath, summaryPath, actionSummary }, null, 2)}\n`);
