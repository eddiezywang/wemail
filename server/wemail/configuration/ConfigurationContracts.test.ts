import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertValidConfigurationSnapshot,
  type ConfigurationTaskSnapshot,
} from "../../../shared/wemail/configuration.js";
import { ConfigurationFailureAdapter } from "./ConfigurationFailureAdapter.js";
import { sanitizeConfigurationDiagnostic } from "./ConfigurationDiagnostics.js";

function snapshot(
  overrides: Partial<ConfigurationTaskSnapshot> = {},
): ConfigurationTaskSnapshot {
  const now = "2026-07-29T12:00:00.000Z";
  return {
    id: "configuration-task-1",
    accountId: "account-1",
    kind: "automation_rule",
    targetKey: "daily-monitoring-report",
    operation: "create",
    title: "创建每日监控报告",
    status: "drafting",
    currentPhase: "collect_requirements",
    source: { surface: "agent", sourceId: "conversation-1" },
    steps: [],
    issues: [],
    recoveries: [],
    effects: [],
    references: [],
    revision: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

test("configuration snapshot accepts independent task, issue, and effect state", () => {
  assert.doesNotThrow(() => assertValidConfigurationSnapshot(snapshot()));
  assert.doesNotThrow(() =>
    assertValidConfigurationSnapshot(
      snapshot({
        status: "outcome_unknown",
        currentPhase: "verify_configuration",
        effects: [
          {
            id: "effect-1",
            phase: "commit_configuration",
            type: "external-connection-update",
            state: "unknown",
            summary: "外部连接提交结果待核查",
            createdAt: "2026-07-29T12:00:00.000Z",
            updatedAt: "2026-07-29T12:00:00.000Z",
          },
        ],
      }),
    ),
  );
});

test("configuration snapshot rejects contradictory terminal states", () => {
  assert.throws(
    () =>
      assertValidConfigurationSnapshot(
        snapshot({ status: "blocked", currentPhase: "check_prerequisites" }),
      ),
    /requires-blocking-issue/,
  );
  assert.throws(
    () =>
      assertValidConfigurationSnapshot(
        snapshot({
          status: "outcome_unknown",
          currentPhase: "verify_configuration",
        }),
      ),
    /requires-unknown-effect/,
  );
  assert.throws(
    () =>
      assertValidConfigurationSnapshot(
        snapshot({
          status: "completed",
          currentPhase: "verify_configuration",
          steps: [
            {
              id: "verify",
              phase: "verify_configuration",
              label: "验证配置",
              status: "failed",
            },
          ],
        }),
      ),
    /requires-verification/,
  );
});

test("raw wording cannot change a known missing dependency classification", () => {
  const adapter = new ConfigurationFailureAdapter();
  for (const error of [
    Object.assign(new Error("wecli binary not found on PATH: wecli"), {
      name: "WecliBinaryMissingError",
    }),
    { code: "wecli_binary_missing", error: "任意供应商文案" },
    { message: "wecli spawn failed (ENOENT)" },
  ]) {
    const result = adapter.failed({
      error,
      phase: "check_prerequisites",
      provider: "wecli",
    });
    assert.equal(result.status, "failed");
    assert.equal(result.issue.category, "dependency_unavailable");
    assert.equal(result.issue.code, "wecli_binary_missing");
    assert.equal(result.effectState, "none");
  }
});

test("unclassified error uses stable system semantics and metric", () => {
  const metrics: string[] = [];
  const adapter = new ConfigurationFailureAdapter(undefined, {
    increment(name) {
      metrics.push(name);
    },
  });
  const result = adapter.failed({
    error: new Error("供应商完全不同的随机错误文案"),
    phase: "discover_capabilities",
    provider: "custom",
  });
  assert.equal(result.status, "failed");
  assert.equal(result.issue.code, "provider_unclassified_failure");
  assert.equal(result.issue.category, "execution_failed");
  assert.deepEqual(metrics, ["configuration.issue.unclassified"]);
});

test("configuration diagnostics redact secrets and local paths", () => {
  assert.deepEqual(
    sanitizeConfigurationDiagnostic({
      command:
        "tool --token secret-value --file C:\\Users\\alice\\AppData\\Local\\Temp\\report.json",
      errorCode: "ENOENT",
    }),
    {
      command: "tool --token [REDACTED] --file [LOCAL_PATH]",
      errorCode: "ENOENT",
    },
  );
});
