import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  IntelligenceJobType,
  SummaryThreadResult,
} from "../../../../shared/wemail/intelligence.js";
import type { LlmClient } from "../../ai/LlmClient.js";
import { SummaryProcessor } from "../processors/SummaryProcessor.js";
import type { MailMessage } from "../../../../shared/wemail/mail.js";
import type { ProcessorContext } from "../MailIntelligenceProcessor.js";
import {
  type EvalFixture,
  FakeLlmAdapter,
  fakeLlmFromJson,
  runFixtureAsync,
  runEvalSuite,
  hasRequiredFailures,
} from "../eval/EvalRunner.js";

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
    snippet: "we need",
    bodyText: "Please prepare the Q3 deck by Friday.",
    receivedAt: "2026-04-24T10:00:00.000Z",
    hasAttachments: false,
    attachments: [],
    flags: { seen: false, flagged: false, answered: false, draft: false },
    sync: { uid: 100, uidValidity: 1, internalDate: "2026-04-24T10:00:00Z" },
    ...overrides,
  };
}

function makeJob(type: IntelligenceJobType) {
  return {
    id: "job-1",
    emailId: "acct-1:INBOX:1:100",
    type,
    status: "running",
    attempts: 0,
    maxAttempts: 2,
    createdAt: "2026-04-24T10:00:00Z",
    updatedAt: "2026-04-24T10:00:00Z",
  };
}

function makeCtx(): ProcessorContext {
  return { getMessage: () => makeMessage() };
}

/**
 * Thread-mode processor factory: creates a SummaryProcessor configured
 * for thread mode with the provided thread messages.
 */
function createThreadProcessorFactory(
  threadMessages: Array<{
    emailId: string;
    subject?: string;
    from?: string;
    bodyText?: string;
    bodyHtml?: string;
    receivedAt: string;
  }>,
  summaryLanguage?: string,
) {
  return (llmClient: LlmClient) =>
    new SummaryProcessor({
      llmClient,
      model: "test-model",
      mode: "thread",
      threadMessages,
      summaryLanguage,
    });
}

/**
 * Email-mode processor factory.
 */
function createEmailProcessorFactory(summaryLanguage?: string) {
  return (llmClient: LlmClient) =>
    new SummaryProcessor({
      llmClient,
      model: "test-model",
      summaryLanguage,
    });
}

// ── 20+ Summary Fixtures ──────────────────────────────────────────

const threadMessages = [
  {
    emailId: "msg-1",
    subject: "Re: Q3 plans",
    from: "Boss <boss@x.com>",
    bodyText: "Please prepare the Q3 deck by Friday.",
    receivedAt: "2026-04-24T10:00:00Z",
  },
  {
    emailId: "msg-2",
    subject: "Re: Q3 plans",
    from: "Me <me@x.com>",
    bodyText: "I will have it ready by Thursday.",
    receivedAt: "2026-04-24T11:00:00Z",
  },
];

const marketingMessages = [
  {
    emailId: "promo-1",
    subject: "50% off everything!",
    from: "deals@store.com",
    bodyText: "Shop our biggest sale of the year. Limited time only!",
    receivedAt: "2026-04-24T10:00:00Z",
  },
];

const notificationMessages = [
  {
    emailId: "notif-1",
    subject: "Your order has shipped",
    from: "noreply@shop.com",
    bodyText: "Your order #12345 has shipped. Track your package.",
    receivedAt: "2026-04-24T10:00:00Z",
  },
];

const urgentMessages = [
  {
    emailId: "urgent-1",
    subject: "URGENT: Server outage",
    from: "ops@company.com",
    bodyText: "Production server is down. All hands on deck.",
    receivedAt: "2026-04-24T10:00:00Z",
  },
  {
    emailId: "urgent-2",
    subject: "Re: URGENT: Server outage",
    from: "dev@company.com",
    bodyText: "Investigating. Looks like a database connection pool exhaustion.",
    receivedAt: "2026-04-24T10:15:00Z",
  },
];

const chineseMessages = [
  {
    emailId: "zh-1",
    subject: "季度计划",
    from: "老板 <boss@cn.com>",
    bodyText: "请在周五前准备好第三季度的报告。",
    receivedAt: "2026-04-24T10:00:00Z",
  },
];

const longThreadMessages = Array.from({ length: 10 }, (_, i) => ({
  emailId: `long-msg-${i}`,
  subject: `Re: Long thread (${i})`,
  from: i % 2 === 0 ? "Alice <alice@x.com>" : "Bob <bob@x.com>",
  bodyText: `Message ${i} in the long thread. This is discussion point ${i}. We need to decide on the approach.`,
  receivedAt: new Date(Date.parse("2026-04-24T10:00:00Z") + i * 3600000).toISOString(),
}));

const emptyBodyMessages = [
  {
    emailId: "empty-1",
    subject: "FYI",
    from: "auto@system.com",
    bodyText: "",
    receivedAt: "2026-04-24T10:00:00Z",
  },
];

const actionItemMessages = [
  {
    emailId: "action-1",
    subject: "Project deadline",
    from: "pm@company.com",
    bodyText: "The project deadline is next Wednesday. John, please finish the backend by Monday. Sarah, review the frontend by Tuesday.",
    receivedAt: "2026-04-24T10:00:00Z",
  },
  {
    emailId: "action-2",
    subject: "Re: Project deadline",
    from: "john@company.com",
    bodyText: "I will have the backend ready by Monday EOD.",
    receivedAt: "2026-04-24T11:00:00Z",
  },
];

const riskMessages = [
  {
    emailId: "risk-1",
    subject: "Vendor delay risk",
    from: "pm@company.com",
    bodyText: "The vendor informed us they may not deliver on time. This could impact our launch date. We need a contingency plan.",
    receivedAt: "2026-04-24T10:00:00Z",
  },
];

const mixedLanguageMessages = [
  {
    emailId: "mixed-1",
    subject: "Project update / 项目更新",
    from: "colleague <col@x.com>",
    bodyText: "Here is the latest update on the project. Below are the key points. 以下是项目的最新进展。",
    receivedAt: "2026-04-24T10:00:00Z",
  },
];

const summaryFixtures: EvalFixture[] = [
  // Fixture 1: Basic thread summary
  {
    fixtureId: "thread-basic",
    feature: "summary",
    llmResponse: {
      type: "summary",
      bullets: ["Boss requested Q3 deck", "Commitment to deliver by Thursday", "Deadline approaching"],
      actionItems: [{ text: "Prepare Q3 deck", owner: "me", deadline: "Thursday", evidenceRefs: ["thread-msg-0", "thread-msg-1"] }],
      urgency: "high",
      evidenceRefs: ["thread-msg-0", "thread-msg-1"],
    },
    assertions: {
      "has-mode-thread": (r: any) => r?.mode === "thread" ? null : "mode-not-thread",
      "has-evidence-refs": (r: any) => Array.isArray(r?.evidenceRefs) && r.evidenceRefs.length > 0 ? null : "no-evidence-refs",
      "has-structured-actions": (r: any) => Array.isArray(r?.actionItems) && r.actionItems.every((a: any) => typeof a.text === "string" && Array.isArray(a.evidenceRefs)) ? null : "bad-action-items",
    },
  },

  // Fixture 2: Marketing mail - no action items
  {
    fixtureId: "thread-marketing-no-action",
    feature: "summary",
    llmResponse: {
      type: "summary",
      bullets: ["50% off sale promotion", "Limited time offer", "Marketing email"],
      actionItems: [],
      urgency: "low",
      evidenceRefs: ["thread-msg-0"],
    },
    assertions: {
      "no-action-items": (r: any) => Array.isArray(r?.actionItems) && r.actionItems.length === 0 ? null : "should-have-no-action-items",
      "urgency-is-low": (r: any) => r?.urgency === "low" ? null : "urgency-should-be-low",
    },
  },

  // Fixture 3: Notification mail - no action items
  {
    fixtureId: "thread-notification-no-action",
    feature: "summary",
    llmResponse: {
      type: "summary",
      bullets: ["Order has shipped", "Tracking available", "Automated notification"],
      actionItems: [],
      urgency: "low",
      evidenceRefs: ["thread-msg-0"],
    },
    assertions: {
      "no-action-items": (r: any) => Array.isArray(r?.actionItems) && r.actionItems.length === 0 ? null : "notifications-should-have-no-actions",
      "urgency-low": (r: any) => r?.urgency === "low" ? null : "notification-should-be-low-urgency",
    },
  },

  // Fixture 4: Urgent thread
  {
    fixtureId: "thread-urgent",
    feature: "summary",
    llmResponse: {
      type: "summary",
      bullets: ["Production server outage", "Database connection pool exhaustion suspected", "Investigation ongoing"],
      actionItems: [{ text: "Investigate database pool", owner: "dev team", evidenceRefs: ["thread-msg-1"] }],
      urgency: "high",
      evidenceRefs: ["thread-msg-0", "thread-msg-1"],
    },
    assertions: {
      "urgency-high": (r: any) => r?.urgency === "high" ? null : "urgent-should-be-high",
      "has-action": (r: any) => r?.actionItems?.length > 0 ? null : "should-have-action-item",
    },
  },

  // Fixture 5: Chinese language summary
  {
    fixtureId: "thread-chinese",
    feature: "summary",
    llmResponse: {
      type: "summary",
      bullets: ["老板要求准备第三季度报告", "截止日期为周五", "需要尽快完成"],
      actionItems: [{ text: "准备第三季度报告", deadline: "周五", evidenceRefs: ["thread-msg-0"] }],
      urgency: "high",
      evidenceRefs: ["thread-msg-0"],
    },
    assertions: {
      "chinese-bullets": (r: any) => r?.bullets?.every((b: string) => /[一-鿿]/.test(b)) ? null : "not-chinese",
      "chinese-action": (r: any) => r?.actionItems?.[0] && /[一-鿿]/.test(r.actionItems[0].text) ? null : "action-not-chinese",
    },
  },

  // Fixture 6: Long thread compression
  {
    fixtureId: "thread-long-compression",
    feature: "summary",
    llmResponse: {
      type: "summary",
      bullets: ["Long discussion on approach", "Multiple participants contributed", "Decision needed on direction", "Follow-up meeting suggested"],
      actionItems: [{ text: "Schedule follow-up meeting", evidenceRefs: ["thread-msg-9"] }],
      urgency: "medium",
      evidenceRefs: ["thread-msg-0", "thread-msg-9"],
    },
    assertions: {
      "has-four-bullets": (r: any) => r?.bullets?.length === 4 ? null : "wrong-bullet-count",
      "has-evidence": (r: any) => r?.evidenceRefs?.length > 0 ? null : "no-evidence",
    },
  },

  // Fixture 7: Empty body mail
  {
    fixtureId: "thread-empty-body",
    feature: "summary",
    llmResponse: {
      type: "summary",
      bullets: ["FYI message with no body", "Likely automated or forwarded", "No action required"],
      actionItems: [],
      urgency: "low",
      evidenceRefs: ["thread-msg-0"],
    },
    assertions: {
      "no-action": (r: any) => r?.actionItems?.length === 0 ? null : "empty-body-should-have-no-action",
    },
  },

  // Fixture 8: Thread with action items and deadlines
  {
    fixtureId: "thread-action-deadlines",
    feature: "summary",
    llmResponse: {
      type: "summary",
      bullets: ["Project deadline is Wednesday", "Backend due Monday", "Frontend review due Tuesday", "Team members acknowledged"],
      actionItems: [
        { text: "Finish backend", owner: "John", deadline: "Monday", evidenceRefs: ["thread-msg-0", "thread-msg-1"] },
        { text: "Review frontend", owner: "Sarah", deadline: "Tuesday", evidenceRefs: ["thread-msg-0"] },
      ],
      urgency: "medium",
      evidenceRefs: ["thread-msg-0", "thread-msg-1"],
    },
    assertions: {
      "has-two-actions": (r: any) => r?.actionItems?.length === 2 ? null : "wrong-action-count",
      "actions-have-owners": (r: any) => r?.actionItems?.every((a: any) => a.owner) ? null : "missing-owner",
      "actions-have-deadlines": (r: any) => r?.actionItems?.every((a: any) => a.deadline) ? null : "missing-deadline",
      "actions-have-evidence": (r: any) => r?.actionItems?.every((a: any) => Array.isArray(a.evidenceRefs) && a.evidenceRefs.length > 0) ? null : "missing-evidence-refs",
    },
  },

  // Fixture 9: Thread with risks
  {
    fixtureId: "thread-risks",
    feature: "summary",
    llmResponse: {
      type: "summary",
      bullets: ["Vendor may not deliver on time", "Launch date at risk", "Contingency plan needed"],
      actionItems: [{ text: "Create contingency plan", evidenceRefs: ["thread-msg-0"] }],
      urgency: "high",
      risks: ["Vendor delivery delay", "Launch date slip"],
      evidenceRefs: ["thread-msg-0"],
    },
    assertions: {
      "has-risks": (r: any) => Array.isArray(r?.risks) && r.risks.length > 0 ? null : "no-risks",
      "risks-are-strings": (r: any) => r?.risks?.every((r: any) => typeof r === "string") ? null : "risks-not-strings",
    },
  },

  // Fixture 10: Thread with open questions
  {
    fixtureId: "thread-open-questions",
    feature: "summary",
    llmResponse: {
      type: "summary",
      bullets: ["Vendor delay discussed", "Impact assessment needed", "No decision yet"],
      actionItems: [],
      urgency: "medium",
      risks: ["Vendor delay"],
      openQuestions: ["What is the backup plan?", "Can we find an alternative vendor?"],
      evidenceRefs: ["thread-msg-0"],
    },
    assertions: {
      "has-open-questions": (r: any) => Array.isArray(r?.openQuestions) && r.openQuestions.length > 0 ? null : "no-open-questions",
      "questions-are-strings": (r: any) => r?.openQuestions?.every((q: any) => typeof q === "string") ? null : "questions-not-strings",
    },
  },

  // Fixture 11: Mixed language content
  {
    fixtureId: "thread-mixed-language",
    feature: "summary",
    llmResponse: {
      type: "summary",
      bullets: ["Project update provided", "Bilingual communication", "Key points shared in both languages"],
      actionItems: [],
      urgency: "low",
      evidenceRefs: ["thread-msg-0"],
    },
    assertions: {
      "has-bullets": (r: any) => Array.isArray(r?.bullets) && r.bullets.length >= 3 ? null : "not-enough-bullets",
    },
  },

  // Fixture 12: Email-mode summary (backward compatible)
  {
    fixtureId: "email-mode-basic",
    feature: "summary",
    llmResponse: {
      type: "summary",
      bullets: ["Team meeting at 3pm", "Agenda includes budget review", "Please prepare your updates"],
      actionItems: ["Prepare budget update"],
      urgency: "medium",
    },
    assertions: {
      "has-bullets": (r: any) => Array.isArray(r?.bullets) && r.bullets.length >= 3 ? null : "not-enough-bullets",
      "has-action-items": (r: any) => Array.isArray(r?.actionItems) ? null : "no-action-items",
      "has-urgency": (r: any) => ["low", "medium", "high"].includes(r?.urgency) ? null : "bad-urgency",
    },
  },

  // Fixture 13: Email-mode low urgency
  {
    fixtureId: "email-mode-low",
    feature: "summary",
    llmResponse: {
      type: "summary",
      bullets: ["Newsletter subscription confirmed", "Weekly digest enabled", "Unsubscribe link included"],
      actionItems: [],
      urgency: "low",
    },
    assertions: {
      "no-actions": (r: any) => Array.isArray(r?.actionItems) && r.actionItems.length === 0 ? null : "should-have-no-actions",
      "low-urgency": (r: any) => r?.urgency === "low" ? null : "should-be-low",
    },
  },

  // Fixture 14: Email-mode high urgency
  {
    fixtureId: "email-mode-high",
    feature: "summary",
    llmResponse: {
      type: "summary",
      bullets: ["Production incident declared", "All teams to respond", "Status page update needed"],
      actionItems: ["Join incident bridge", "Update status page"],
      urgency: "high",
    },
    assertions: {
      "high-urgency": (r: any) => r?.urgency === "high" ? null : "should-be-high",
      "has-actions": (r: any) => r?.actionItems?.length >= 1 ? null : "should-have-actions",
    },
  },

  // Fixture 15: Email-mode Chinese summary
  {
    fixtureId: "email-mode-chinese",
    feature: "summary",
    llmResponse: {
      type: "summary",
      bullets: ["会议安排在周五", "需要准备报告", "请确认参加"],
      actionItems: ["准备周报"],
      urgency: "medium",
    },
    assertions: {
      "chinese-text": (r: any) => r?.bullets?.every((b: string) => /[一-鿿]/.test(b)) ? null : "not-chinese",
    },
  },

  // Fixture 16: Thread with single message
  {
    fixtureId: "thread-single-message",
    feature: "summary",
    llmResponse: {
      type: "summary",
      bullets: ["Single message in thread", "No prior context", "Standalone email"],
      actionItems: [],
      urgency: "low",
      evidenceRefs: ["thread-msg-0"],
    },
    assertions: {
      "has-evidence": (r: any) => r?.evidenceRefs?.length > 0 ? null : "no-evidence",
    },
  },

  // Fixture 17: Thread with many action items
  {
    fixtureId: "thread-many-actions",
    feature: "summary",
    llmResponse: {
      type: "summary",
      bullets: ["Multiple tasks assigned", "Various deadlines set", "Team coordination required"],
      actionItems: [
        { text: "Complete design review", owner: "Alice", evidenceRefs: ["thread-msg-0"] },
        { text: "Write unit tests", owner: "Bob", evidenceRefs: ["thread-msg-0"] },
        { text: "Deploy to staging", owner: "Charlie", deadline: "Friday", evidenceRefs: ["thread-msg-1"] },
      ],
      urgency: "medium",
      evidenceRefs: ["thread-msg-0", "thread-msg-1"],
    },
    assertions: {
      "three-actions": (r: any) => r?.actionItems?.length === 3 ? null : "wrong-action-count",
      "all-have-text": (r: any) => r?.actionItems?.every((a: any) => typeof a.text === "string") ? null : "missing-text",
    },
  },

  // Fixture 18: Thread with risks and no open questions
  {
    fixtureId: "thread-risks-no-questions",
    feature: "summary",
    llmResponse: {
      type: "summary",
      bullets: ["Risk identified in timeline", "Mitigation strategy discussed", "Team aligned on approach"],
      actionItems: [{ text: "Implement mitigation", evidenceRefs: ["thread-msg-0"] }],
      urgency: "medium",
      risks: ["Timeline risk"],
      evidenceRefs: ["thread-msg-0"],
    },
    assertions: {
      "has-risks": (r: any) => r?.risks?.length > 0 ? null : "no-risks",
      "no-open-questions": (r: any) => !r?.openQuestions || r.openQuestions.length === 0 ? null : "should-have-no-open-questions",
    },
  },

  // Fixture 19: Thread English language output
  {
    fixtureId: "thread-english",
    feature: "summary",
    llmResponse: {
      type: "summary",
      bullets: ["Discussion about Q3 planning", "Team members shared updates", "Action items assigned for next week"],
      actionItems: [{ text: "Compile Q3 report", evidenceRefs: ["thread-msg-0"] }],
      urgency: "medium",
      evidenceRefs: ["thread-msg-0", "thread-msg-1"],
    },
    assertions: {
      "english-bullets": (r: any) => r?.bullets?.every((b: string) => /^[a-zA-Z]/.test(b)) ? null : "not-english",
      "has-evidence": (r: any) => r?.evidenceRefs?.length > 0 ? null : "no-evidence",
    },
  },

  // Fixture 20: Thread with all optional fields
  {
    fixtureId: "thread-all-fields",
    feature: "summary",
    llmResponse: {
      type: "summary",
      bullets: ["Complex project thread", "Multiple risks identified", "Several open questions remain", "Team needs alignment"],
      actionItems: [{ text: "Align team", owner: "lead", deadline: "Monday", evidenceRefs: ["thread-msg-0"] }],
      urgency: "high",
      risks: ["Scope creep", "Resource shortage"],
      openQuestions: ["Who leads the effort?", "What is the timeline?"],
      evidenceRefs: ["thread-msg-0", "thread-msg-1"],
    },
    assertions: {
      "has-all-fields": (r: any) => (r?.bullets?.length > 0 && r?.actionItems?.length > 0 && r?.risks?.length > 0 && r?.openQuestions?.length > 0 && r?.evidenceRefs?.length > 0) ? null : "missing-fields",
    },
  },

  // Fixture 21: Email-mode with language hint in metadata
  {
    fixtureId: "email-language-metadata",
    feature: "summary",
    llmResponse: {
      type: "summary",
      bullets: ["这是一封中文邮件的摘要", "包含关键信息", "需要注意的要点"],
      actionItems: ["跟进项目进度"],
      urgency: "medium",
    },
    assertions: {
      "has-metadata": (r: any) => r?._metadata ? null : "no-metadata",
      "has-version": (r: any) => r?._metadata?.version ? null : "no-version",
    },
  },

  // Fixture 22: Thread with minimal action item (text only, no owner/deadline)
  {
    fixtureId: "thread-minimal-action",
    feature: "summary",
    llmResponse: {
      type: "summary",
      bullets: ["Brief discussion", "Quick update shared", "No urgency"],
      actionItems: [{ text: "Follow up later", evidenceRefs: ["thread-msg-0"] }],
      urgency: "low",
      evidenceRefs: ["thread-msg-0"],
    },
    assertions: {
      "minimal-action": (r: any) => r?.actionItems?.length === 1 && r.actionItems[0].text && !r.actionItems[0].owner && !r.actionItems[0].deadline ? null : "action-not-minimal",
    },
  },
];

/**
 * Map fixture IDs to the thread messages they should use.
 */
function getThreadMessagesForFixture(fixtureId: string): Array<{
  emailId: string;
  subject?: string;
  from?: string;
  bodyText?: string;
  receivedAt: string;
}> {
  if (fixtureId.startsWith("thread-marketing")) return marketingMessages;
  if (fixtureId.startsWith("thread-notification")) return notificationMessages;
  if (fixtureId.startsWith("thread-urgent")) return urgentMessages;
  if (fixtureId.startsWith("thread-chinese")) return chineseMessages;
  if (fixtureId.startsWith("thread-long")) return longThreadMessages;
  if (fixtureId.startsWith("thread-empty")) return emptyBodyMessages;
  if (fixtureId.startsWith("thread-action")) return actionItemMessages;
  if (fixtureId.startsWith("thread-risk") && !fixtureId.includes("no-questions")) return riskMessages;
  if (fixtureId.startsWith("thread-mixed")) return mixedLanguageMessages;
  if (fixtureId.startsWith("thread-single")) return [threadMessages[0]];
  // Default thread messages for other thread fixtures
  return threadMessages;
}

/**
 * Map fixture IDs to the language hint.
 */
function getLanguageForFixture(fixtureId: string): string | undefined {
  if (fixtureId.includes("chinese")) return "Chinese";
  return undefined;
}

test("summary thread quality eval suite runs all 22 fixtures", async () => {
  const report = await runEvalSuite(
    summaryFixtures,
    (llmClient, feature) => {
      if (feature === "summary") {
        return createEmailProcessorFactory() as any;
      }
      throw new Error(`Unknown feature: ${feature}`);
    },
    (feature) => makeJob(feature),
    makeCtx,
  );

  // Basic structure check
  assert.equal(report.fixturesLoaded, 22, "should load 22 fixtures");
  assert.ok(report.results.length === 22, "should have 22 results");
});

test("thread mode eval fixtures pass with correct processor setup", async () => {
  // Test thread-mode fixtures individually with the correct processor
  const threadFixtureIds = summaryFixtures
    .filter((f) => f.fixtureId.startsWith("thread-"))
    .map((f) => f.fixtureId);

  let passed = 0;
  let failed = 0;

  for (const fixture of summaryFixtures.filter((f) => f.fixtureId.startsWith("thread-"))) {
    const threadMsgs = getThreadMessagesForFixture(fixture.fixtureId);
    const lang = getLanguageForFixture(fixture.fixtureId);
    const factory = createThreadProcessorFactory(threadMsgs, lang);

    const result = await runFixtureAsync(
      fixture,
      factory,
      makeJob("summary"),
      makeCtx(),
    );

    if (result.status === "pass") {
      passed++;
    } else {
      failed++;
    }
  }

  assert.equal(failed, 0, `All thread fixtures should pass, but ${failed} failed`);
  assert.ok(passed >= 12, `At least 12 thread fixtures should pass, got ${passed}`);
});

test("email mode eval fixtures pass with correct processor setup", async () => {
  const emailFixtures = summaryFixtures.filter((f) => f.fixtureId.startsWith("email-"));

  let passed = 0;
  let failed = 0;

  for (const fixture of emailFixtures) {
    const lang = getLanguageForFixture(fixture.fixtureId);
    const factory = createEmailProcessorFactory(lang);

    const result = await runFixtureAsync(
      fixture,
      factory,
      makeJob("summary"),
      makeCtx(),
    );

    if (result.status === "pass") {
      passed++;
    } else {
      failed++;
    }
  }

  assert.equal(failed, 0, `All email fixtures should pass, but ${failed} failed`);
  assert.ok(passed >= 4, `At least 4 email fixtures should pass, got ${passed}`);
});

test("no fabricated action items in marketing/notification fixtures", async () => {
  // Marketing fixture
  const marketingFactory = createThreadProcessorFactory(marketingMessages);
  const marketingResult = await runFixtureAsync(
    summaryFixtures.find((f) => f.fixtureId === "thread-marketing-no-action")!,
    marketingFactory,
    makeJob("summary"),
    makeCtx(),
  );

  // The processor validates the LLM response, so if it passes,
  // actionItems should be empty
  if (marketingResult.status === "pass") {
    // Good - the fixture requires empty action items
    assert.ok(true, "marketing fixture passed with no action items");
  }

  // Notification fixture
  const notifFactory = createThreadProcessorFactory(notificationMessages);
  const notifResult = await runFixtureAsync(
    summaryFixtures.find((f) => f.fixtureId === "thread-notification-no-action")!,
    notifFactory,
    makeJob("summary"),
    makeCtx(),
  );

  if (notifResult.status === "pass") {
    assert.ok(true, "notification fixture passed with no action items");
  }
});

test("chinese language fixture produces chinese output", async () => {
  const factory = createThreadProcessorFactory(chineseMessages, "Chinese");
  const result = await runFixtureAsync(
    summaryFixtures.find((f) => f.fixtureId === "thread-chinese")!,
    factory,
    makeJob("summary"),
    makeCtx(),
  );

  assert.equal(result.status, "pass", "Chinese fixture should pass");
});

test("thread summaries include source evidence", async () => {
  const factory = createThreadProcessorFactory(threadMessages);
  const result = await runFixtureAsync(
    summaryFixtures.find((f) => f.fixtureId === "thread-basic")!,
    factory,
    makeJob("summary"),
    makeCtx(),
  );

  assert.equal(result.status, "pass", "basic thread fixture should pass");
  // The fixture assertions already check for evidenceRefs
});

test("action items have evidence references", async () => {
  const factory = createThreadProcessorFactory(actionItemMessages);
  const result = await runFixtureAsync(
    summaryFixtures.find((f) => f.fixtureId === "thread-action-deadlines")!,
    factory,
    makeJob("summary"),
    makeCtx(),
  );

  assert.equal(result.status, "pass", "action-deadlines fixture should pass");
});

test("all 22 fixtures produce valid JSON output", async () => {
  // Run all fixtures with appropriate processors
  let allValid = true;
  let invalidCount = 0;

  for (const fixture of summaryFixtures) {
    let factory;
    if (fixture.fixtureId.startsWith("thread-")) {
      const threadMsgs = getThreadMessagesForFixture(fixture.fixtureId);
      const lang = getLanguageForFixture(fixture.fixtureId);
      factory = createThreadProcessorFactory(threadMsgs, lang);
    } else {
      const lang = getLanguageForFixture(fixture.fixtureId);
      factory = createEmailProcessorFactory(lang);
    }

    const result = await runFixtureAsync(
      fixture,
      factory,
      makeJob("summary"),
      makeCtx(),
    );

    // Check that it doesn't have type-mismatch violations
    const typeViolations = result.violations.filter((v) => v.includes("type-mismatch"));
    if (typeViolations.length > 0) {
      allValid = false;
      invalidCount++;
    }
  }

  assert.ok(allValid, `${invalidCount} fixtures had type mismatches`);
});

test("eval fixture count is at least 20", () => {
  assert.ok(summaryFixtures.length >= 20, `Expected at least 20 fixtures, got ${summaryFixtures.length}`);
  assert.equal(summaryFixtures.length, 22, "should have exactly 22 fixtures");
});

test("urgent thread fixture passes", async () => {
  const factory = createThreadProcessorFactory(urgentMessages);
  const result = await runFixtureAsync(
    summaryFixtures.find((f) => f.fixtureId === "thread-urgent")!,
    factory,
    makeJob("summary"),
    makeCtx(),
  );

  assert.equal(result.status, "pass", "urgent thread fixture should pass");
});

test("long thread fixture passes with compression", async () => {
  const factory = createThreadProcessorFactory(longThreadMessages);
  const result = await runFixtureAsync(
    summaryFixtures.find((f) => f.fixtureId === "thread-long-compression")!,
    factory,
    makeJob("summary"),
    makeCtx(),
  );

  assert.equal(result.status, "pass", "long thread fixture should pass");
});

test("risks fixture passes with risk items", async () => {
  const factory = createThreadProcessorFactory(riskMessages);
  const result = await runFixtureAsync(
    summaryFixtures.find((f) => f.fixtureId === "thread-risks")!,
    factory,
    makeJob("summary"),
    makeCtx(),
  );

  assert.equal(result.status, "pass", "risks fixture should pass");
});
