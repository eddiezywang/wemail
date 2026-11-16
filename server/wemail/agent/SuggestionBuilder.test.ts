import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSuggestions } from "./SuggestionBuilder.js";
import type { EditionAllowanceModules } from "./allowancePort.js";
import type {
  AgentSuggestionItem,
  EmailIntelligenceState,
} from "../../../shared/wemail/intelligence.js";

function makeState(
  overrides: Partial<EmailIntelligenceState> = {},
): EmailIntelligenceState {
  return {
    emailId: "msg-1",
    summary: { status: "skipped" },
    tags: { status: "skipped" },
    replyDecision: { status: "skipped" },
    replyDraft: { status: "skipped" },
    ...overrides,
  };
}

test("buildSuggestions leaves account-level home actions to AgentHomeActionService", () => {
  const suggestions = buildSuggestions({
    hasEmailContext: false,
    accountId: "acct-1",
  });
  assert.deepEqual(suggestions, []);
});

test("buildSuggestions returns empty when no email and no account", () => {
  const suggestions = buildSuggestions({ hasEmailContext: false });
  assert.equal(suggestions.length, 0);
});

test("buildSuggestions suggests an analyzed next step without copying summary or links", () => {
  const state = makeState({
    summary: {
      status: "succeeded",
      result: {
        type: "summary",
        bullets: ["问题单 10071940 超时待处理"],
        actionItems: ["在 服务台 处理问题单 10071940"],
        urgency: "medium",
      },
    },
    linkExtraction: {
      status: "succeeded",
      result: {
        type: "linkExtraction",
        links: [{
          url: "https://itsm.example.com/problems/10071940",
          actionText: "在 服务台 处理问题单 10071940",
          risk: false,
          riskReasons: [],
          category: "action",
        }],
        unsubscribeUrl: null,
      },
    },
  });
  const suggestions = buildSuggestions({
    intelligenceState: state,
    hasEmailContext: true,
    emailId: "msg-1",
  });

  assert.equal(suggestions[0]?.id, "analyze-next-step");
  assert.equal(suggestions[0]?.label, "给出下一步建议");
  assert.doesNotMatch(suggestions[0]?.label ?? "", /10071940|服务台/);
  assert.match(suggestions[0]?.prompt ?? "", /不要把邮件链接的标题直接当作行动建议/);
});

test("buildSuggestions suggests summary when no summary exists", () => {
  const state = makeState({ summary: { status: "skipped" } });
  const suggestions = buildSuggestions({
    intelligenceState: state,
    hasEmailContext: true,
    emailId: "msg-1",
  });
  const summarySuggestion = suggestions.find((s) => s.id === "suggest-summary");
  assert.ok(summarySuggestion);
  assert.equal(summarySuggestion.reason, "no-summary");
  assert.equal(summarySuggestion.priority, 1);
});

test("buildSuggestions does not suggest summary when summary exists", () => {
  const state = makeState({
    summary: {
      status: "succeeded",
      result: {
        type: "summary",
        bullets: ["b1"],
        actionItems: [],
        urgency: "low",
      },
    },
  });
  const suggestions = buildSuggestions({
    intelligenceState: state,
    hasEmailContext: true,
    emailId: "msg-1",
  });
  assert.ok(!suggestions.some((s) => s.id === "suggest-summary"));
});

test("buildSuggestions suggests todos as fallback when no high-priority action exists", () => {
  const state = makeState({
    summary: {
      status: "succeeded",
      result: {
        type: "summary",
        bullets: ["b1"],
        actionItems: [],
        urgency: "high",
      },
    },
    todoExtraction: { status: "skipped" },
  });
  const suggestions = buildSuggestions({
    intelligenceState: state,
    hasEmailContext: true,
    emailId: "msg-1",
  });
  const todoSuggestion = suggestions.find((s) => s.id === "suggest-todos");
  assert.ok(todoSuggestion);
  assert.equal(todoSuggestion.reason, "no-todos");
  assert.equal(todoSuggestion.priority, 2);
});

test("buildSuggestions does not suggest todos when todos already exist", () => {
  const state = makeState({
    summary: {
      status: "succeeded",
      result: {
        type: "summary",
        bullets: ["b1"],
        actionItems: ["Review contract"],
        urgency: "high",
      },
    },
    todoExtraction: {
      status: "succeeded",
      result: {
        type: "todoExtraction",
        todos: [{ title: "Review contract", confidence: 0.9, status: "suggested" }],
      },
    },
  });
  const suggestions = buildSuggestions({
    intelligenceState: state,
    hasEmailContext: true,
    emailId: "msg-1",
  });
  assert.ok(!suggestions.some((s) => s.id === "suggest-todos"));
});

test("buildSuggestions suggests draft when reply required but no draft", () => {
  const state = makeState({
    replyDecision: {
      status: "succeeded",
      result: {
        type: "replyDecision",
        shouldReply: true,
        reason: "Question asked",
        confidence: 0.9,
        priorityScore: 0.8,
        level: "high",
        replyRequired: true,
        signals: [],
      },
    },
    replyDraft: { status: "skipped" },
  });
  const suggestions = buildSuggestions({
    intelligenceState: state,
    hasEmailContext: true,
    emailId: "msg-1",
  });
  const draftSuggestion = suggestions.find((s) => s.id === "suggest-draft");
  assert.ok(draftSuggestion);
  assert.equal(draftSuggestion.reason, "reply-needed-no-draft");
  assert.equal(draftSuggestion.priority, 3);
});

test("buildSuggestions does not suggest draft when draft exists", () => {
  const state = makeState({
    replyDecision: {
      status: "succeeded",
      result: {
        type: "replyDecision",
        shouldReply: true,
        reason: "Question asked",
        confidence: 0.9,
        priorityScore: 0.8,
        level: "high",
        replyRequired: true,
        signals: [],
      },
    },
    replyDraft: {
      status: "succeeded",
      result: {
        type: "replyDraft",
        draftMarkdown: "Thanks for the update.",
        language: "en",
      },
    },
  });
  const suggestions = buildSuggestions({
    intelligenceState: state,
    hasEmailContext: true,
    emailId: "msg-1",
  });
  assert.ok(!suggestions.some((s) => s.id === "suggest-draft"));
});

test("buildSuggestions orders by priority descending (draft > todos > summary)", () => {
  const state = makeState({
    summary: { status: "skipped" },
    replyDecision: {
      status: "succeeded",
      result: {
        type: "replyDecision",
        shouldReply: true,
        reason: "Question asked",
        confidence: 0.9,
        priorityScore: 0.8,
        level: "high",
        replyRequired: true,
        signals: [],
      },
    },
    replyDraft: { status: "skipped" },
  });
  const suggestions = buildSuggestions({
    intelligenceState: state,
    hasEmailContext: true,
    emailId: "msg-1",
  });
  assert.ok(suggestions.length >= 2);
  // Next-step analysis (priority 4) leads; draft (3) before todos (2);
  // the fallback list is capped before summary (1) can surface.
  assert.deepEqual(
    suggestions.map((s) => s.id),
    ["analyze-next-step", "suggest-draft", "suggest-todos"],
  );

  // With todos already extracted, the summary fallback (1) stays in the
  // capped list and must still rank below the draft (3).
  const withTodos = makeState({
    summary: { status: "skipped" },
    replyDecision: state.replyDecision,
    replyDraft: { status: "skipped" },
    todoExtraction: {
      status: "succeeded",
      result: {
        type: "todoExtraction",
        todos: [
          {
            title: "跟进客户续约",
            confidence: 0.9,
            status: "suggested",
          },
        ],
      },
    },
  });
  const capped = buildSuggestions({
    intelligenceState: withTodos,
    hasEmailContext: true,
    emailId: "msg-1",
  });
  assert.deepEqual(
    capped.map((s) => s.id),
    ["analyze-next-step", "suggest-draft", "suggest-summary"],
  );
});

test("buildSuggestions returns empty when no intelligence state and email is focused", () => {
  const suggestions = buildSuggestions({
    hasEmailContext: true,
    emailId: "msg-1",
  });
  assert.equal(suggestions.length, 0);
});

test("buildSuggestions suggests translation for foreign-language mail without translation", () => {
  const state = makeState({
    summary: {
      status: "succeeded",
      result: {
        type: "summary",
        bullets: ["b1"],
        actionItems: [],
        urgency: "low",
      },
    },
    translation: { status: "pending" },
  });
  const suggestions = buildSuggestions({
    intelligenceState: state,
    hasEmailContext: true,
    emailId: "msg-1",
  });
  const translationSuggestion = suggestions.find(
    (s) => s.id === "suggest-translation",
  );
  assert.ok(translationSuggestion);
  assert.equal(translationSuggestion.reason, "foreign-language-no-translation");
  assert.equal(translationSuggestion.priority, 1);
});

test("buildSuggestions does not suggest translation when translation exists", () => {
  const state = makeState({
    summary: {
      status: "succeeded",
      result: {
        type: "summary",
        bullets: ["b1"],
        actionItems: [],
        urgency: "low",
      },
    },
    translation: {
      status: "succeeded",
      result: {
        type: "translation",
        targetLanguage: "zh-CN",
        translatedText: "你好",
        cached: false,
      },
    },
  });
  const suggestions = buildSuggestions({
    intelligenceState: state,
    hasEmailContext: true,
    emailId: "msg-1",
  });
  assert.ok(!suggestions.some((s) => s.id === "suggest-translation"));
});

test("buildSuggestions does not suggest translation when translation is skipped", () => {
  const state = makeState({
    summary: {
      status: "succeeded",
      result: {
        type: "summary",
        bullets: ["b1"],
        actionItems: [],
        urgency: "low",
      },
    },
    translation: { status: "skipped" },
  });
  const suggestions = buildSuggestions({
    intelligenceState: state,
    hasEmailContext: true,
    emailId: "msg-1",
  });
  assert.ok(!suggestions.some((s) => s.id === "suggest-translation"));
});

test("open edition proposes no invoice upload suggestion (edition-gated)", () => {
  // P2.6: the invoice-upload suggestion is an edition module capability.
  // Without the module even invoice-intent mail yields no invoice suggestion
  // (the fallback AI suggestions still fill). The full suggestion coverage
  // runs in the edition overlay's suite with the assembled module.
  const state = makeState({
    summary: {
      status: "succeeded",
      result: {
        type: "summary",
        schemaVersion: 2,
        intent: "invoice",
        attention: "know",
        displayMode: "one_line",
        headline: "湖北电信已开具电子发票，PDF 已作为附件发送；无需回复。",
        bullets: ["湖北电信已开具电子发票，PDF 已作为附件发送；无需回复。"],
        actionItems: [],
        urgency: "low",
      },
    },
  });

  const suggestions = buildSuggestions({
    intelligenceState: state,
    hasEmailContext: true,
    emailId: "msg-1",
    envelope: {
      id: "msg-1",
      subject: "湖北电信电子发票",
      from: "info@hb-189.cn",
      snippet: "您有一张电子发票，请查收附件。",
      folder: "INBOX",
      attachments: [
        {
          id: "att-1",
          filename: "26427000000526378227.pdf",
          mimetype: "application/pdf",
        },
      ],
    },
  });

  assert.ok(!suggestions.some((s) => s.id === "upload-allowance-invoice"));
});

test("an edition-contributed upload suggestion ranks first and reaches the builder unchanged", () => {
  // P2.6 round 8: the invoice-upload suggestion (detection heuristics and
  // copy) is contributed by the allowance module via
  // `buildUploadSuggestion`; the open builder only ranks and surfaces it.
  const suggestions = buildSuggestions({
    allowanceModules: {
      buildUploadSuggestion: (input) => {
        // The edition sees the projected summary + envelope, not the full
        // intelligence state.
        assert.equal(input.emailId, "msg-1");
        assert.equal(input.summary?.intent, "invoice");
        assert.equal(input.envelope?.attachments?.length, 1);
        return {
          id: "upload-allowance-invoice",
          label: "上传发票到发票平台",
          prompt: "阅读当前邮件，查找发票附件，并创建上传到发票平台的确认操作。",
          reason: "invoice-upload",
          priority: 100,
          confidence: 0.95,
        };
      },
    } as EditionAllowanceModules,
    intelligenceState: makeState({
      summary: {
        status: "succeeded",
        result: {
          type: "summary",
          schemaVersion: 2,
          intent: "invoice",
          attention: "know",
          displayMode: "one_line",
          headline: "湖北电信已开具电子发票，PDF 已作为附件发送；无需回复。",
          bullets: ["湖北电信已开具电子发票，PDF 已作为附件发送；无需回复。"],
          actionItems: [],
          urgency: "low",
        },
      },
    }),
    hasEmailContext: true,
    emailId: "msg-1",
    envelope: {
      id: "msg-1",
      subject: "湖北电信电子发票",
      from: "info@hb-189.cn",
      snippet: "您有一张电子发票，请查收附件。",
      folder: "INBOX",
      attachments: [{ id: "att-1", filename: "invoice.pdf", mimetype: "application/pdf" }],
    },
  });

  assert.equal(suggestions[0]?.id, "upload-allowance-invoice");
  assert.equal(suggestions[0]?.label, "上传发票到发票平台");
});

test("an edition contributor returning undefined yields no built-in suggestion", () => {
  const suggestions = buildSuggestions({
    allowanceModules: {
      buildUploadSuggestion: () => undefined,
    } as unknown as EditionAllowanceModules,
    intelligenceState: makeState({
      summary: {
        status: "succeeded",
        result: {
          type: "summary",
          intent: "invoice",
          bullets: ["发票"],
          actionItems: [],
          urgency: "low",
        },
      },
    }),
    hasEmailContext: true,
    emailId: "msg-1",
  });

  assert.ok(!suggestions.some((s) => s.id === "upload-allowance-invoice"));
  // Only the AI fallback candidates remain.
  assert.ok(suggestions.every((s) => s.id !== "upload-allowance-invoice" && s.reason !== "invoice-upload"));
});
test("buildSuggestions includes fallback suggestions when no high-priority action exists", () => {
  const state = makeState({
    summary: {
      status: "succeeded",
      result: {
        type: "summary",
        schemaVersion: 2,
        intent: "system_notice",
        attention: "know",
        displayMode: "one_line",
        headline: "系统通知，无需处理。",
        bullets: ["系统通知，无需处理。"],
        actionItems: [],
        urgency: "low",
      },
    },
    replyDecision: {
      status: "succeeded",
      result: {
        type: "replyDecision",
        shouldReply: false,
        replyRequired: false,
        reason: "No reply required",
        confidence: 0.9,
        priorityScore: 0.1,
        level: "low",
        signals: [],
      },
    },
  });

  const suggestions = buildSuggestions({
    intelligenceState: state,
    hasEmailContext: true,
    emailId: "msg-1",
  });

  assert.ok(suggestions.length <= 3);
  assert.ok(suggestions.some((s) => s.id === "fallback-summary"));
  assert.ok(suggestions.some((s) => s.id === "suggest-todos"));
  assert.ok(!suggestions.some((s) => s.id === "suggest-draft"));
});

test("buildSuggestions keeps summary actions out of agent suggestions", () => {
  const state = makeState({
    summary: {
      status: "succeeded",
      result: {
        type: "summary",
        schemaVersion: 3,
        intent: "request",
        attention: "act",
        displayMode: "actionable",
        headline: "客户要求核对合同金额。",
        actions: ["核对合同金额并确认是否可以开票"],
        actionObligation: "required",
        bullets: ["客户要求核对合同金额。"],
        actionItems: ["核对合同金额并确认是否可以开票"],
        urgency: "medium",
      },
    },
  });

  const suggestions = buildSuggestions({
    intelligenceState: state,
    hasEmailContext: true,
    emailId: "msg-1",
  });

  assert.ok(!suggestions.some((suggestion) => suggestion.reason === "summary-action"));
  assert.ok(suggestions.some((suggestion) => suggestion.id === "suggest-todos"));
});
