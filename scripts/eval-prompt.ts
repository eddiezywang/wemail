#!/usr/bin/env -S node --import tsx
/**
 * Prompt-polish CLI.
 *
 *   node --import tsx scripts/eval-prompt.ts \
 *     --feature summary --version baseline \
 *     [--samples a,b,c] [--concurrency 4] [--baseline path-to-baseline.json]
 *
 * Reads the LLM endpoint from env (with sensible defaults for the
 * local sub2agent / glm-5.1 dev rig):
 *   WEMAIL_LLM_BASE_URL  default http://127.0.0.1:8989/v1
 *   WEMAIL_LLM_API_KEY   default sub2agent
 *   WEMAIL_LLM_MODEL     default glm-5.1
 *   WEMAIL_JUDGE_MODEL   default <same as WEMAIL_LLM_MODEL>
 *
 * Output:
 *   eval-reports/<feature>/<version>.json    (raw, gitignored)
 *   eval-reports/<feature>/<version>.md      (summary, committed)
 *   eval-reports/<feature>/diff-...md        (when --baseline given)
 */

import { argv, exit, env } from "node:process";

import * as path from "node:path";
import { createOpenAiCompatibleClient } from "../server/wemail/ai/OpenAiCompatibleClient.js";
import { mailSamples } from "../server/wemail/testing/mailSamples.js";
import { runPromptEval } from "../server/wemail/intelligence/eval/PromptEvalHarness.js";
import { FeatureRegistry } from "../server/wemail/intelligence/eval/FeatureRegistry.js";
import {
  loadManifest,
  readCorpusSample,
  validateManifestAgainstSources,
  type SampleManifest,
} from "../server/wemail/intelligence/eval/corpus/SampleManifest.js";
import { checkCorpusResidualScanGate } from "../server/wemail/intelligence/eval/corpus/PiiGate.js";
import {
  curatorSafetyScenarios,
  piPlannerScenarios,
} from "../server/wemail/intelligence/eval/corpus/plannerScenarios.js";
import { runAgentRuntimeEval } from "../server/wemail/intelligence/eval/runtime/AgentRuntimeHarness.js";
import type { MailSampleEntry } from "../server/wemail/testing/mailSamples.js";
import {
  loadReport,
  writeDiff,
  writeReport,
  type PromptEvalReport,
} from "../server/wemail/intelligence/eval/scoring/PolishReport.js";

interface CliArgs {
  feature: string;
  version: string;
  sampleIds: string[] | undefined;
  concurrency: number;
  baselinePath: string | undefined;
  manifestPath: string | undefined;
  allowExternalCorpus: boolean;
}

function parseArgs(args: string[]): CliArgs {
  const out: Partial<CliArgs> = { concurrency: 4, allowExternalCorpus: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--feature") out.feature = args[++i] as string;
    else if (a === "--version") out.version = args[++i] as string;
    else if (a === "--samples")
      out.sampleIds = (args[++i] as string).split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--concurrency") out.concurrency = Number(args[++i]);
    else if (a === "--baseline") out.baselinePath = args[++i] as string;
    else if (a === "--manifest") out.manifestPath = args[++i] as string;
    else if (a === "--allow-external-corpus") out.allowExternalCorpus = true;
    else if (a === "--help" || a === "-h") {
      printHelp();
      exit(0);
    } else if (a) {
      console.error(`unknown arg: ${a}`);
      printHelp();
      exit(2);
    }
  }
  if (!out.feature) {
    console.error("--feature is required (summary | tags | replyDraft | piPlanner | curatorSafety)");
    exit(2);
  }
  if (!out.version) {
    console.error("--version is required (e.g. baseline, v2)");
    exit(2);
  }
  return out as CliArgs;
}

function printHelp(): void {
  // eslint-disable-next-line no-console
  console.log(
    [
      "Usage: node --import tsx scripts/eval-prompt.ts [opts]",
      "",
      "  --feature <summary|tags|replyDraft>   required",
      "  --version <label>                      required (e.g. baseline, v2)",
      "  --samples <id1,id2,...>                optional, default = all 30",
      "  --concurrency <n>                      default 4",
      "  --baseline <path-to-baseline.json>    optional; prints diff vs that report",
      "  --manifest <path-to-manifest.json>     optional; immutable sample manifest for per-stratum acceptance",
      "  --allow-external-corpus                bypass residual-scan gate for remote corpus evals",
      "",
      "Env:",
      "  WEMAIL_LLM_BASE_URL    default http://127.0.0.1:8989/v1   (executor)",
      "  WEMAIL_LLM_API_KEY     default sub2agent                  (executor)",
      "  WEMAIL_LLM_MODEL       default glm-5.1                    (executor)",
      "  WEMAIL_JUDGE_BASE_URL  default <same as executor>         (judge)",
      "  WEMAIL_JUDGE_API_KEY   default <same as executor>         (judge)",
      "  WEMAIL_JUDGE_MODEL     default <same as model>            (judge)",
    ].join("\n"),
  );
}

async function main(): Promise<void> {
  const cli = parseArgs(argv.slice(2));

  const baseUrl = env.WEMAIL_LLM_BASE_URL ?? "http://127.0.0.1:8989/v1";
  const apiKey = env.WEMAIL_LLM_API_KEY ?? "sub2agent";
  const model = env.WEMAIL_LLM_MODEL ?? "glm-5.1";

  // Phase 3: judge can run on a separate endpoint+model. When the
  // judge env vars are unset, fall back to the executor (self-judge)
  // and stamp the report so reviewers can see the bias risk.
  const judgeBaseUrl = env.WEMAIL_JUDGE_BASE_URL ?? baseUrl;
  const judgeApiKey = env.WEMAIL_JUDGE_API_KEY ?? apiKey;
  const judgeModel = env.WEMAIL_JUDGE_MODEL ?? model;
  const selfJudge =
    judgeBaseUrl === baseUrl &&
    judgeApiKey === apiKey &&
    judgeModel === model;

  const llm = createOpenAiCompatibleClient({
    baseUrl,
    apiKey,
    defaultModel: model,
    timeoutMs: 60_000,
  });
  const judge = createOpenAiCompatibleClient({
    baseUrl: judgeBaseUrl,
    apiKey: judgeApiKey,
    defaultModel: judgeModel,
    timeoutMs: 90_000,
  });

  if (selfJudge) {
    console.log(
      "[eval] ⚠️ judge falls back to self-judge (executor==judge); set WEMAIL_JUDGE_BASE_URL+_API_KEY+_MODEL for an external grader",
    );
  } else {
    console.log(
      `[eval] judge: ${judgeModel} @ ${judgeBaseUrl} (executor: ${model} @ ${baseUrl})`,
    );
  }

  // Manifest takes priority — it freezes which samples are eligible
  // and lets the harness produce per-stratum acceptance.
  let manifest: SampleManifest | undefined;
  let corpusSafety:
    | {
        externalEndpoint: boolean;
        externalCorpusWaived: boolean;
        residualScanRequired: boolean;
      }
    | undefined;
  let samples = cli.sampleIds
    ? mailSamples.filter((s) => cli.sampleIds!.includes(s.id))
    : [...mailSamples];

  if (cli.manifestPath) {
    manifest = loadManifest(cli.manifestPath);
    const fxMap = new Map(mailSamples.map((s) => [s.id, s] as const));
    const corpusDir =
      env.WEMAIL_CORPUS_DIR ?? path.join(process.cwd(), "corpus");
    const manifestHasCorpus = manifest.samples.some((m) => m.source === "corpus");

    // Validate every entry hash matches what's currently on disk —
    // crucial for both fixture and corpus sources so a baseline diff
    // can be trusted. Pass corpusDir whenever the manifest references
    // corpus samples (Codex review: bug fix).
    const validation = validateManifestAgainstSources(manifest, {
      fixtures: fxMap,
      corpusDir: manifestHasCorpus ? corpusDir : undefined,
    });
    if (!validation.ok) {
      console.error(
        `[eval] manifest validation failed:\n${validation.mismatches
          .map((m) => `  - ${m.id}: ${m.reason}`)
          .join("\n")}`,
      );
      exit(2);
    }

    // Phase 4 fail-closed gate: whenever a corpus sample would be sent
    // to any non-loopback executor or judge endpoint, require
    // `_meta.residualScanPassed=true`. This deliberately does not key
    // off selfJudge: executor==judge can still be a remote provider.
    const piiGate = checkCorpusResidualScanGate({
      manifest,
      corpusDir,
      endpointBaseUrls: [baseUrl, judgeBaseUrl],
      allowExternalCorpus: cli.allowExternalCorpus,
    });
    corpusSafety = {
      externalEndpoint: piiGate.externalEndpoint,
      externalCorpusWaived: piiGate.externalCorpusWaived,
      residualScanRequired:
        manifestHasCorpus && piiGate.externalEndpoint && !piiGate.externalCorpusWaived,
    };
    if (!piiGate.ok) {
      console.error(
        `[eval] PII fail-closed gate: refusing to send corpus samples to remote endpoint(s): ${[
          baseUrl,
          judgeBaseUrl,
        ].join(", ")}.\n` +
          `Pass --allow-external-corpus or fix:\n${piiGate.failed
            .map((f) => `  - ${f}`)
            .join("\n")}`,
      );
      exit(2);
    }
    if (piiGate.externalCorpusWaived) {
      console.warn(
        "[eval] WARNING: --allow-external-corpus bypassed the residual-scan gate for remote corpus samples",
      );
    }

    // Load BOTH fixtures + corpus samples in the order they appear in
    // the manifest so per-stratum aggregation has the full picture.
    samples = manifest.samples
      .map((entry): MailSampleEntry | null => {
        if (entry.source === "fixtures") {
          return fxMap.get(entry.id) ?? null;
        }
        const filePath = path.join(corpusDir, `${entry.id}.json`);
        try {
          return readCorpusSample(filePath);
        } catch (err) {
          console.error(
            `[eval] failed to load corpus sample ${entry.id} from ${filePath}: ${(err as Error).message}`,
          );
          return null;
        }
      })
      .filter((s): s is MailSampleEntry => s !== null);
    if (samples.length !== manifest.samples.length) {
      console.error(
        `[eval] manifest references ${manifest.samples.length} samples but only ${samples.length} were loaded`,
      );
      exit(2);
    }

    // `--samples` is allowed *with* `--manifest` for debug runs that
    // poke a single id without taking the manifest off the run record.
    // Validate against the manifest set (not the global mailSamples) so
    // a typo still trips, and narrow `samples` to the requested subset.
    if (cli.sampleIds) {
      const manifestIds = new Set(samples.map((s) => s.id));
      const missing = cli.sampleIds.filter((id) => !manifestIds.has(id));
      if (missing.length > 0) {
        console.error(
          `[eval] --samples ids not in manifest '${manifest.id}': ${missing.join(", ")}`,
        );
        exit(2);
      }
      const requested = new Set(cli.sampleIds);
      samples = samples.filter((s) => requested.has(s.id));
    }
  }

  // Load the registry once with plugins enabled — Codex review fixed
  // a bug where the harness's internal default skipped plugins for
  // every CLI run, so an allowlisted external feature would resolve
  // to "unknown feature".
  const registry = await FeatureRegistry.loadDefault();
  const plugins = registry.loadedPlugins();
  if (plugins.length > 0) {
    console.log(
      `[eval] loaded ${plugins.length} plugin(s): ${plugins
        .map((p) => `${p.packageName}@${p.packageVersion}`)
        .join(", ")}`,
    );
  }
  const spec = registry.getEntry(cli.feature)?.spec;
  if (!spec) {
    console.error(
      `[eval] unknown feature '${cli.feature}'. Registered: ${registry
        .listIds()
        .join(", ")}`,
    );
    exit(2);
  }

  let report: PromptEvalReport;
  if (spec.kind === "single-turn") {
    if (cli.sampleIds && samples.length !== cli.sampleIds.length) {
      const found = new Set(samples.map((s) => s.id));
      const missing = cli.sampleIds.filter((id) => !found.has(id));
      console.error(`unknown sample ids: ${missing.join(", ")}`);
      exit(2);
    }
    // eslint-disable-next-line no-console
    console.log(
      `[eval] feature=${cli.feature} version=${cli.version} samples=${samples.length} model=${model} judge=${judgeModel}`,
    );
    report = await runPromptEval({
      feature: cli.feature,
      versionLabel: cli.version,
      llm,
      judge,
      model,
      judgeModel,
      endpoint: baseUrl,
      samples,
      concurrency: cli.concurrency,
      totalTimeoutMs: 5 * 60 * 1000,
      manifest,
      registry,
      judgeIdentity: {
        model: judgeModel,
        baseUrl: judgeBaseUrl,
        selfJudge,
      },
      corpusSafety,
      onProgress: (p) => {
        // eslint-disable-next-line no-console
        console.log(`  [${p.done}/${p.total}] ${p.sampleId} → ${p.weighted}`);
      },
    });
  } else {
    if (manifest) {
      console.error("--manifest is only supported for single-turn corpus evals");
      exit(2);
    }
    // Scope `--samples` to the chosen feature's scenario set so an id
    // intended for the other agent eval (e.g. `curator-injection-*` under
    // piPlanner) doesn't get smuggled in and produce a meaningless score.
    let scenarioPool: typeof piPlannerScenarios | undefined;
    if (cli.feature === "piPlanner") scenarioPool = piPlannerScenarios;
    else if (cli.feature === "curatorSafety") scenarioPool = curatorSafetyScenarios;
    if (cli.sampleIds && !scenarioPool) {
      console.error(
        `--samples is only supported for built-in agent features (piPlanner, curatorSafety); '${cli.feature}' has no built-in scenario set`,
      );
      exit(2);
    }
    const scenarios = cli.sampleIds
      ? scenarioPool!.filter((s) => cli.sampleIds!.includes(s.id))
      : undefined;
    if (cli.sampleIds && scenarios!.length !== cli.sampleIds.length) {
      const found = new Set(scenarios!.map((s) => s.id));
      const missing = cli.sampleIds.filter((id) => !found.has(id));
      console.error(
        `unknown scenario ids for feature '${cli.feature}': ${missing.join(", ")}`,
      );
      exit(2);
    }
    // eslint-disable-next-line no-console
    console.log(
      `[eval] feature=${cli.feature} version=${cli.version} scenarios=${scenarios?.length ?? "default"} model=${model} judge=${judgeModel}`,
    );
    report = await runAgentRuntimeEval({
      feature: cli.feature,
      versionLabel: cli.version,
      llm,
      judge,
      model,
      judgeModel,
      endpoint: baseUrl,
      scenarios,
      concurrency: cli.concurrency,
      registry,
      judgeIdentity: {
        model: judgeModel,
        baseUrl: judgeBaseUrl,
        selfJudge,
      },
      onProgress: (p) => {
        // eslint-disable-next-line no-console
        console.log(`  [${p.done}/${p.total}] ${p.sampleId} → ${p.weighted}`);
      },
    });
  }

  const reportsRoot = path.resolve(process.cwd(), "eval-reports");
  const { jsonPath, mdPath } = writeReport(report, reportsRoot);
  // eslint-disable-next-line no-console
  console.log(`\n[eval] avg weighted: ${report.aggregate.avgWeighted} / 12`);
  // eslint-disable-next-line no-console
  console.log(`[eval] format pass: ${(report.aggregate.formatPassRate * 100).toFixed(0)}%`);
  // eslint-disable-next-line no-console
  console.log(`[eval] safety min: ${report.aggregate.safetyMin}/3`);
  // eslint-disable-next-line no-console
  console.log(`[eval] wrote ${jsonPath}`);
  // eslint-disable-next-line no-console
  console.log(`[eval] wrote ${mdPath}`);

  if (cli.baselinePath) {
    let baseline: PromptEvalReport;
    try {
      baseline = loadReport(cli.baselinePath);
    } catch (err) {
      console.error(`failed to load --baseline ${cli.baselinePath}: ${(err as Error).message}`);
      exit(2);
      return;
    }
    const { diffPath, stratumPath } = writeDiff(baseline, report, reportsRoot);
    const delta = report.aggregate.avgWeighted - baseline.aggregate.avgWeighted;
    const sign = delta >= 0 ? "+" : "";
    // eslint-disable-next-line no-console
    console.log(
      `[eval] vs baseline ${baseline.versionLabel}: Δ ${sign}${delta.toFixed(1)} → ${diffPath}`,
    );
    if (stratumPath) {
      // eslint-disable-next-line no-console
      console.log(`[eval] per-stratum acceptance → ${stratumPath}`);
    }
  }
}

main().catch((err) => {
  console.error("[eval] unhandled error:", err);
  exit(1);
});
