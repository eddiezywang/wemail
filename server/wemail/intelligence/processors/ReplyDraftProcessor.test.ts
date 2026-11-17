import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  IntelligenceJob,
  ProcessorWorkspaceContext,
  ReplyDraftResult,
} from "../../../../shared/wemail/intelligence.js";
import type { MailMessage } from "../../../../shared/wemail/mail.js";
import {
  LlmClientError,
  type LlmClient,
  type LlmResponse,
} from "../../ai/LlmClient.js";
import type { ProcessorContext } from "../MailIntelligenceProcessor.js";
import {
  ReplyDraftProcessor,
  ReplyDraftProcessorError,
} from "./ReplyDraftProcessor.js";

function makeMessage(overrides: Partial<MailMessage> = {}): MailMessage {
  return {
    id: "acct-1:INBOX:1:100",
    accountId: "acct-1",
    folder: "INBOX",
    messageId: "<m-100@x.com>",
    from: { email: "boss@x.com", name: "Boss" },
    to: [{ email: "me@x.com" }],
    cc: [],
    bcc: [],
    subject: "Q3 plans",
    snippet: "snippet",
    bodyText: "Can you confirm the Q3 kickoff date?",
    receivedAt: "2026-04-24T10:00:00.000Z",
    hasAttachments: false,
    attachments: [],
    flags: { seen: false, flagged: false, answered: false, draft: false },
    sync: { uid: 100, uidValidity: 1, internalDate: "2026-04-24T10:00:00.000Z" },
    ...overrides,
  };
}

function makeJob(payload?: Record<string, unknown>): IntelligenceJob {
  return {
    id: "job-1",
    emailId: "acct-1:INBOX:1:100",
    type: "replyDraft",
    status: "running",
    attempts: 0,
    maxAttempts: 2,
    createdAt: "2026-04-24T10:00:00Z",
    updatedAt: "2026-04-24T10:00:00Z",
    payload,
  };
}

function makeCtx(
  msg: MailMessage | null,
  workspace?: ProcessorWorkspaceContext,
): ProcessorContext {
  return { getMessage: () => msg, workspace };
}

function fakeClient(impl: (req: unknown) => Promise<LlmResponse>): LlmClient {
  return { generate: impl as LlmClient["generate"] };
}

test("ReplyDraftProcessor returns a draft for a question-style mail", async () => {
  let receivedReq: Record<string, unknown> | null = null;
  const processor = new ReplyDraftProcessor({
    model: "gpt-4o-mini",
    llmClient: fakeClient(async (req) => {
      receivedReq = req as Record<string, unknown>;
      return {
        text: JSON.stringify({
          draftMarkdown:
            "Hi Boss,\n\nThanks for the ping — Q3 kickoff is scheduled for July 8.",
          language: "en",
        }),
        finishReason: "stop",
        usage: { inputTokens: 100, outputTokens: 20 },
      };
    }),
  });
  const result = (await processor.handle(
    makeJob(),
    makeCtx(makeMessage()),
  )) as ReplyDraftResult;
  assert.equal(result.type, "replyDraft");
  assert.ok(result.draftMarkdown);
  assert.match(result.draftMarkdown, /Q3 kickoff/);
  assert.equal(result.language, "en");

  // System prompt + schema + timeout wired.
  assert.ok(receivedReq);
  assert.equal(typeof (receivedReq as { system: string }).system, "string");
  assert.ok((receivedReq as { jsonSchema: unknown }).jsonSchema);
  assert.ok((receivedReq as { timeoutMs: number }).timeoutMs <= 25_000);
});

test("ReplyDraftProcessor returns a draft for a notification-style mail", async () => {
  const processor = new ReplyDraftProcessor({
    model: "gpt-4o-mini",
    llmClient: fakeClient(async () => ({
      text: JSON.stringify({
        draftMarkdown: "Thanks, noted.",
        language: "en",
      }),
      finishReason: "stop",
      usage: { inputTokens: 50, outputTokens: 5 },
    })),
  });
  const result = (await processor.handle(
    makeJob(),
    makeCtx(
      makeMessage({
        subject: "[GitHub] Build #123 succeeded",
        from: { email: "noreply@github.com" },
        bodyText: "Your workflow run completed successfully.",
      }),
    ),
  )) as ReplyDraftResult;
  assert.equal(result.type, "replyDraft");
  assert.ok(result.draftMarkdown);
  assert.equal(result.language, "en");
});

test("ReplyDraftProcessor includes metadata in result", async () => {
  const processor = new ReplyDraftProcessor({
    model: "gpt-4o-mini",
    llmClient: fakeClient(async () => ({
      text: JSON.stringify({
        draftMarkdown: "Sure, I'll handle it.",
        language: "en",
      }),
      finishReason: "stop",
      usage: { inputTokens: 100, outputTokens: 10 },
    })),
  });
  const result = (await processor.handle(
    makeJob(),
    makeCtx(makeMessage()),
  )) as ReplyDraftResult;
  assert.ok(result._metadata);
  assert.equal(result._metadata.processor, "replyDraft");
  assert.equal(result._metadata.version, 2);
  assert.equal(result._metadata.model, "gpt-4o-mini");
  assert.equal(result._metadata.tokenUsage.inputTokens, 100);
  assert.equal(result._metadata.tokenUsage.outputTokens, 10);
  assert.ok(result._metadata.contextRefs.includes("header"));
  assert.ok(result._metadata.contextRefs.includes("body-text"));
  assert.ok(result._metadata.durationMs >= 0);
});

// ── Writing style tests ────────────────────────────────────────────────

test("ReplyDraftProcessor applies style instructions to system prompt", async () => {
  let receivedSystem: string | undefined;
  const processor = new ReplyDraftProcessor({
    model: "gpt-4o-mini",
    llmClient: fakeClient(async (req) => {
      receivedSystem = (req as { system?: string }).system;
      return {
        text: JSON.stringify({
          draftMarkdown: "Yo, sounds good.",
          language: "en",
          styleId: "style-casual",
        }),
        finishReason: "stop",
        usage: { inputTokens: 50, outputTokens: 5 },
      };
    }),
    styleLookup: (id) =>
      id === "style-casual"
        ? { id: "style-casual", name: "Casual", instructions: "Use informal language", createdAt: "", updatedAt: "" }
        : null,
  });
  const result = (await processor.handle(
    makeJob({ styleId: "style-casual" }),
    makeCtx(makeMessage()),
  )) as ReplyDraftResult;
  assert.equal(result.type, "replyDraft");
  assert.equal(result.styleId, "style-casual");
  assert.ok(receivedSystem);
  assert.match(receivedSystem, /Use informal language/);
});

test("ReplyDraftProcessor throws for invalid styleId", async () => {
  const processor = new ReplyDraftProcessor({
    model: "gpt-4o-mini",
    llmClient: fakeClient(async () => ({
      text: JSON.stringify({ draftMarkdown: "test", language: "en" }),
      finishReason: "stop",
    })),
    styleLookup: () => null,
  });
  await assert.rejects(
    () => processor.handle(makeJob({ styleId: "style-nonexistent" }), makeCtx(makeMessage())),
    (err: unknown) => {
      assert.ok(err instanceof ReplyDraftProcessorError);
      assert.equal(err.code, "invalid-style");
      assert.equal(err.retryable, false);
      return true;
    },
  );
});

test("ReplyDraftProcessor includes style in contextRefs when styleId is present", async () => {
  const processor = new ReplyDraftProcessor({
    model: "gpt-4o-mini",
    llmClient: fakeClient(async () => ({
      text: JSON.stringify({
        draftMarkdown: "Best of luck with that.",
        language: "en",
        styleId: "style-formal",
      }),
      finishReason: "stop",
      usage: { inputTokens: 50, outputTokens: 5 },
    })),
    styleLookup: (id) =>
      id === "style-formal"
        ? { id: "style-formal", name: "Formal", instructions: "Be formal", createdAt: "", updatedAt: "" }
        : null,
  });
  const result = (await processor.handle(
    makeJob({ styleId: "style-formal" }),
    makeCtx(makeMessage()),
  )) as ReplyDraftResult;
  assert.ok(result._metadata);
  assert.ok(result._metadata.contextRefs.includes("style:style-formal"));
});

test("ReplyDraftProcessor uses composeLanguage when LLM does not return language", async () => {
  const processor = new ReplyDraftProcessor({
    model: "gpt-4o-mini",
    llmClient: fakeClient(async () => ({
      text: JSON.stringify({
        draftMarkdown: "Merci, je vais m'en occuper.",
      }),
      finishReason: "stop",
      usage: { inputTokens: 50, outputTokens: 5 },
    })),
    composeLanguage: "fr",
  });
  const result = (await processor.handle(
    makeJob(),
    makeCtx(makeMessage()),
  )) as ReplyDraftResult;
  assert.equal(result.language, "fr");
});

// ── Draft format validation tests ──────────────────────────────────────

test("ReplyDraftProcessor rejects draft with subject line", async () => {
  const processor = new ReplyDraftProcessor({
    model: "gpt-4o-mini",
    llmClient: fakeClient(async () => ({
      text: JSON.stringify({
        draftMarkdown: "Subject: My reply\n\nThis is my response.",
        language: "en",
      }),
      finishReason: "stop",
    })),
  });
  await assert.rejects(
    () => processor.handle(makeJob(), makeCtx(makeMessage())),
    (err: unknown) => {
      assert.ok(err instanceof ReplyDraftProcessorError);
      assert.equal(err.code, "subject-line-in-draft");
      assert.equal(err.retryable, false);
      return true;
    },
  );
});

test("ReplyDraftProcessor rejects draft with Re: prefix", async () => {
  const processor = new ReplyDraftProcessor({
    model: "gpt-4o-mini",
    llmClient: fakeClient(async () => ({
      text: JSON.stringify({
        draftMarkdown: "Re: Q3 plans\n\nHere's my reply.",
        language: "en",
      }),
      finishReason: "stop",
    })),
  });
  await assert.rejects(
    () => processor.handle(makeJob(), makeCtx(makeMessage())),
    (err: unknown) => {
      assert.ok(err instanceof ReplyDraftProcessorError);
      assert.equal(err.code, "subject-line-in-draft");
      assert.equal(err.retryable, false);
      return true;
    },
  );
});

test("ReplyDraftProcessor rejects draft with mail headers", async () => {
  const processor = new ReplyDraftProcessor({
    model: "gpt-4o-mini",
    llmClient: fakeClient(async () => ({
      text: JSON.stringify({
        draftMarkdown: "From: me@x.com\nTo: boss@x.com\n\nMy reply here.",
        language: "en",
      }),
      finishReason: "stop",
    })),
  });
  await assert.rejects(
    () => processor.handle(makeJob(), makeCtx(makeMessage())),
    (err: unknown) => {
      assert.ok(err instanceof ReplyDraftProcessorError);
      assert.equal(err.code, "mail-header-in-draft");
      assert.equal(err.retryable, false);
      return true;
    },
  );
});

test("ReplyDraftProcessor rejects draft with fabricated signature", async () => {
  const processor = new ReplyDraftProcessor({
    model: "gpt-4o-mini",
    llmClient: fakeClient(async () => ({
      text: JSON.stringify({
        draftMarkdown: "Sounds good, I'll take care of it.\n\nBest regards,\nJohn Smith",
        language: "en",
      }),
      finishReason: "stop",
    })),
  });
  await assert.rejects(
    () => processor.handle(makeJob(), makeCtx(makeMessage())),
    (err: unknown) => {
      assert.ok(err instanceof ReplyDraftProcessorError);
      assert.equal(err.code, "fabricated-signature-in-draft");
      assert.equal(err.retryable, false);
      return true;
    },
  );
});

test("ReplyDraftProcessor accepts clean draft without headers or signatures", async () => {
  const processor = new ReplyDraftProcessor({
    model: "gpt-4o-mini",
    llmClient: fakeClient(async () => ({
      text: JSON.stringify({
        draftMarkdown: "Thanks for the update. I'll review and get back to you by Friday.",
        language: "en",
      }),
      finishReason: "stop",
      usage: { inputTokens: 50, outputTokens: 10 },
    })),
  });
  const result = (await processor.handle(
    makeJob(),
    makeCtx(makeMessage()),
  )) as ReplyDraftResult;
  assert.equal(result.type, "replyDraft");
  assert.ok(result.draftMarkdown);
  assert.equal(result.language, "en");
});

// ── No auto-send guarantee ─────────────────────────────────────────────

test("ReplyDraftProcessor NEVER invokes send (no provider seam is surfaced)", async () => {
  // Sanity/doc-style guard: the processor has no reference to any
  // MailProvider, so it cannot send. We verify by construction — there
  // is no `provider` dep to pass — and by checking the source file does
  // not reference `sendDraft`.
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(
    path.join(here, "ReplyDraftProcessor.ts"),
    "utf8",
  );
  assert.ok(
    !/sendDraft|MailProvider/.test(src),
    "ReplyDraftProcessor must not reference MailProvider.sendDraft",
  );
  // Also verify no send, move, archive, delete references
  assert.ok(
    !/\.send\(|\.move\(|\.archive\(|\.deleteMail\(/.test(src),
    "ReplyDraftProcessor must not call send, move, archive, or deleteMail",
  );
});

// ── Existing tests preserved ───────────────────────────────────────────

test("ReplyDraftProcessor propagates LlmClientError with retryable flag preserved (503 retryable, 401 terminal)", async () => {
  const retry = new ReplyDraftProcessor({
    model: "x",
    llmClient: fakeClient(async () => {
      throw new LlmClientError({
        status: 503,
        code: "overloaded",
        message: "busy",
      });
    }),
  });
  await assert.rejects(
    () => retry.handle(makeJob(), makeCtx(makeMessage())),
    (err: unknown) => {
      assert.ok(err instanceof LlmClientError);
      assert.equal((err as LlmClientError).retryable, true);
      return true;
    },
  );

  const terminal = new ReplyDraftProcessor({
    model: "x",
    llmClient: fakeClient(async () => {
      throw new LlmClientError({
        status: 401,
        code: "unauthorized",
        message: "bad key",
      });
    }),
  });
  await assert.rejects(
    () => terminal.handle(makeJob(), makeCtx(makeMessage())),
    (err: unknown) => {
      assert.ok(err instanceof LlmClientError);
      assert.equal((err as LlmClientError).retryable, false);
      return true;
    },
  );
});

test("ReplyDraftProcessor treats fenced + truncated + parse failures as terminal", async () => {
  const fenced = new ReplyDraftProcessor({
    model: "x",
    llmClient: fakeClient(async () => ({
      text: "```json\n" + JSON.stringify({ draftMarkdown: "hello" }) + "\n```",
      finishReason: "stop",
    })),
  });
  await assert.rejects(
    () => fenced.handle(makeJob(), makeCtx(makeMessage())),
    (err: unknown) => {
      assert.equal((err as ReplyDraftProcessorError).code, "fenced-output");
      assert.equal((err as ReplyDraftProcessorError).retryable, false);
      return true;
    },
  );

  const truncated = new ReplyDraftProcessor({
    model: "x",
    llmClient: fakeClient(async () => ({
      text: JSON.stringify({ draftMarkdown: "r" }),
      finishReason: "length",
    })),
  });
  await assert.rejects(
    () => truncated.handle(makeJob(), makeCtx(makeMessage())),
    (err: unknown) => {
      assert.equal((err as ReplyDraftProcessorError).code, "truncated");
      assert.equal((err as ReplyDraftProcessorError).retryable, false);
      return true;
    },
  );

  const bad = new ReplyDraftProcessor({
    model: "x",
    llmClient: fakeClient(async () => ({
      text: "not json",
      finishReason: "stop",
    })),
  });
  await assert.rejects(
    () => bad.handle(makeJob(), makeCtx(makeMessage())),
    (err: unknown) => {
      assert.equal((err as ReplyDraftProcessorError).code, "invalid-json");
      assert.equal((err as ReplyDraftProcessorError).retryable, false);
      return true;
    },
  );
});

test("ReplyDraftProcessor throws when mail row is missing (terminal)", async () => {
  const processor = new ReplyDraftProcessor({
    model: "x",
    llmClient: fakeClient(async () => {
      throw new Error("should not be called");
    }),
  });
  await assert.rejects(
    () => processor.handle(makeJob(), makeCtx(null)),
    (err: Error) => {
      assert.ok(err instanceof ReplyDraftProcessorError);
      assert.equal((err as ReplyDraftProcessorError).code, "mail-missing");
      assert.equal((err as ReplyDraftProcessorError).retryable, false);
      return true;
    },
  );
});

test("ReplyDraftProcessor rejects response with missing or empty draftMarkdown", async () => {
  const emptyDraft = new ReplyDraftProcessor({
    model: "x",
    llmClient: fakeClient(async () => ({
      text: JSON.stringify({ draftMarkdown: "" }),
      finishReason: "stop",
    })),
  });
  await assert.rejects(
    () => emptyDraft.handle(makeJob(), makeCtx(makeMessage())),
    (err: unknown) => {
      assert.equal((err as ReplyDraftProcessorError).code, "invalid-draftMarkdown");
      assert.equal((err as ReplyDraftProcessorError).retryable, false);
      return true;
    },
  );

  const missingDraft = new ReplyDraftProcessor({
    model: "x",
    llmClient: fakeClient(async () => ({
      text: JSON.stringify({}),
      finishReason: "stop",
    })),
  });
  await assert.rejects(
    () => missingDraft.handle(makeJob(), makeCtx(makeMessage())),
    (err: unknown) => {
      assert.equal((err as ReplyDraftProcessorError).code, "invalid-draftMarkdown");
      return true;
    },
  );
});

// ── Route C / WP E: workspace voice + do-dont injection ─────────────

test("ReplyDraftProcessor omits workspace block when ctx.workspace is undefined", async () => {
  let receivedUserMessage: string | undefined;
  const processor = new ReplyDraftProcessor({
    model: "gpt-4o-mini",
    llmClient: fakeClient(async (req) => {
      const messages = (req as { messages: { role: string; content: string }[] })
        .messages;
      receivedUserMessage = messages[0]?.content;
      return {
        text: JSON.stringify({
          draftMarkdown: "Thanks, noted.",
          language: "en",
        }),
        finishReason: "stop",
        usage: { inputTokens: 50, outputTokens: 5 },
      };
    }),
  });
  await processor.handle(makeJob(), makeCtx(makeMessage()));
  assert.ok(receivedUserMessage);
  assert.ok(
    !receivedUserMessage.includes("STYLE_VOICE_MD"),
    "baseline user message must NOT carry a STYLE_VOICE_MD block",
  );
  assert.ok(
    !receivedUserMessage.includes("STYLE_DO_DONT_MD"),
    "baseline user message must NOT carry a STYLE_DO_DONT_MD block",
  );
});

test("ReplyDraftProcessor injects workspace voice + do-dont blocks into user message", async () => {
  let receivedUserMessage: string | undefined;
  const processor = new ReplyDraftProcessor({
    model: "gpt-4o-mini",
    llmClient: fakeClient(async (req) => {
      const messages = (req as { messages: { role: string; content: string }[] })
        .messages;
      receivedUserMessage = messages[0]?.content;
      return {
        text: JSON.stringify({
          draftMarkdown: "短回复。",
          language: "zh",
        }),
        finishReason: "stop",
        usage: { inputTokens: 60, outputTokens: 5 },
      };
    }),
  });
  const workspace: ProcessorWorkspaceContext = {
    sections: [
      { path: "style/voice.md", content: "短句、专业、不写问候语" },
      { path: "style/do-dont.md", content: "禁止寒暄" },
    ],
    totalTokenEstimate: 8,
    truncated: false,
  };
  await processor.handle(makeJob(), makeCtx(makeMessage(), workspace));
  assert.ok(receivedUserMessage);
  assert.ok(receivedUserMessage.includes("<<<STYLE_VOICE_MD>>>"));
  assert.ok(receivedUserMessage.includes("短句、专业"));
  assert.ok(receivedUserMessage.includes("<<<STYLE_DO_DONT_MD>>>"));
  assert.ok(receivedUserMessage.includes("禁止寒暄"));
});
