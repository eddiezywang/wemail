/**
 * P2.5 regression pins for the wecli_* agent tools.
 *
 * The tool *mechanism* stays in the open tree, but registration is gated on
 * `features.wecli && modules.wecli`. The open edition passes neither, so
 * `listTools()` must never contain a wecli entry — an edition build flips the
 * gate and gets the same five tools back.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createMailAgentTools, type MailAgentToolDeps } from "./MailAgentTools.js";
import { OPEN_WECLI_CLASSIFIER, OPEN_WECLI_TOKENIZER } from "../skills/wecliPort.js";

const WECLI_TOOL_NAMES = [
  "wecli_query",
  "wecli_help",
  "wecli_run",
  "propose_wecli_command",
  "wecli_action_preview",
];

function baseDeps(): Record<string, unknown> {
  return {
    mailDatabase: {},
    intelligenceService: {},
    wecli: { async run() { throw new Error("must not run in the open edition"); } },
    classify: OPEN_WECLI_CLASSIFIER,
    tokenize: OPEN_WECLI_TOKENIZER,
  };
}

test("the open edition registers no wecli_* agent tool", () => {
  const tools = createMailAgentTools(baseDeps() as unknown as MailAgentToolDeps);
  const names = tools.map((tool) => tool.name);
  for (const name of WECLI_TOOL_NAMES) {
    assert.equal(names.includes(name), false, `${name} must not register in the open edition`);
  }
});

test("an install_wecli pending action is never created without an edition install request", () => {
  // createWecliInstallPendingAction short-circuits when `wecliInstallRequest`
  // is absent, so even a binary-missing failure cannot propose an install.
  const tools = createMailAgentTools(baseDeps() as unknown as MailAgentToolDeps);
  assert.equal(tools.some((tool) => tool.name === "install_wecli"), false);
});

test("an edition build with the feature and module on gets the wecli tools back", () => {
  const tools = createMailAgentTools({
    ...baseDeps(),
    wecliToolsEnabled: true,
    wecliInstallRequest: {
      command: "npm install -g example-wecli --registry=https://registry.example.com",
      packageName: "example-wecli",
      registry: "https://registry.example.com",
      networkRequirement: "corp",
    },
  } as unknown as MailAgentToolDeps);
  const names = tools.map((tool) => tool.name);
  for (const name of WECLI_TOOL_NAMES) {
    assert.equal(names.includes(name), true, `${name} must register when the edition enables wecli`);
  }
});

test("the module gate alone is not enough — the feature flag must be on too", () => {
  // composeAgent computes wecliToolsEnabled = features.wecli && modules.wecli,
  // so a module without the advertised feature still registers nothing.
  const tools = createMailAgentTools({
    ...baseDeps(),
    wecliToolsEnabled: false,
  } as unknown as MailAgentToolDeps);
  const names = tools.map((tool) => tool.name);
  for (const name of WECLI_TOOL_NAMES) assert.equal(names.includes(name), false);
});
