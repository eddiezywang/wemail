import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = process.cwd();
const reportPath = path.join(root, "workspace/reports/mail-core-three-worker-final.json");
const markdownPath = path.join(root, "workspace/reports/mail-core-three-worker-final.md");
const acceptance = JSON.parse(await fs.readFile(path.join(root, "workspace/reports/mail-core-three-worker-acceptance.json"), "utf8"));
const storedReport = JSON.parse(await fs.readFile(reportPath, "utf8"));
const measurement = storedReport.rawMeasurement ?? storedReport;
const trace = JSON.parse(await fs.readFile(path.join(root, "workspace/reports/mail-core-three-worker-trace-summary.json"), "utf8"));
const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const mib = (bytes) => bytes / 1024 / 1024;
const percent = (value, baseline) => (value - baseline) / baseline * 100;
const sorted = [...acceptance.cachedSnapshotDurationsMs].sort((a, b) => a - b);
const percentile = (values, quantile) => values.length ? values[Math.min(values.length - 1, Math.floor(values.length * quantile))] : null;
const cached = {
  attempts: acceptance.cachedSnapshotDurationsMs.length + acceptance.cachedSnapshotErrors.length,
  successes: acceptance.cachedSnapshotDurationsMs.length,
  timeouts: acceptance.cachedSnapshotErrors.length,
  p50Ms: percentile(sorted, 0.5),
  p95Ms: percentile(sorted, 0.95),
  maxMs: sorted.at(-1) ?? null,
};
const summary = measurement.summary;
const results = {
  workingSetP95MiB: mib(summary.workingSetBytes.p95),
  workingSetMaxMiB: mib(summary.workingSetBytes.max),
  privateP50MiB: mib(summary.privateBytes.p50),
  privatePeakMiB: mib(summary.privateBytes.max),
  cpuAveragePercent: summary.cpuPercent.average,
  cpuP95Percent: summary.cpuPercent.p95,
  cpuMaxPercent: summary.cpuPercent.max,
  threadP50: summary.threads.p50,
  threadP95: summary.threads.p95,
  threadMax: summary.threads.max,
  handleP50: summary.handles.p50,
  handleP95: summary.handles.p95,
  handleMax: summary.handles.max,
  cachedSnapshot: cached,
  uncachedMail: acceptance.uncached,
};
const criteria = [
  { criterion: "Only DB Writer, IMAP, and AI business workers", pass: acceptance.health.readers?.length === 0 && acceptance.health.backgroundRuntime === null && acceptance.health.dbWriter?.state === "ready" && acceptance.health.accountRuntime?.state === "ready" && acceptance.health.intelligenceRuntime?.state === "ready" },
  { criterion: "30-minute Working Set P95 <= 250 MiB", pass: results.workingSetP95MiB <= 250, actual: results.workingSetP95MiB },
  { criterion: "Private Bytes peak <= 320 MiB", pass: results.privatePeakMiB <= 320, actual: results.privatePeakMiB },
  { criterion: "Snapshot P95 <= 20 ms with no timeouts", pass: cached.p95Ms !== null && cached.p95Ms <= 20 && cached.timeouts === 0, actual: cached.p95Ms, timeouts: cached.timeouts },
  { criterion: "Mail click to metadata first screen P95 <= 100 ms", pass: cached.p95Ms !== null && cached.p95Ms <= 100 && cached.timeouts === 0, actual: cached.p95Ms },
  { criterion: "Idle CPU average <= 3%", pass: results.cpuAveragePercent <= 3, actual: results.cpuAveragePercent },
  { criterion: "Real Electron window and startup health", pass: acceptance.windowVisible === true },
];
const report = {
  version: 2,
  change: "mail-core-three-worker-consolidation",
  testedHeadCommit: commit,
  changeCommits: ["cf50a3b5", "444df29d", "31bc2d47", "15dcfd29"],
  generatedAt: new Date().toISOString(),
  environment: {
    platform: `${os.type()} ${os.release()} ${os.arch()}`,
    cpu: os.cpus()[0]?.model,
    logicalProcessors: os.cpus().length,
    totalMemoryMiB: mib(os.totalmem()),
    node: process.version,
    electronUserAgent: acceptance.userAgent,
    mailboxListSample: acceptance.mailboxListCount,
    databasePath: path.join(process.env.APPDATA ?? "", "wemail/data/wemail.sqlite"),
  },
  baseline: {
    workingSetMiB: 421,
    privateBytesMiB: 473,
    workingSetPeakMiB: 506,
    privatePeakMiB: 534,
    threads: 32,
    handles: 719,
    cpuPercent: 2.1,
    snapshotP50Ms: 2,
    snapshotP95Ms: 4,
    snapshotMaxMs: 18,
  },
  results,
  comparison: {
    workingSetP95VsStablePercent: percent(results.workingSetP95MiB, 421),
    workingSetMaxVsPeakPercent: percent(results.workingSetMaxMiB, 506),
    privateP50VsStablePercent: percent(results.privateP50MiB, 473),
    privatePeakPercent: percent(results.privatePeakMiB, 534),
    threadP50Percent: percent(results.threadP50, 32),
    handleP50Percent: percent(results.handleP50, 719),
    cpuAveragePercent: percent(results.cpuAveragePercent, 2.1),
  },
  topologyHealth: acceptance.health,
  criteria,
  verification: {
    focusedMailCoreTests: "pass (40 Node tests plus focused metrics/circuit/Snapshot tests)",
    rootTypecheck: "pass",
    serverTypecheck: "pass",
    desktopTypecheck: "pass",
    preloadVitest: "pass (4/4)",
    desktopBuild: "pass",
    electronStartup: "pass (mail-core-ready, loadURL-done, ready; visible window)",
    fullServerRendererSuites: "inconclusive: combined run did not exit within 10 minutes while unrelated long-lived test processes were already active",
    failureAcceptance: {
      imapWorkerIsolationAndCredentialRequired: "pass via MailCoreAccountRuntime tests",
      aiWorkerIsolationAndRestart: "pass via MailCoreIntelligenceRuntime tests",
      dbWriterDegradedRestartPath: "covered by runtime supervisor implementation; focused health test passed",
      durableLeaseRecovery: "pass via MailCoreDurableQueue tests",
      outboxNoDuplicateSideEffect: "pass via mutation idempotency and outbox tests",
    },
  },
  traceAnalysis: trace,
  rawMeasurement: measurement,
};
await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
const passLabel = (pass) => pass ? "PASS" : "FAIL";
const markdown = `# Mail Core Three Worker Final Performance Report

- Change: \`mail-core-three-worker-consolidation\`
- Tested HEAD: \`${commit}\`
- Change commits: \`cf50a3b5\`, \`444df29d\`, \`31bc2d47\`, \`15dcfd29\`
- Runtime: ${measurement.durationSeconds / 60} minutes, ${measurement.sampleCount}/${measurement.sampleCount} samples at ${measurement.intervalSeconds}s
- Environment: ${report.environment.platform}, ${report.environment.logicalProcessors} logical CPUs, ${(report.environment.totalMemoryMiB / 1024).toFixed(1)} GiB RAM
- Mailbox: real configured account, first ${acceptance.mailboxListCount} messages sampled; local DB path recorded in JSON

## Outcome

The three-worker topology and CPU target pass, but the change does **not** meet the final memory or Snapshot latency gates. Mail Core Working Set P95 is ${results.workingSetP95MiB.toFixed(1)} MiB and Private peak is ${results.privatePeakMiB.toFixed(1)} MiB. Cached Snapshot RPC had ${cached.timeouts}/${cached.attempts} timeouts and successful P95 ${cached.p95Ms?.toFixed(1)} ms.

| Criterion | Result | Actual |
|---|---:|---:|
${criteria.map((item) => `| ${item.criterion} | ${passLabel(item.pass)} | ${item.actual === undefined ? "—" : Number(item.actual).toFixed(2)}${item.timeouts === undefined ? "" : `; ${item.timeouts} timeouts`} |`).join("\n")}

## Resource Results

| Metric | Current | Baseline | Change |
|---|---:|---:|---:|
| Mail Core WS P95 | ${results.workingSetP95MiB.toFixed(1)} MiB | 421 MiB stable | ${report.comparison.workingSetP95VsStablePercent.toFixed(1)}% |
| Mail Core WS max | ${results.workingSetMaxMiB.toFixed(1)} MiB | 506 MiB peak | ${report.comparison.workingSetMaxVsPeakPercent.toFixed(1)}% |
| Mail Core Private P50 | ${results.privateP50MiB.toFixed(1)} MiB | 473 MiB stable | ${report.comparison.privateP50VsStablePercent.toFixed(1)}% |
| Mail Core Private max | ${results.privatePeakMiB.toFixed(1)} MiB | 534 MiB peak | ${report.comparison.privatePeakPercent.toFixed(1)}% |
| CPU average / P95 / max | ${results.cpuAveragePercent.toFixed(2)}% / ${results.cpuP95Percent.toFixed(2)}% / ${results.cpuMaxPercent.toFixed(2)}% | 2.1% stable | ${report.comparison.cpuAveragePercent.toFixed(1)}% average |
| Threads P50 / P95 / max | ${results.threadP50} / ${results.threadP95} / ${results.threadMax} | 32 | ${report.comparison.threadP50Percent.toFixed(1)}% P50 |
| Handles P50 / P95 / max | ${results.handleP50} / ${results.handleP95} / ${results.handleMax} | 719 | ${report.comparison.handleP50Percent.toFixed(1)}% P50 |

## Mail Open Latency

- Cached Snapshot: ${cached.successes}/${cached.attempts} succeeded; P50 ${cached.p50Ms?.toFixed(1)} ms, P95 ${cached.p95Ms?.toFixed(1)} ms, max ${cached.maxMs?.toFixed(1)} ms; ${cached.timeouts} timed out at the 1s client deadline.
- Uncached mail: metadata first screen ${acceptance.uncached?.metadataFirstScreenMs?.toFixed(1) ?? "n/a"} ms; body completion ${acceptance.uncached?.bodyCompletionMs?.toFixed(1) ?? "n/a"} ms; final state ${acceptance.uncached?.finalBodyState ?? "n/a"}.
- Mail list (50 rows): ${acceptance.listDurationMs.toFixed(1)} ms.

## Topology and Fault Acceptance

- DB Writer, IMAP, and AI runtimes were all \`ready\`; restart counts were zero.
- Legacy readers were absent and Background Worker was null; maintenance ran in the core runtime.
- AI health exposed \`${acceptance.health.intelligenceRuntime.circuitBreaker.state}\`, consecutive failures ${acceptance.health.intelligenceRuntime.circuitBreaker.consecutiveFailures}.
- Durable lease recovery, Outbox idempotency, IMAP credential-required behavior, and isolated AI/IMAP restart paths passed focused tests.
- The full server/renderer batch was not accepted as passing: it did not exit within 10 minutes while unrelated long-running test processes and parallel worktree edits were present.

## Bottleneck Analysis

The worker-count reduction lowered peak memory versus the original peak, but the Node utility process still shares a large RSS footprint across Worker Threads. Each worker heartbeat reported the same process-level RSS (about 260 MiB shortly after startup), while AI retained a 48 MiB heap and a queue depth of 10. During the 30-minute run, Mail Core climbed to roughly 462 MiB WS/464 MiB Private. The next optimization should target loaded module duplication and AI runtime residency, then profile the synchronous Snapshot query spikes that produced 1-second client timeouts.

## Artifacts

- \`workspace/reports/mail-core-three-worker-final.json\` — complete report and 360 raw samples
- \`workspace/reports/mail-core-three-worker-acceptance.json\` — runtime health and mail-open timings
- \`workspace/reports/mail-core-three-worker-trace.json\` — Chromium trace
- \`workspace/reports/mail-core-three-worker-trace-summary.json\` — aggregated hotspots
- \`workspace/reports/mail-core-three-worker-flamegraph.html\` — flamegraph-equivalent hotspot view
`;
await fs.writeFile(markdownPath, markdown, "utf8");
