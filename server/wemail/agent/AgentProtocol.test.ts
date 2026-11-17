import assert from "node:assert/strict";
import test from "node:test";
import {
  isWemailAgentEvent,
  WEMAIL_AGENT_EVENT_SCHEMA_VERSION,
  type PersistedAgentAttachmentReference,
  type PersistedAgentBehaviorEvent,
  type PersistedAgentFollowup,
  type PersistedAgentMessage,
  type PersistedAgentPreference,
  type PersistedAgentRun,
  type PersistedAgentToolExecution,
} from "../../../shared/wemail/agentProtocol.js";
import { agentProtocolFixtures } from "./testing/AgentProtocolFixtures.js";

test("all AgentEvent v1 protocol fixtures are valid and ordered", () => {
  for (const [name, events] of Object.entries(agentProtocolFixtures)) {
    assert.ok(events.length > 0, `${name} fixture must contain events`);
    events.forEach((event, index) => {
      assert.equal(event.schemaVersion, WEMAIL_AGENT_EVENT_SCHEMA_VERSION);
      assert.equal(event.sequence, index, `${name} sequence must be monotonic`);
      assert.equal(isWemailAgentEvent(event), true, `${name}:${event.type} must be valid`);
    });
  }
});

test("AgentEvent v1 rejects invalid base metadata and unknown event types", () => {
  assert.equal(isWemailAgentEvent(null), false);
  assert.equal(
    isWemailAgentEvent({
      schemaVersion: 1,
      conversationId: "conv",
      runId: "run",
      sequence: -1,
      timestamp: "2026-07-14T12:00:00.000Z",
      type: "run_started",
    }),
    false,
  );
  assert.equal(
    isWemailAgentEvent({
      schemaVersion: 1,
      conversationId: "conv",
      runId: "run",
      sequence: 0,
      timestamp: "2026-07-14T12:00:00.000Z",
      type: "pi_internal_event",
    }),
    false,
  );
  assert.equal(
    isWemailAgentEvent({
      schemaVersion: 1,
      conversationId: "conv",
      runId: "run",
      sequence: 0,
      timestamp: "2026-07-14T12:00:00.000Z",
      type: "tool_call_started",
    }),
    false,
    "known event types must still provide their required payload",
  );
});

test("AgentEvent v1 accepts user-visible progress as a distinct protocol event", () => {
  assert.equal(
    isWemailAgentEvent({
      schemaVersion: 1,
      conversationId: "conv",
      runId: "run",
      messageId: "message",
      sequence: 0,
      timestamp: "2026-07-14T12:00:00.000Z",
      type: "progress_added",
      partId: "progress-1",
      text: "我先确认统计范围。",
    }),
    true,
  );
});

test("persisted Agent contracts remain JSON-safe and structurally independent", () => {
  const message: PersistedAgentMessage = {
    id: "msg-1",
    conversationId: "conv-1",
    runId: "run-1",
    role: "assistant",
    parts: [
      {
        id: "text-1",
        type: "text",
        markdown: "**Done**",
        state: "completed",
        citationIds: ["citation-1"],
      },
    ],
    attachmentIds: [],
    createdAt: "2026-07-14T12:00:00.000Z",
    updatedAt: "2026-07-14T12:00:01.000Z",
  };
  const run: PersistedAgentRun = {
    id: "run-1",
    conversationId: "conv-1",
    state: "settled",
    lastSequence: 6,
  };
  const tool: PersistedAgentToolExecution = {
    toolCallId: "tool-1",
    runId: "run-1",
    toolName: "search_mail",
    state: "completed",
    output: { count: 1 },
  };
  const followup: PersistedAgentFollowup = {
    id: "followup-1",
    conversationId: "conv-1",
    text: "Next",
    attachmentIds: [],
    position: 0,
    state: "queued",
    createdAt: "2026-07-14T12:00:00.000Z",
    updatedAt: "2026-07-14T12:00:00.000Z",
  };
  const attachmentRef: PersistedAgentAttachmentReference = {
    attachmentId: "attachment-1",
    messageId: "msg-1",
    position: 0,
  };
  const behavior: PersistedAgentBehaviorEvent = {
    id: "behavior-1",
    accountId: "account-1",
    type: "user_input",
    payload: { text: "Summarize this mail" },
    createdAt: "2026-07-14T12:00:00.000Z",
  };
  const preference: PersistedAgentPreference = {
    id: "preference-1",
    accountId: "account-1",
    key: "reply_tone",
    value: "concise",
    provenanceEventIds: ["behavior-1"],
    confidence: 0.8,
    lastConfirmedAt: "2026-07-14T12:00:00.000Z",
    updatedAt: "2026-07-14T12:00:00.000Z",
  };

  assert.doesNotThrow(() =>
    JSON.stringify({ message, run, tool, followup, attachmentRef, behavior, preference }),
  );
});
