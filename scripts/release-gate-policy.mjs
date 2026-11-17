/** Require the latest public CI gate. End-to-end and installer acceptance are separate. */
export function selectReleaseGate(pages, commit) {
  const gate = pages.flatMap((page) => page.check_runs ?? [])
    .filter((run) => run.name === "verification-gate" && run.app?.slug === "github-actions")
    .sort((a, b) => b.id - a.id)[0];
  if (!gate || gate.status !== "completed" || gate.conclusion !== "success") {
    throw new Error(`[ship] Latest GitHub Actions verification-gate is not successful for ${commit}.`);
  }
  const runId = /\/actions\/runs\/(\d+)(?:\/|$)/.exec(gate.details_url ?? "")?.[1];
  if (!runId) throw new Error("[ship] Could not identify the verification workflow run.");
  return runId;
}

export function assertFullCiRun(workflow, commit) {
  if (typeof workflow.path !== "string" || workflow.path.split("@", 1)[0] !== ".github/workflows/ci.yml" ||
      workflow.head_sha !== commit || !["push", "schedule", "workflow_dispatch"].includes(workflow.event)) {
    throw new Error("[ship] The gate must come from a public CI run for the current commit, not a pull request.");
  }
}
