import assert from "node:assert/strict";
import { test } from "node:test";
import {
  COMPOSE_DRAFT_SYSTEM_PROMPT,
  buildComposeDraftUserMessage,
} from "./composeDraftPrompt.js";

const parityScenarios = [
  {
    name: "formal receipt reply",
    input: {
      operationType: "REPLY" as const,
      intent: "回复“已收到”，语气稍微正式一点。",
      original: {
        subject: "项目资料",
        from: { email: "sender@example.com", name: "王经理" },
        bodyText: "请确认已经收到附件中的项目资料。",
      },
    },
    expected: [/MODE: REPLY/, /王经理/, /请确认已经收到附件/],
  },
  {
    name: "meeting commitment reply",
    input: {
      operationType: "REPLY" as const,
      intent: "确认会参加会议，并说明会提前准备材料。",
      original: {
        subject: "周五项目会",
        from: { email: "lead@example.com", name: "项目负责人" },
        bodyText: "周五下午三点开项目会，请确认能否参加。",
      },
    },
    expected: [/周五下午三点/, /提前准备材料/],
  },
  {
    name: "new draft before recipient",
    input: {
      operationType: "NEW" as const,
      intent: "写一封正式邮件，确认下周发布计划。",
    },
    expected: [/MODE: NEW/, /确认下周发布计划/],
  },
  {
    name: "rewrite existing draft",
    input: {
      operationType: "NEW" as const,
      intent: "缩短并正式一些，不改变事实。",
      currentSubject: "发布计划",
      currentBody: "我们准备下周二发布，目前测试已经完成。",
    },
    expected: [/CURRENT DRAFT/, /下周二发布/, /测试已经完成/],
  },
  {
    name: "target language",
    input: {
      operationType: "NEW" as const,
      intent: "确认已经收到资料。",
      targetLanguage: "en",
    },
    expected: [/TARGET LANGUAGE: en/, /确认已经收到资料/],
  },
  {
    name: "explicit one-line reply",
    input: {
      operationType: "REPLY" as const,
      intent: "只写一句话，表达已收到并感谢，不要称呼和落款。",
      original: {
        subject: "资料更新",
        from: { email: "sender@example.com", name: "王经理" },
        bodyText: "请查收本次资料更新。",
      },
    },
    expected: [/只写一句话/, /不要称呼和落款/, /请查收本次资料更新/],
  },
  {
    name: "formal decline without invented reason",
    input: {
      operationType: "REPLY" as const,
      intent: "礼貌拒绝对方的请求，说明目前无法安排，语气正式，不要编造具体原因。",
      original: {
        subject: "合作安排",
        from: { email: "partner@example.com", name: "合作方" },
        bodyText: "请确认近期是否可以安排合作沟通。",
      },
    },
    expected: [/目前无法安排/, /不要编造具体原因/, /近期是否可以安排合作沟通/],
  },
  {
    name: "explicit deadline commitment only",
    input: {
      operationType: "REPLY" as const,
      intent: "回复对方：已收到，我会在本周五下午5点前完成处理。语气正式，不要添加其他承诺。",
      original: {
        subject: "待处理事项",
        from: { email: "owner@example.com", name: "事项负责人" },
        bodyText: "请确认处理时间。",
      },
    },
    expected: [/本周五下午5点前/, /不要添加其他承诺/, /请确认处理时间/],
  },
  {
    name: "request missing deadline without guessing",
    input: {
      operationType: "REPLY" as const,
      intent: "回复对方：已收到，但请对方补充具体的处理截止日期。语气正式，不要假设日期。",
      original: {
        subject: "处理安排",
        from: { email: "requester@example.com", name: "需求方" },
        bodyText: "请尽快处理并反馈。",
      },
    },
    expected: [/补充具体的处理截止日期/, /不要假设日期/, /请尽快处理并反馈/],
  },
];

test("Upstream parity prompts preserve the facts needed for the same draft conclusion", () => {
  for (const scenario of parityScenarios) {
    const message = buildComposeDraftUserMessage(scenario.input);
    for (const pattern of scenario.expected) {
      assert.match(message, pattern, scenario.name);
    }
  }
});

test("compose system prompt forbids invented facts and commitments", () => {
  assert.match(COMPOSE_DRAFT_SYSTEM_PROMPT, /do not invent facts/i);
  assert.match(COMPOSE_DRAFT_SYSTEM_PROMPT, /commitments/i);
});
