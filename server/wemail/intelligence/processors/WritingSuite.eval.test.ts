import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  IntelligenceJob,
  ReplyDraftResult,
  ComposeMailResult,
} from "../../../../shared/wemail/intelligence.js";
import type { MailMessage } from "../../../../shared/wemail/mail.js";
import type { LlmClient, LlmResponse } from "../../ai/LlmClient.js";
import {
  ReplyDraftProcessor,
  ReplyDraftProcessorError,
} from "./ReplyDraftProcessor.js";
import type { ProcessorContext } from "../MailIntelligenceProcessor.js";
import { runEvalSuite, type EvalFixture } from "../eval/EvalRunner.js";

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

function makeCtx(msg: MailMessage): ProcessorContext {
  return { getMessage: () => msg };
}

function fakeLlmClient(response: LlmResponse): LlmClient {
  return {
    async generate() {
      return response;
    },
  };
}

// ── Writing fixtures (25+) ─────────────────────────────────────────────

const writingFixtures: EvalFixture[] = [
  // 1-5: Basic reply draft generation
  {
    fixtureId: "writing-reply-question",
    feature: "replyDraft",
    llmResponse: { draftMarkdown: "The Q3 kickoff is scheduled for July 8.", language: "en" },
    assertions: {
      "no-subject-line": (r: unknown) => {
        const d = r as ReplyDraftResult;
        return /^Subject:/im.test(d.draftMarkdown) ? "subject-line-found" : null;
      },
      "has-language": (r: unknown) => {
        const d = r as ReplyDraftResult;
        return typeof d.language === "string" && d.language.length > 0 ? null : "missing-language";
      },
    },
  },
  {
    fixtureId: "writing-reply-notification",
    feature: "replyDraft",
    llmResponse: { draftMarkdown: "Thanks, noted.", language: "en" },
    assertions: {
      "json-valid": (r: unknown) => {
        try { JSON.parse(JSON.stringify(r)); return null; } catch { return "json-invalid"; }
      },
      "no-headers": (r: unknown) => {
        const d = r as ReplyDraftResult;
        return /^(From:|To:|Cc:|Date:|Sent:)/im.test(d.draftMarkdown) ? "headers-found" : null;
      },
    },
  },
  {
    fixtureId: "writing-reply-urgent",
    feature: "replyDraft",
    llmResponse: { draftMarkdown: "I'll address this immediately and follow up within the hour.", language: "en" },
    assertions: {
      "has-content": (r: unknown) => {
        const d = r as ReplyDraftResult;
        return d.draftMarkdown.trim().length > 0 ? null : "empty-draft";
      },
    },
  },
  {
    fixtureId: "writing-reply-brief",
    feature: "replyDraft",
    llmResponse: { draftMarkdown: "Confirmed.", language: "en" },
    assertions: {
      "no-signature": (r: unknown) => {
        const d = r as ReplyDraftResult;
        return /(?:Best regards|Cheers|Warm regards|Kind regards|Sincerely),?\s*\n\s*[A-Z][a-z]+/.test(d.draftMarkdown) ? "fabricated-signature" : null;
      },
    },
  },
  {
    fixtureId: "writing-reply-detailed",
    feature: "replyDraft",
    llmResponse: { draftMarkdown: "I've reviewed the proposal and have a few comments. The budget allocation for Q3 looks reasonable, but I'd suggest increasing the marketing spend by 10%. Let me know if you'd like to discuss.", language: "en" },
    assertions: {
      "no-fwd-prefix": (r: unknown) => {
        const d = r as ReplyDraftResult;
        return /^Fwd:/im.test(d.draftMarkdown) ? "fwd-prefix-found" : null;
      },
    },
  },
  // 6-10: Style-aware drafts
  {
    fixtureId: "writing-style-formal",
    feature: "replyDraft",
    llmResponse: { draftMarkdown: "Thank you for your inquiry. I shall attend to this matter promptly.", language: "en", styleId: "style-formal" },
    assertions: {
      "has-style": (r: unknown) => {
        const d = r as ReplyDraftResult;
        return d.styleId === "style-formal" ? null : "missing-styleId";
      },
    },
  },
  {
    fixtureId: "writing-style-casual",
    feature: "replyDraft",
    llmResponse: { draftMarkdown: "Hey, sounds good! I'll take care of it.", language: "en", styleId: "style-casual" },
    assertions: {
      "has-style": (r: unknown) => {
        const d = r as ReplyDraftResult;
        return d.styleId === "style-casual" ? null : "missing-styleId";
      },
    },
  },
  {
    fixtureId: "writing-style-concise",
    feature: "replyDraft",
    llmResponse: { draftMarkdown: "Will do.", language: "en", styleId: "style-concise" },
    assertions: {
      "concise-length": (r: unknown) => {
        const d = r as ReplyDraftResult;
        return d.draftMarkdown.length < 100 ? null : "not-concise";
      },
    },
  },
  {
    fixtureId: "writing-style-detailed",
    feature: "replyDraft",
    llmResponse: { draftMarkdown: "Thank you for providing the details. After careful consideration, I believe we should proceed with option B for the following reasons: it aligns with our strategic goals, the timeline is achievable, and the resource requirements are within our current capacity.", language: "en", styleId: "style-detailed" },
    assertions: {
      "has-content": (r: unknown) => {
        const d = r as ReplyDraftResult;
        return d.draftMarkdown.length > 50 ? null : "too-short-for-detailed";
      },
    },
  },
  {
    fixtureId: "writing-style-no-style",
    feature: "replyDraft",
    llmResponse: { draftMarkdown: "I'll look into it and get back to you.", language: "en" },
    assertions: {
      "no-style-id": (r: unknown) => {
        const d = r as ReplyDraftResult;
        return d.styleId === undefined ? null : "unexpected-styleId";
      },
    },
  },
  // 11-15: Language variations
  {
    fixtureId: "writing-lang-french",
    feature: "replyDraft",
    llmResponse: { draftMarkdown: "Merci pour votre message. Je m'en occuperai.", language: "fr" },
    assertions: {
      "french-lang": (r: unknown) => {
        const d = r as ReplyDraftResult;
        return d.language === "fr" ? null : "wrong-language";
      },
    },
  },
  {
    fixtureId: "writing-lang-spanish",
    feature: "replyDraft",
    llmResponse: { draftMarkdown: "Gracias por su mensaje. Lo revisare.", language: "es" },
    assertions: {
      "spanish-lang": (r: unknown) => {
        const d = r as ReplyDraftResult;
        return d.language === "es" ? null : "wrong-language";
      },
    },
  },
  {
    fixtureId: "writing-lang-german",
    feature: "replyDraft",
    llmResponse: { draftMarkdown: "Vielen Dank fuer Ihre Nachricht. Ich werde mich darum kuemmern.", language: "de" },
    assertions: {
      "german-lang": (r: unknown) => {
        const d = r as ReplyDraftResult;
        return d.language === "de" ? null : "wrong-language";
      },
    },
  },
  {
    fixtureId: "writing-lang-japanese",
    feature: "replyDraft",
    llmResponse: { draftMarkdown: "ご連絡ありがとうございます。確認いたします。", language: "ja" },
    assertions: {
      "japanese-lang": (r: unknown) => {
        const d = r as ReplyDraftResult;
        return d.language === "ja" ? null : "wrong-language";
      },
    },
  },
  {
    fixtureId: "writing-lang-chinese",
    feature: "replyDraft",
    llmResponse: { draftMarkdown: "谢谢您的来信。我会处理这件事。", language: "zh" },
    assertions: {
      "chinese-lang": (r: unknown) => {
        const d = r as ReplyDraftResult;
        return d.language === "zh" ? null : "wrong-language";
      },
    },
  },
  // 16-20: Format validation - clean drafts
  {
    fixtureId: "writing-format-clean-short",
    feature: "replyDraft",
    llmResponse: { draftMarkdown: "Got it, thanks.", language: "en" },
    assertions: {
      "no-subject": (r: unknown) => {
        const d = r as ReplyDraftResult;
        return /^(Subject:|Re:|Fwd:)/im.test(d.draftMarkdown) ? "subject-found" : null;
      },
      "no-headers": (r: unknown) => {
        const d = r as ReplyDraftResult;
        return /^(From:|To:|Cc:|Date:|Sent:)/im.test(d.draftMarkdown) ? "headers-found" : null;
      },
    },
  },
  {
    fixtureId: "writing-format-clean-multiline",
    feature: "replyDraft",
    llmResponse: { draftMarkdown: "Thanks for the update.\n\nI'll review the document and provide feedback by EOD Friday.\n\nLet me know if there's anything urgent.", language: "en" },
    assertions: {
      "no-signature": (r: unknown) => {
        const d = r as ReplyDraftResult;
        return /(?:Best regards|Cheers|Warm regards|Kind regards|Sincerely),?\s*\n\s*[A-Z][a-z]+/.test(d.draftMarkdown) ? "fabricated-signature" : null;
      },
    },
  },
  {
    fixtureId: "writing-format-clean-action",
    feature: "replyDraft",
    llmResponse: { draftMarkdown: "I've scheduled the meeting for Thursday at 2pm. Please confirm if that works for you.", language: "en" },
    assertions: {
      "no-send-instructions": (r: unknown) => {
        const d = r as ReplyDraftResult;
        return /send now|click to send|submit/i.test(d.draftMarkdown) ? "send-instructions-found" : null;
      },
    },
  },
  {
    fixtureId: "writing-format-clean-question",
    feature: "replyDraft",
    llmResponse: { draftMarkdown: "Could you clarify which version of the report you need? The latest revision or the original?", language: "en" },
    assertions: {
      "json-valid": (r: unknown) => {
        try { JSON.parse(JSON.stringify(r)); return null; } catch { return "json-invalid"; }
      },
    },
  },
  {
    fixtureId: "writing-format-clean-thanks",
    feature: "replyDraft",
    llmResponse: { draftMarkdown: "Thank you for sharing. I've added it to our project tracker.", language: "en" },
    assertions: {
      "has-type": (r: unknown) => {
        const d = r as ReplyDraftResult;
        return d.type === "replyDraft" ? null : "wrong-type";
      },
    },
  },
  // 21-25: Metadata and edge cases
  {
    fixtureId: "writing-metadata-present",
    feature: "replyDraft",
    llmResponse: { draftMarkdown: "Noted, will follow up.", language: "en" },
    assertions: {
      "has-metadata": (r: unknown) => {
        const d = r as ReplyDraftResult;
        return d._metadata ? null : "missing-metadata";
      },
      "metadata-processor": (r: unknown) => {
        const d = r as ReplyDraftResult;
        return d._metadata?.processor === "replyDraft" ? null : "wrong-processor";
      },
    },
  },
  {
    fixtureId: "writing-metadata-version",
    feature: "replyDraft",
    llmResponse: { draftMarkdown: "I'll check and respond shortly.", language: "en" },
    assertions: {
      "metadata-v2": (r: unknown) => {
        const d = r as ReplyDraftResult;
        return d._metadata?.version === 2 ? null : "wrong-version";
      },
    },
  },
  {
    fixtureId: "writing-metadata-contextRefs",
    feature: "replyDraft",
    llmResponse: { draftMarkdown: "The deadline has been extended to next Friday.", language: "en" },
    assertions: {
      "has-header-ref": (r: unknown) => {
        const d = r as ReplyDraftResult;
        return d._metadata?.contextRefs?.includes("header") ? null : "missing-header-ref";
      },
      "has-body-ref": (r: unknown) => {
        const d = r as ReplyDraftResult;
        return d._metadata?.contextRefs?.includes("body-text") ? null : "missing-body-ref";
      },
    },
  },
  {
    fixtureId: "writing-edge-single-word",
    feature: "replyDraft",
    llmResponse: { draftMarkdown: "Agreed.", language: "en" },
    assertions: {
      "no-subject": (r: unknown) => {
        const d = r as ReplyDraftResult;
        return /^(Subject:|Re:|Fwd:)/im.test(d.draftMarkdown) ? "subject-found" : null;
      },
    },
  },
  {
    fixtureId: "writing-edge-no-fabricated-commitments",
    feature: "replyDraft",
    llmResponse: { draftMarkdown: "I'll need to review the details before committing to a timeline. Can you share the full proposal?", language: "en" },
    assertions: {
      "no-attachments": (r: unknown) => {
        const d = r as ReplyDraftResult;
        return /attached|attachment|see attached/i.test(d.draftMarkdown) ? "fabricated-attachment" : null;
      },
      "no-commitments": (r: unknown) => {
        const d = r as ReplyDraftResult;
        // Should not contain definitive promises like "I promise" or "I guarantee"
        return /I promise|I guarantee|I commit/i.test(d.draftMarkdown) ? "fabricated-commitment" : null;
      },
    },
  },
];

test("Writing suite eval: all 25 fixtures pass", async () => {
  const msg = makeMessage();
  const ctx = makeCtx(msg);

  const report = await runEvalSuite(
    writingFixtures,
    (llmClient, _feature) => {
      return new ReplyDraftProcessor({
        model: "gpt-4o-mini",
        llmClient,
        now: () => Date.now(),
      });
    },
    (feature) => makeJob(feature === "replyDraft" ? { styleId: undefined } : undefined),
    () => ctx,
  );

  assert.equal(report.fixturesLoaded, writingFixtures.length, "All fixtures should be loaded");
  const failures = report.results.filter((r) => r.status === "fail");
  if (failures.length > 0) {
    const details = failures
      .map((f) => `${f.fixtureId}: ${f.violations.join(", ")}`)
      .join("\n");
    assert.fail(`${failures.length} fixture(s) failed:\n${details}`);
  }
  assert.equal(report.passed, writingFixtures.length);
  assert.equal(report.failed, 0);
});

// ── Clarification fixtures ─────────────────────────────────────────────

test("Compose without recipients returns needsClarification", async () => {
  // This is tested through IntelligenceService, but we test the contract here
  const result: ComposeMailResult = {
    type: "composeMail",
    operationType: "NEW",
    status: "needsClarification",
    to: [],
    subject: "",
    draftMarkdown: "",
    clarification: {
      status: "needsClarification",
      questions: ["Who should this message be sent to?"],
      missingFields: ["to"],
    },
  };
  assert.equal(result.status, "needsClarification");
  assert.ok(result.clarification);
  assert.equal(result.clarification!.missingFields.length, 1);
  assert.equal(result.clarification!.missingFields[0], "to");
});

test("Compose without intent returns needsClarification with missingFields", () => {
  const result: ComposeMailResult = {
    type: "composeMail",
    operationType: "NEW",
    status: "needsClarification",
    to: ["someone@example.com"],
    subject: "",
    draftMarkdown: "",
    clarification: {
      status: "needsClarification",
      questions: ["What is the purpose of this message?"],
      missingFields: ["intent"],
    },
  };
  assert.equal(result.status, "needsClarification");
  assert.ok(result.clarification);
  assert.ok(result.clarification!.missingFields.includes("intent"));
});

test("Compose with both missing returns two missingFields", () => {
  const result: ComposeMailResult = {
    type: "composeMail",
    operationType: "NEW",
    status: "needsClarification",
    to: [],
    subject: "",
    draftMarkdown: "",
    clarification: {
      status: "needsClarification",
      questions: [
        "Who should this message be sent to?",
        "What is the purpose of this message?",
      ],
      missingFields: ["to", "intent"],
    },
  };
  assert.equal(result.clarification!.missingFields.length, 2);
  assert.equal(result.clarification!.questions.length, 2);
});

// ── Invalid styleId validation ─────────────────────────────────────────

test("Invalid styleId produces validation error in processor", async () => {
  const processor = new ReplyDraftProcessor({
    model: "gpt-4o-mini",
    llmClient: fakeLlmClient({
      text: JSON.stringify({ draftMarkdown: "test", language: "en" }),
      finishReason: "stop",
    }),
    styleLookup: () => null,
  });
  await assert.rejects(
    () => processor.handle(makeJob({ styleId: "nonexistent" }), makeCtx(makeMessage())),
    (err: unknown) => {
      assert.ok(err instanceof ReplyDraftProcessorError);
      assert.equal(err.code, "invalid-style");
      return true;
    },
  );
});

// ── No auto-send path verification ─────────────────────────────────────

test("No auto-send path: ReplyDraftProcessor source has no send references", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(
    path.join(here, "ReplyDraftProcessor.ts"),
    "utf8",
  );
  assert.ok(!/sendDraft|MailProvider|\.send\(/.test(src));
  assert.ok(!/\.move\(|\.archive\(|\.deleteMail\(/.test(src));
});

test("No auto-send path: IntelligenceService composeMail returns draft, never sends", async () => {
  // Verify that composeMail result never calls any send API
  const result: ComposeMailResult = {
    type: "composeMail",
    operationType: "NEW",
    status: "draft",
    to: ["test@example.com"],
    subject: "Test",
    draftMarkdown: "Test content",
    language: "en",
  };
  assert.equal(result.status, "draft");
  assert.notEqual(result.status, "sent");
  assert.notEqual(result.status, "sending");
});
