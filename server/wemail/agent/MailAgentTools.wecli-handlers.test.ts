/**
 * Handler-level regressions for the edition-gated wecli_* / invoice tools.
 *
 * Restores the assertions lost when the original
 * `MailAgentTools.wecli.test.ts` moved to the internal overlay (P2.5) and
 * started driving the runtime/classifier directly: these tests call the REAL
 * `createMailAgentTools` handlers through a stub wecli bundle (shaped after
 * the `wecliPort` slots), pinning the tool-boundary behavior codex flagged:
 *   - the four wecli tools forward the caller's cancellation signal;
 *   - a non-zero exit maps to `wecli_command_failed` (never a success);
 *   - a timeout maps to the terminal `wecli_timeout` failure;
 *   - binary-missing spawns build the install_wecli pending action — and the
 *     repository write + command parameters are verified for both the
 *     install-request-present and install-request-absent branches;
 *   - invoice uploads exclude already-processed attachments and disclose
 *     unverified retries; discovery scopes to the focused mail only when
 *     asked.
 *
 * Adapted to the post-P2.6 signatures:
 *   - error identity is the structural `code` string ("wecli-timeout",
 *     "wecli-binary-missing", "wecli-spawn" + ENOENT), not an internal class;
 *   - wecli tools require `wecliToolsEnabled`, invoice tools require
 *     `allowanceToolsEnabled` + an `allowance` port (the gate pins themselves
 *     live in `MailAgentTools.wecli-tools.test.ts`);
 *   - the open classifier only auto-approves bare read-only verbs, so the
 *     run-path tests use an auto-approving classifier stub.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { AgentTerminalToolError } from "./AgentRuntime.js";
import { createMailAgentTools, type MailAgentToolDeps } from "./MailAgentTools.js";
import type { AgentPendingActionRepository } from "./AgentPendingActionRepository.js";
import {
  OPEN_WECLI_TOKENIZER,
  WECLI_ERROR_CODES,
} from "../skills/wecliPort.js";
import type { ActionExecutionCommand } from "../../../shared/wemail/actionExecution.js";
import type {
  WecliCommandClassification,
  WecliRunResult,
} from "../../../shared/wemail/wecliTypes.js";

// ── stubs ──────────────────────────────────────────────────────────────

function autoApproveAll(command: string): WecliCommandClassification {
  const subcommand = command.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  return {
    kind: "auto-approved",
    command: "wecli",
    subcommand,
    reason: "test stub auto-approves every command",
  };
}

class StubPendingActionRepository {
  readonly inserted: Array<Record<string, unknown>> = [];
  pending: Array<Record<string, unknown>> = [];

  insert(action: Record<string, unknown>): void {
    this.inserted.push(action);
  }

  getPending(): Array<Record<string, unknown>> {
    return this.pending;
  }
}

interface BundleOverrides {
  run?: (
    command: string,
    options?: { signal?: AbortSignal; approvedBy?: string },
  ) => Promise<Partial<WecliRunResult> & Pick<WecliRunResult, "exitCode">>;
  pendingActionRepo?: StubPendingActionRepository;
  wecliInstallRequest?: {
    command: string;
    packageName: string;
    registry: string;
    networkRequirement: string;
  };
  classifier?: (command: string) => WecliCommandClassification;
}

/** Stub wecli bundle shaped after the `wecliPort` slots, gate turned on. */
function wecliBundleDeps(overrides: BundleOverrides = {}): MailAgentToolDeps {
  return {
    mailDatabase: {},
    intelligenceService: {},
    wecli: {
      async run(
        command: string,
        options: { signal?: AbortSignal; approvedBy?: string } | undefined,
      ) {
        if (!overrides.run) throw new Error("stub run not configured");
        return (await overrides.run(command, options)) as WecliRunResult;
      },
    },
    classify: overrides.classifier ?? autoApproveAll,
    tokenize: OPEN_WECLI_TOKENIZER,
    ...(overrides.pendingActionRepo
      ? { pendingActionRepo: overrides.pendingActionRepo as unknown as AgentPendingActionRepository }
      : {}),
    ...(overrides.wecliInstallRequest
      ? { wecliInstallRequest: overrides.wecliInstallRequest }
      : {}),
    wecliToolsEnabled: true,
  } as unknown as MailAgentToolDeps;
}

function errorWithCode(code: string, extra: Record<string, unknown> = {}): Error {
  const err = new Error(`stub failure: ${code}`);
  Object.assign(err, { code, ...extra });
  return err;
}

const INSTALL_REQUEST = {
  command: "npm install -g example-wecli --registry=https://registry.example.com",
  packageName: "example-wecli",
  registry: "https://registry.example.com",
  networkRequirement: "corp",
};

/** `install_wecli` row as persisted by the repository (for the reuse path). */
function persistedInstallRow(
  request: typeof INSTALL_REQUEST,
): Record<string, unknown> {
  return {
    id: "pending-existing",
    conversation_id: "session-1",
    action_type: "install_wecli",
    description: "安装可选组件 WeCLI",
    email_id: null,
    input_json: JSON.stringify({
      command: request.command,
      package: request.packageName,
      registry: request.registry,
      networkRequirement: request.networkRequirement,
    }),
    risk_reason: "该操作会通过企业内网源全局安装 npm 包。",
    risk_level: "high",
    status: "pending",
    created_at: "2026-01-01T00:00:00.000Z",
    resolved_at: null,
  };
}

async function catchTerminal(promise: Promise<unknown>): Promise<AgentTerminalToolError> {
  try {
    await promise;
  } catch (err) {
    return err as AgentTerminalToolError;
  }
  assert.fail("expected the tool handler to reject");
}

// ── cancellation + failure mapping ─────────────────────────────────────

for (const name of ["wecli_query", "wecli_run", "propose_wecli_command", "wecli_help"]) {
  test(`${name} propagates the cancellation signal and maps a non-zero exit to wecli_command_failed`, async () => {
    const controller = new AbortController();
    const calls: Array<{ command: string; options?: { signal?: AbortSignal; approvedBy?: string } }> = [];
    const tools = createMailAgentTools(
      wecliBundleDeps({
        run: async (command, options) => {
          calls.push({ command, options });
          return { exitCode: 1, stdout: "", stderr: "" };
        },
      }),
    );
    const tool = tools.find((item) => item.name === name);
    assert.ok(tool, `${name} must register when the edition gate is on`);
    const input = name === "wecli_help" ? { site: "allowance" } : { command: "ls" };
    const err = await catchTerminal(tool.handler(input, { sessionId: "session-1", signal: controller.signal }));

    assert.ok(err instanceof AgentTerminalToolError);
    assert.equal(err.code, "wecli_command_failed");
    assert.match(err.userMessage, /平台命令执行失败/);
    assert.equal(err.pendingAction, undefined);
    assert.equal(calls.length, 1, "the runtime must be invoked exactly once");
    assert.equal(calls[0]!.options?.signal, controller.signal, "the caller's cancellation signal must reach the runtime");
    const expectedApprovedBy = name === "wecli_help"
      ? "agent:help"
      : name === "wecli_query"
        ? undefined
        : "agent:readonly";
    assert.equal(calls[0]!.options?.approvedBy, expectedApprovedBy);
    if (name === "wecli_help") {
      assert.equal(calls[0]!.command, "allowance --help");
    } else {
      assert.equal(calls[0]!.command, "ls");
    }
  });
}

test("a wecli timeout maps to the terminal wecli_timeout failure", async () => {
  const tools = createMailAgentTools(
    wecliBundleDeps({
      run: () => {
        throw errorWithCode(WECLI_ERROR_CODES.timeout, { timeoutMs: 30_000 });
      },
    }),
  );
  const tool = tools.find((item) => item.name === "wecli_query")!;
  const err = await catchTerminal(tool.handler({ command: "ls" }, {}));
  assert.ok(err instanceof AgentTerminalToolError);
  assert.equal(err.code, "wecli_timeout");
  assert.match(err.userMessage, /未在截止时间内返回结果/);
  assert.equal(err.pendingAction, undefined);
});

// ── binary-missing recovery: install-request branch ─────────────────────

test("binary-missing builds an install pending action and writes it to the repository when an install request exists", async () => {
  const repo = new StubPendingActionRepository();
  const tools = createMailAgentTools(
    wecliBundleDeps({
      run: () => {
        throw errorWithCode(WECLI_ERROR_CODES.binaryMissing);
      },
      pendingActionRepo: repo,
      wecliInstallRequest: INSTALL_REQUEST,
    }),
  );
  const tool = tools.find((item) => item.name === "wecli_query")!;
  const err = await catchTerminal(tool.handler({ command: "ls" }, { sessionId: "session-1" }));

  assert.ok(err instanceof AgentTerminalToolError);
  assert.equal(err.code, "wecli_binary_missing");
  const pendingAction = err.pendingAction;
  assert.ok(pendingAction, "the install recovery must carry a pending action");
  assert.equal(pendingAction.actionType, "install_wecli");
  assert.equal(pendingAction.toolName, "install_wecli");
  assert.deepEqual(pendingAction.parameters, {
    command: INSTALL_REQUEST.command,
    package: INSTALL_REQUEST.packageName,
    registry: INSTALL_REQUEST.registry,
    networkRequirement: INSTALL_REQUEST.networkRequirement,
  });
  assert.match(pendingAction.riskReason, /企业内网/);

  // Repository write carries the same descriptor.
  assert.equal(repo.inserted.length, 1);
  const inserted = repo.inserted[0]!;
  assert.equal(inserted.actionType, "install_wecli");
  assert.deepEqual(JSON.parse(String(inserted.inputJson)), {
    command: INSTALL_REQUEST.command,
    package: INSTALL_REQUEST.packageName,
    registry: INSTALL_REQUEST.registry,
    networkRequirement: INSTALL_REQUEST.networkRequirement,
  });

  // A second failure reuses the persisted action instead of inserting again.
  repo.pending = [persistedInstallRow(INSTALL_REQUEST)];
  const err2 = await catchTerminal(tool.handler({ command: "ls" }, { sessionId: "session-1" }));
  assert.equal(err2.pendingAction?.id, "pending-existing");
  assert.equal(repo.inserted.length, 1, "the reuse path must not write another row");
});

test("binary-missing creates no pending action and writes nothing without an install request", async () => {
  const repo = new StubPendingActionRepository();
  const tools = createMailAgentTools(
    wecliBundleDeps({
      run: () => {
        throw errorWithCode(WECLI_ERROR_CODES.binaryMissing);
      },
      pendingActionRepo: repo,
    }),
  );
  const tool = tools.find((item) => item.name === "wecli_query")!;
  const err = await catchTerminal(tool.handler({ command: "ls" }, { sessionId: "session-1" }));

  assert.ok(err instanceof AgentTerminalToolError);
  assert.equal(err.code, "wecli_binary_missing");
  assert.equal(
    err.pendingAction,
    undefined,
    "no install descriptor means no install proposal",
  );
  assert.equal(repo.inserted.length, 0, "the repository must not be written");
});

test("an ENOENT spawn failure is binary-missing recovery; other spawn failures are not", async () => {
  // ENOENT goes through the same install recovery as an explicit
  // binary-missing error.
  const repo = new StubPendingActionRepository();
  const enoentTools = createMailAgentTools(
    wecliBundleDeps({
      run: () => {
        throw errorWithCode(WECLI_ERROR_CODES.spawn, {
          binary: "wecli",
          errorCode: "ENOENT",
          args: ["ls"],
        });
      },
      pendingActionRepo: repo,
      wecliInstallRequest: INSTALL_REQUEST,
    }),
  );
  const enoentTool = enoentTools.find((item) => item.name === "wecli_query")!;
  const err = await catchTerminal(enoentTool.handler({ command: "ls" }, { sessionId: "session-1" }));
  assert.ok(err instanceof AgentTerminalToolError);
  assert.equal(err.code, "wecli_binary_missing");
  assert.equal(err.pendingAction?.actionType, "install_wecli");
  assert.equal(repo.inserted.length, 1);

  // A permission failure is not "binary missing": the raw spawn error
  // propagates unchanged and nothing is written.
  const deniedRepo = new StubPendingActionRepository();
  const deniedTools = createMailAgentTools(
    wecliBundleDeps({
      run: () => {
        throw errorWithCode(WECLI_ERROR_CODES.spawn, {
          binary: "wecli",
          errorCode: "EACCES",
        });
      },
      pendingActionRepo: deniedRepo,
      wecliInstallRequest: INSTALL_REQUEST,
    }),
  );
  const deniedTool = deniedTools.find((item) => item.name === "wecli_query")!;
  const denied = await catchTerminal(deniedTool.handler({ command: "ls" }, { sessionId: "session-1" }));
  assert.equal(denied instanceof AgentTerminalToolError, false);
  assert.equal((denied as NodeJS.ErrnoException).code, WECLI_ERROR_CODES.spawn);
  assert.equal(deniedRepo.inserted.length, 0);
});

// ── invoice preflight exclusions + retry disclosure ─────────────────────

interface InvoiceDeps {
  preflightCommands: ActionExecutionCommand[];
  deps: MailAgentToolDeps;
}

function invoiceDeps(
  reasonByAttachment: Record<string, string | null>,
): InvoiceDeps {
  const preflightCommands: ActionExecutionCommand[] = [];
  const deps = {
    mailDatabase: {
      async actionExecution(command: ActionExecutionCommand) {
        assert.equal(command.op, "preflight");
        if (command.op !== "preflight") throw new Error("unexpected command");
        assert.equal(command.accountId, "account-1");
        preflightCommands.push(command);
        return {
          eligibility: command.items.map((item) => ({
            ...item,
            reason: reasonByAttachment[item.attachmentId] ?? null,
          })),
        };
      },
    },
    getActiveAccountId: () => "account-1",
    allowance: {
      async findInvoiceAttachments() {
        return { ok: true, count: 0, candidates: [], messages: [], mailCount: 0, hasMore: false };
      },
    },
    allowanceToolsEnabled: true,
  } as unknown as MailAgentToolDeps;
  return { preflightCommands, deps };
}

const UPLOAD_CTX = { sessionId: "session-1", runContext: { accountId: "account-1" } };

for (const hasNewItem of [false, true]) {
  test(`upload proposal excludes processed attachments; new attachment present: ${hasNewItem}`, async () => {
    const blocked = { emailId: "mail-1", attachmentId: "att-1", filename: "old.pdf" };
    const fresh = { emailId: "mail-2", attachmentId: "att-2", filename: "new.pdf" };
    const items = hasNewItem ? [blocked, fresh] : [blocked];
    const { deps } = invoiceDeps({
      "att-1": "already_processed",
    });
    const tool = createMailAgentTools(deps).find(
      (item) => item.name === "propose_allowance_invoice_upload",
    )!;
    const result = (await tool.handler({ items }, UPLOAD_CTX)) as {
      executed: boolean;
      excluded: unknown[];
      noUploadNeeded?: boolean;
      pendingAction?: { parameters?: { items?: unknown[] }; actionType?: string };
    };

    assert.equal(result.executed, false);
    assert.deepEqual(result.excluded, [
      { ...blocked, reason: "already_processed", message: "此前已上传，本次无需上传" },
    ]);
    if (hasNewItem) {
      assert.deepEqual(result.pendingAction?.parameters?.items, [fresh]);
      assert.equal(result.pendingAction?.actionType, "upload_allowance_invoices");
    } else {
      assert.equal(result.noUploadNeeded, true);
      assert.equal(result.pendingAction, undefined);
    }
  });
}

test("an ordinary upload request automatically produces a disclosed retry confirmation for an unverified attachment", async () => {
  const { deps } = invoiceDeps({
    old: "pending_verification",
    done: "already_processed",
  });
  const tool = createMailAgentTools(deps).find(
    (item) => item.name === "propose_allowance_invoice_upload",
  )!;
  const result = (await tool.handler(
    {
      items: [
        { emailId: "mail", attachmentId: "old", filename: "94.pdf" },
        { emailId: "mail", attachmentId: "done", filename: "730.pdf" },
      ],
    },
    UPLOAD_CTX,
  )) as {
    executed: boolean;
    excluded: Array<{ attachmentId: string; message: string }>;
    pendingAction: {
      parameters: { retryUnverified: boolean; items: unknown[] };
      riskReason: string;
    };
  };

  assert.equal(result.executed, false);
  assert.deepEqual(
    result.excluded.map((item) => [item.attachmentId, item.message]),
    [["done", "此前已上传，本次无需上传"]],
  );
  assert.equal(result.pendingAction.parameters.retryUnverified, true);
  assert.deepEqual(result.pendingAction.parameters.items, [
    { emailId: "mail", attachmentId: "old", filename: "94.pdf" },
  ]);
  assert.match(result.pendingAction.riskReason, /重复提交风险/);
});

// ── discovery scope ─────────────────────────────────────────────────────

test("invoice discovery scopes to current mail only when explicitly requested", async () => {
  const requests: Array<{ emailId?: string; accountId?: string; fromDate?: string }> = [];
  const deps = {
    mailDatabase: {},
    intelligenceService: {},
    allowance: {
      async findInvoiceAttachments(input: { emailId?: string; accountId?: string; fromDate?: string }) {
        requests.push(input);
        return { ok: true, count: 0, candidates: [], messages: [], mailCount: 0, hasMore: false };
      },
    },
    allowanceToolsEnabled: true,
  } as unknown as MailAgentToolDeps;
  const tool = createMailAgentTools(deps).find(
    (item) => item.name === "find_invoice_attachments",
  )!;
  const context = { runContext: { accountId: "account", emailId: "focused" } };
  await tool.handler({ fromDate: "2026-10-01" }, context);
  await tool.handler({ scope: "current" }, context);
  assert.equal(requests[0]!.emailId, undefined);
  assert.equal(requests[0]!.accountId, "account");
  assert.equal(requests[0]!.fromDate, "2026-10-01");
  assert.equal(requests[1]!.emailId, "focused");
});

// ── registration sanity for this bundle ────────────────────────────────

test("the stub edition bundle registers the gated wecli and invoice tools", () => {
  const tools = createMailAgentTools({
    ...(wecliBundleDeps() as unknown as Record<string, unknown>),
    ...(invoiceDeps({}).deps as unknown as Record<string, unknown>),
  } as unknown as MailAgentToolDeps);
  const names = tools.map((tool) => tool.name);
  for (const name of [
    "wecli_query",
    "wecli_help",
    "wecli_run",
    "propose_wecli_command",
    "wecli_action_preview",
    "find_invoice_attachments",
    "propose_allowance_invoice_upload",
    "propose_allowance_invoice_delete",
  ]) {
    assert.ok(names.includes(name), `${name} must register with the gates on`);
  }
});
