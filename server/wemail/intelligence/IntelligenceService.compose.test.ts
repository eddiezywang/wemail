import assert from "node:assert/strict";
import { test } from "node:test";
import type { LlmClient } from "../ai/LlmClient.js";
import { LlmRuntime } from "../ai/LlmRuntime.js";
import type { CanonicalMailRepository } from "../mail/CanonicalMailRepository.js";
import type { JobRepository } from "../queue/JobRepository.js";
import type { AuditLogService } from "../telemetry/AuditLogService.js";
import type { IntelligenceResultRepository } from "./IntelligenceResultRepository.js";
import { IntelligenceService } from "./IntelligenceService.js";
import type { MailMessage } from "../../../shared/wemail/mail.js";

test("composeMail returns a reply draft without a direct intelligence write", async () => {
  const source: MailMessage = {
    id: "msg-1",
    accountId: "acct-1",
    folder: "INBOX",
    messageId: "provider-msg-1",
    from: { name: "Alice", email: "alice@example.com" },
    to: [{ email: "me@example.com" }],
    cc: [],
    bcc: [],
    subject: "Project update",
    snippet: "The project is on track.",
    bodyText: "The project is on track.",
    receivedAt: "2026-08-14T08:00:00.000Z",
    hasAttachments: false,
    attachments: [],
    flags: { seen: true, flagged: false, answered: false, draft: false },
    sync: {
      uid: 1,
      uidValidity: 1,
      internalDate: "2026-08-14T08:00:00.000Z",
    },
  };
  const client: LlmClient = {
    async generate() {
      return {
        text: JSON.stringify({
          status: "draft",
          subject: "Re: Project update",
          draftMarkdown: "Hi Alice,\n\nThanks for the update. Glad to hear the project is on track.\n\nBest,",
        }),
        finishReason: "stop",
      };
    },
  };
  const service = new IntelligenceService({
    getOrchestrator: () => undefined,
    jobs: {} as JobRepository,
    results: {
      saveResult() {
        throw new Error("direct intelligence writes must not be used");
      },
    } as unknown as IntelligenceResultRepository,
    mail: {
      getMessageById: (emailId: string) => emailId === source.id ? source : null,
    } as CanonicalMailRepository,
    audit: { log() {} } as unknown as AuditLogService,
    llmRuntime: new LlmRuntime({
      initialSettings: null,
      initialConfig: {
        provider: "openai",
        apiKey: "test-key",
        baseUrl: "https://example.test/v1",
        defaultModel: "test-model",
      },
      initialClient: client,
    }),
  });

  const result = await service.composeMail({
    operationType: "REPLY",
    intent: "Thank Alice for the update.",
    accountId: "acct-1",
    emailId: "msg-1",
  }, { source: "user" });

  assert.equal(result.status, "draft");
  assert.equal(result.draftMarkdown.includes("Thanks for the update"), true);
  assert.deepEqual(result.to, ["alice@example.com"]);
});
