import assert from "node:assert/strict";
import test from "node:test";
import { assertFullCiRun, selectReleaseGate } from "../../scripts/release-gate-policy.mjs";

test("release gate uses the latest GitHub Actions check across pages", () => {
  const check = { name: "verification-gate", app: { slug: "github-actions" }, status: "completed", conclusion: "success", details_url: "https://github.com/example/repo/actions/runs/123/job/456" };
  assert.equal(selectReleaseGate([{ check_runs: [{ ...check, id: 1 }] }, { check_runs: [{ ...check, id: 2 }] }], "abc"), "123");
  assert.throws(() => selectReleaseGate([{ check_runs: [{ ...check, id: 1 }, { ...check, id: 2, conclusion: "failure" }] }], "abc"), /not successful/);
  assert.throws(() => selectReleaseGate([{ check_runs: [{ ...check, id: 1, app: { slug: "other" } }] }], "abc"), /not successful/);
  assert.throws(() => selectReleaseGate([{ check_runs: [{ ...check, id: 1, details_url: null }] }], "abc"), /identify/);
});

test("release gate requires the expected full workflow for the exact commit", () => {
  const workflow = { path: ".github/workflows/ci.yml@refs/heads/main", head_sha: "abc", event: "push" };
  assert.doesNotThrow(() => assertFullCiRun(workflow, "abc"));
  for (const change of [{ event: "pull_request" }, { head_sha: "other" }, { path: ".github/workflows/other.yml" }, { path: null }]) {
    assert.throws(() => assertFullCiRun({ ...workflow, ...change }, "abc"), /full CI run/);
  }
});
