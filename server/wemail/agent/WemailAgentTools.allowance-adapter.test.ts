import assert from "node:assert/strict";
import test from "node:test";
import {
  createWemailAgentTools,
  type WemailAgentToolDeps,
} from "./WemailAgentTools.js";
import type { AllowanceInvoicePort } from "./allowancePort.js";

// Round-8 suggestion 5: the automation tool descriptions' structured
// allowance-upload adapter clauses must resolve under the SAME contract as
// MailAgentTools' three allowance tools — effective capability =
// feature flag AND the per-composition service — instead of the global
// edition registration (`resolveAllowanceModules()`), which ignored both the
// feature flag and the composition's `allowanceModules` override.

const stubAllowance = {} as AllowanceInvoicePort;

const ALLOWANCE_UPLOAD_ACTION = {
  type: "external",
  adapter: "wecli.allowance.upload",
  input: { attachmentPolicy: "pdf" },
};

const CREATE_RULE_INPUT = {
  operation: "create",
  name: "Upload allowance invoices",
  trigger: { type: "mailReceived", execution: { type: "immediate" } },
  conditions: { hasAttachment: true },
  actions: [ALLOWANCE_UPLOAD_ACTION],
};

function allowanceDeps(overrides: Partial<WemailAgentToolDeps> = {}) {
  return {
    getActiveAccountId: () => "acct-1",
    pendingActions: {
      insert: () => {},
      getPending: () => [],
    },
    ...overrides,
  } as unknown as WemailAgentToolDeps;
}

function previewDescription(deps: WemailAgentToolDeps): string {
  return createWemailAgentTools(deps)
    .find((tool) => tool.name === "preview_automation_rule")!
    .description;
}

async function proposedDescription(deps: WemailAgentToolDeps): Promise<string> {
  const propose = createWemailAgentTools(deps)
    .find((tool) => tool.name === "propose_automation_rule_change")!;
  const result = await propose.handler(CREATE_RULE_INPUT, {}) as {
    ok: boolean;
    pendingAction: { description: string };
  };
  assert.equal(result.ok, true);
  return result.pendingAction.description;
}

test("flag on + service present exposes the structured allowance adapter clauses", async () => {
  const deps = allowanceDeps({ allowanceToolsEnabled: true, allowance: stubAllowance });
  assert.match(previewDescription(deps), / plus structured wecli allowance upload\./);
  assert.match(await proposedDescription(deps), /通过 wecli 上传 PDF附件到月度发票平台/);
});

test("flag on without the per-composition service keeps the generic text", async () => {
  const deps = allowanceDeps({ allowanceToolsEnabled: true });
  assert.doesNotMatch(previewDescription(deps), /structured wecli allowance upload/);
  assert.match(await proposedDescription(deps), /；动作：external/);
});

test("flag off ignores the service presence (override divergence pins to the flag)", async () => {
  // The service exists in this composition (e.g. assembled from an override
  // module) while the edition feature flag is off — the adapter clauses must
  // stay hidden instead of falling back to service/global presence.
  const deps = allowanceDeps({ allowanceToolsEnabled: false, allowance: stubAllowance });
  assert.doesNotMatch(previewDescription(deps), /structured wecli allowance upload/);
  assert.match(await proposedDescription(deps), /；动作：external/);
});

test("flag off without a service keeps the generic text", async () => {
  const deps = allowanceDeps({ allowanceToolsEnabled: false });
  assert.doesNotMatch(previewDescription(deps), /structured wecli allowance upload/);
  assert.match(await proposedDescription(deps), /；动作：external/);
});
