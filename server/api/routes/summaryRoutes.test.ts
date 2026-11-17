import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import type { IntelligenceAttributeKind } from "../../../shared/wemail/intelligence.js";
import type {
  IntelligenceResultRepository,
  SummaryHealthScope,
  SummaryRetryCandidate,
} from "../../wemail/intelligence/IntelligenceResultRepository.js";
import type { MailDatabaseClient } from "../../wemail/database/MailDatabaseClient.js";
import { buildSummaryRoutes } from "./summaryRoutes.js";

type RequestIntelligenceInput = Parameters<
  MailDatabaseClient["requestIntelligence"]
>[0];

function makeApp(overrides: {
  candidates?: SummaryRetryCandidate[];
  requestIntelligence?: (input: RequestIntelligenceInput) => Promise<unknown>;
} = {}) {
  const calls: {
    healthInputs: SummaryHealthScope[];
    candidatesInputs: Array<SummaryHealthScope & { kinds?: IntelligenceAttributeKind[] }>;
    requestIntelligenceInputs: RequestIntelligenceInput[];
  } = {
    healthInputs: [],
    candidatesInputs: [],
    requestIntelligenceInputs: [],
  };

  const results = {
    getSummaryHealth(input: SummaryHealthScope) {
      calls.healthInputs.push(input);
      return {
        total: 0,
        succeeded: 0,
        failed: 0,
        missing: 0,
        invalid: 0,
        pending: 0,
        running: 0,
        skipped: 0,
        retryable: 0,
        items: [],
      };
    },
    listSummaryRetryCandidates(input: SummaryHealthScope) {
      calls.candidatesInputs.push(input);
      return overrides.candidates ?? [];
    },
  } as unknown as IntelligenceResultRepository;

  const mailDatabase = {
    requestIntelligence: overrides.requestIntelligence ??
      (async (input: RequestIntelligenceInput) => {
        calls.requestIntelligenceInputs.push(input);
        return { value: { jobIds: [] }, changes: [], commitVersion: 1 };
      }),
  } as Pick<MailDatabaseClient, "requestIntelligence">;

  const app = buildSummaryRoutes({
    results,
    mailDatabase,
    getActiveAccountId: () => "acct-1",
  });

  return { app, calls };
}

test("summary-retry routes manual retries through the canonical intelligence pipeline", async () => {
  const { app, calls } = makeApp({
    candidates: [
      { emailId: "email-1", accountId: "acct-1", state: "failed" },
      { emailId: "email-2", accountId: "acct-1", state: "missing" },
    ],
  });

  const response = await app.request("/summary-retry", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "all" }),
  });
  assert.equal(response.status, 200);
  const body = await response.json() as {
    ok: boolean;
    result: { queued: number; inserted: number; reset: number; skipped?: number };
  };
  assert.equal(body.ok, true);
  assert.equal(body.result.queued, 2);
  assert.equal(body.result.skipped, 0);

  assert.deepEqual(calls.requestIntelligenceInputs, [
    { emailId: "email-1", kinds: ["summary"], revive: true },
    { emailId: "email-2", kinds: ["summary"], revive: true },
  ]);
});

test("summary-retry routes per-attribute kinds through the pipeline", async () => {
  const { app, calls } = makeApp({
    candidates: [
      { emailId: "email-1", accountId: "acct-1", state: "missing" },
    ],
  });

  const response = await app.request("/summary-retry", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kinds: ["tags", "todoExtraction"] }),
  });
  assert.equal(response.status, 200);
  const body = await response.json() as { result: { queued: number } };
  assert.equal(body.result.queued, 1);
  // Internal attribute names reach the candidate filter…
  assert.deepEqual(calls.candidatesInputs[0]?.kinds, ["tags", "todoExtraction"]);
  // …and protocol kind names (todo) are used for the actual enqueue.
  assert.deepEqual(calls.requestIntelligenceInputs[0]?.kinds, ["tags", "todo"]);
});

test("summary-retry reports candidates that failed to enqueue as skipped", async () => {
  const { app } = makeApp({
    candidates: [
      { emailId: "email-1", accountId: "acct-1", state: "failed" },
    ],
    requestIntelligence: async () => {
      throw new Error("message-not-found:email-1");
    },
  });

  const response = await app.request("/summary-retry", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ emailIds: ["email-1"] }),
  });
  assert.equal(response.status, 200);
  const body = await response.json() as {
    ok: boolean;
    result: { queued: number; skipped?: number };
  };
  assert.equal(body.result.queued, 0);
  assert.equal(body.result.skipped, 1);
});

test("summary-health forwards state and folder filters", async () => {
  const { app, calls } = makeApp();

	const response = await app.request(
		"/summary-health?state=failed,missing&folder=INBOX&q=%E5%8F%91%E7%A5%A8&limit=20&offset=40&pageOnly=true",
  );
  assert.equal(response.status, 200);
  const body = await response.json() as { ok: boolean };
  assert.equal(body.ok, true);

  assert.deepEqual(calls.healthInputs[0]?.states, ["failed", "missing"]);
  assert.equal(calls.healthInputs[0]?.folder, "INBOX");
	assert.equal(calls.healthInputs[0]?.query, "发票");
	assert.equal(calls.healthInputs[0]?.limit, 20);
	assert.equal(calls.healthInputs[0]?.offset, 40);
	assert.equal(calls.healthInputs[0]?.pageOnly, true);
});

test("summary-retry requires an active account", async () => {
  const app = buildSummaryRoutes({
    results: {} as IntelligenceResultRepository,
    mailDatabase: {
      requestIntelligence: async () => ({ value: { jobIds: [] }, changes: [], commitVersion: 1 }),
    },
    getActiveAccountId: () => undefined,
  });

  const response = await app.request("/summary-retry", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(response.status, 401);
  const body = await response.json() as { code: string };
  assert.equal(body.code, "NO_ACTIVE_ACCOUNT");
});
