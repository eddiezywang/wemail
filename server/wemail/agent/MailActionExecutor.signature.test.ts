import assert from "node:assert/strict";
import test from "node:test";
import { MailActionExecutor } from "./MailActionExecutor.js";
import type { WemailDraftInput } from "../../../shared/wemail/mail.js";

for (const unavailable of [false, true]) {
  test(`confirmed send ${unavailable ? "survives directory failure" : "awaits directory signature identity"}`, async () => {
    let queued: WemailDraftInput | undefined;
    const executor = new MailActionExecutor({
      mailProvider: {} as never, audit: { log() {} } as never,
      directoryService: { async getContact() {
        if (unavailable) throw new Error("reader unavailable");
        return { id: "sender", accountId: "account", name: "张三", email: "sender@example.com", aliases: [] };
      } },
      mailDatabase: {
        listAccounts: async () => [{ account: { id: "account", emailAddress: "sender@example.com", displayName: "Account Name" } }],
        enqueueSend: async (draft: WemailDraftInput) => {
          queued = draft;
          return { value: { outboxId: "outbox", messageIdHeader: "message" } };
        },
      } as never,
    });
    const result = await executor.execute({
      id: "confirmed-send", action_type: "send", description: "send", email_id: null,
      input_json: JSON.stringify({ accountId: "account", to: [{ email: "recipient@example.com" }], subject: "subject", bodyText: "body" }),
    } as never, { accountId: "account" });
    assert.equal(result.ok, true);
    assert.ok(queued);
    assert.match(queued.bodyText, unavailable ? /Account Name/ : /张三/);
  });
}

test("confirmed send refuses attachments instead of dropping them", async () => {
  let queued = false;
  const executor = new MailActionExecutor({
    mailProvider: {} as never, audit: { log() {} } as never,
    mailDatabase: { enqueueSend: async () => { queued = true; } } as never,
  });
  await assert.rejects(executor.execute({
    id: "send-with-attachment", action_type: "send", description: "send", email_id: null,
    input_json: JSON.stringify({ accountId: "account", to: [{ email: "recipient@example.com" }], subject: "subject", bodyText: "body", attachments: [{ filename: "sample.txt" }] }),
  } as never, { accountId: "account" }), /send-attachments-not-supported/);
  assert.equal(queued, false);
});

test("generic command is not executed when invoice status projection is missing", async () => {
  let calls = 0;
  const executor = new MailActionExecutor({
    mailProvider: {} as never, mailDatabase: {} as never, audit: { log() {} } as never,
    allowancePlatformCommands: {} as never,
    wecli: { async run() { calls += 1; throw new Error("must not execute"); } },
  });
  await assert.rejects(executor.execute({
    id: "command", action_type: "run_wecli_command", description: "command", email_id: null,
    input_json: JSON.stringify({ command: "allowance delete invoice-1" }),
  } as never, { accountId: "account" }),
  (error: unknown) => (error as { code?: string }).code === "allowance-not-wired");
  assert.equal(calls, 0);
});

test("legacy upload does not start when status projection is missing", async () => {
  let calls = 0;
  const executor = new MailActionExecutor({
    mailProvider: {} as never, mailDatabase: {} as never, audit: { log() {} } as never,
    allowance: { async uploadFromMailAttachments() { calls += 1; return { ok: true, results: [] }; } },
    executeLegacyAllowanceAction: async () => ({ ok: true, summary: "uploaded" }),
  });
  await assert.rejects(executor.execute({
    id: "upload", action_type: "upload_allowance_invoices", description: "upload", email_id: null,
    input_json: JSON.stringify({ items: [{ emailId: "m", attachmentId: "a" }] }),
  } as never, { accountId: "account" }),
  (error: unknown) => (error as { code?: string }).code === "allowance-not-wired");
  assert.equal(calls, 0);
});

test("legacy allowance upload confirm fails closed with the typed not-wired error", async () => {
  // P2.6: the allowance service is an edition module; a legacy
  // upload_allowance_invoices action confirmed in the open edition must not
  // execute — it raises the typed "allowance-not-wired" error.
  const executor = new MailActionExecutor({
    mailProvider: {} as never,
    audit: { log() {} } as never,
    mailDatabase: {} as never,
  });
  await assert.rejects(
    executor.execute({
      id: "confirmed-upload", action_type: "upload_allowance_invoices", description: "upload", email_id: null,
      input_json: JSON.stringify({ items: [{ emailId: "m", attachmentId: "a" }] }),
    } as never, { accountId: "account" }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "allowance-not-wired");
      return true;
    },
  );
});

test("legacy allowance delete confirm fails closed with the typed not-wired error", async () => {
  // P2.6 round 8: assembling and validating the platform delete command is
  // edition semantics (`AllowancePlatformCommandsPort`); without the module
  // a confirmed legacy delete_allowance_invoices action must not execute —
  // the same typed "allowance-not-wired" failure as upload, even though a
  // wecli runtime could theoretically run a command string.
  const executor = new MailActionExecutor({
    mailProvider: {} as never,
    audit: { log() {} } as never,
    mailDatabase: {} as never,
    wecli: { async run() { throw new Error("must not run any command in the open edition"); } },
  });
  await assert.rejects(
    executor.execute({
      id: "confirmed-delete", action_type: "delete_allowance_invoices", description: "delete", email_id: null,
      input_json: JSON.stringify({ invoiceIds: ["inv-1"] }),
    } as never, { accountId: "account" }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "allowance-not-wired");
      return true;
    },
  );
});

test("an edition-contributed platform command port assembles and guards the delete command", async () => {
  // P2.6 round 8: the internal edition contributes the delete-command
  // assembly/validation; the open seam only drives the contributed port and
  // reports the execution.
  const commands: string[] = [];
  const projected: string[][] = [];
  const executor = new MailActionExecutor({
    mailProvider: {} as never,
    audit: { log() {} } as never,
    mailDatabase: {} as never,
    wecli: {
      async run(command: string) {
        commands.push(command);
        return {
          classification: { kind: "requires-confirmation", command, subcommand: "delete", reason: "test" },
          exitCode: 0,
          stdout: "",
          stderr: "",
          durationMs: 1,
          timedOut: false,
          auditId: "audit-1",
        };
      },
    },
    allowancePlatformCommands: {
      buildDeleteCommand: (invoiceIds) => `allowance delete ${invoiceIds.join(" ")}`,
      isEquivalentDeleteCommand: (command, invoiceIds) =>
        typeof command === "string" && command.trim() === `allowance delete ${invoiceIds.join(" ")}`,
      deletedInvoiceIds: () => [],
      isListCommand: () => false,
      invoiceFieldsFromUploadItem: () => ({}),
    },
    allowanceStatusProjection: {
      recordUpload() {},
      recordDelete(input) { projected.push(input.invoiceIds ?? []); },
      recordSnapshot() {},
    },
    async executeLegacyAllowanceAction(input) {
      const ids = input.parameters.invoiceIds as string[];
      const command = input.commands!.buildDeleteCommand(ids);
      if (input.parameters.command && !input.commands!.isEquivalentDeleteCommand(input.parameters.command, ids, input.tokenize)) {
        throw new Error("invalid-allowance-delete-command");
      }
      await input.wecli!.run(command, { approvedBy: `user:${input.accountId}` });
      input.projection.recordDelete({ accountId: input.accountId, command, invoiceIds: ids });
      return { ok: true, summary: "已完成" };
    },
  });

  const result = await executor.execute({
    id: "confirmed-delete-port", action_type: "delete_allowance_invoices", description: "删除发票关联", email_id: null,
    input_json: JSON.stringify({ invoiceIds: ["inv-1", "inv-2"] }),
  } as never, { accountId: "account" });
  assert.equal(result.ok, true);
  assert.deepEqual(commands, ["allowance delete inv-1 inv-2"]);
  assert.deepEqual(projected, [["inv-1", "inv-2"]]);

  // A user-supplied command that does not match the confirmed ids is
  // rejected through the contributed validator.
  await assert.rejects(
    executor.execute({
      id: "confirmed-delete-port-2", action_type: "delete_allowance_invoices", description: "删除发票关联", email_id: null,
      input_json: JSON.stringify({ invoiceIds: ["inv-1"], command: "allowance delete inv-9" }),
    } as never, { accountId: "account" }),
    /invalid-allowance-delete-command/,
  );
  assert.equal(commands.length, 1);
});
